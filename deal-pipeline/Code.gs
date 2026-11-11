/**
 * DEAL PIPELINE, PHASE 1
 *
 * Runs the Grok bots every morning through the xAI API and routes what they return.
 *
 *   ~7:00 AM  Deal Radar and Straight Talk find leads        -> Leads tab
 *   next      Deal Desk ranks the new leads                   -> Deal Desk tab, emailed to Cherry
 *             leads scoring at or above the hot score         -> also emailed to Juan
 *   next      each VALUE-ADD lead goes to Add or Split This House -> Add or Split tab, emailed to Thea
 *   always    every result is copied onto that property's row in Property Cards
 *
 * Each bot's instructions live in the Settings tab. A bot whose instruction cell is
 * empty is skipped, so nothing runs (and nothing is spent) until Juan fills them in.
 *
 * The xAI API key lives in Script Properties as XAI_API_KEY, never in this file.
 *
 * Apps Script stops any single run at 6 minutes and a bot call with web search can take
 * a few minutes, so the morning chain is a queue. Each run works through the queue and,
 * if anything is left, schedules itself to continue 30 seconds later.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TZ = 'America/Los_Angeles';
const XAI_URL = 'https://api.x.ai/v1/responses';
const DEFAULT_MODEL = 'grok-4.7';
const XAI_TIMEOUT_SECONDS = 270;          // one bot call may take up to 4.5 minutes
const START_TASK_WITHIN_MS = 60 * 1000;   // only start a bot call in the first minute of a run
const WATCHDOG_MS = 7 * 60 * 1000;        // if a run is killed mid-call, continue after 7 minutes
const NEXT_STEP_MS = 30 * 1000;
const MAX_ATTEMPTS = 2;
const MAX_LEADS_PER_DEAL_DESK = 40;
const KNOWN_ADDRESSES_SENT = 150;
const CELL_LIMIT = 49000;                 // Sheets allows 50,000 characters in a cell
const STALE_RUN_MS = 2 * 60 * 60 * 1000;
const RUN_KEY = 'PIPELINE_RUN';
const WORKER = 'pipelineWorker';
const DAILY = 'startMorningPipeline';

const TAB = {
  LEADS: 'Leads',
  DEAL_DESK: 'Deal Desk',
  ADD_OR_SPLIT: 'Add or Split',
  CARDS: 'Property Cards',
  SETTINGS: 'Settings',
  LOG: 'Run Log',
};

const BOT = {
  DEAL_RADAR: 'Deal Radar',
  STRAIGHT_TALK: 'Straight Talk',
  DEAL_DESK: 'Deal Desk',
  ADD_OR_SPLIT: 'Add or Split This House',
};
const LEAD_BOTS = [BOT.DEAL_RADAR, BOT.STRAIGHT_TALK];

const SETTING = {
  CHERRY: 'Cherry email (Deal Desk list)',
  JUAN: 'Juan email (hot leads)',
  THEA: 'Thea email (Add or Split reports)',
  ALERTS: 'Alerts email (errors)',
  TEST: 'Test email (test runs only)',
  HOT: 'Hot lead score',
};

const HEADERS = {};
HEADERS[TAB.LEADS] = [
  'Lead ID', 'Date Found', 'Found By', 'Address', 'City', 'State', 'ZIP', 'Asking Price',
  'Property Type', 'Beds', 'Baths', 'Sq Ft', 'Lot Sq Ft', 'Seller / Contact', 'Source', 'Link',
  'Notes', 'Status', 'Score', 'Property Key', 'Run ID',
];
HEADERS[TAB.DEAL_DESK] = [
  'Run Date', 'Rank', 'Score', 'Hot', 'Address', 'City', 'Tags', 'Comps', 'Why', 'Next Step',
  'Lead ID', 'Property Key', 'Run ID',
];
HEADERS[TAB.ADD_OR_SPLIT] = [
  'Date', 'Address', 'City', 'Score', 'Recommendation', 'Summary', 'Full Report', 'Lead ID',
  'Property Key', 'Emailed To', 'Run ID',
];
HEADERS[TAB.CARDS] = [
  'Property Key', 'Address', 'City', 'State', 'ZIP', 'First Seen', 'Last Updated', 'Found By',
  'Asking Price', 'Link', 'Score', 'Scored On', 'Hot', 'Tags', 'Comps', 'Deal Desk Notes',
  'Next Step', 'Add or Split Recommendation', 'Add or Split Summary', 'Add or Split Report',
  'Texts', 'Costs', 'Lead IDs',
];
HEADERS[TAB.LOG] = ['Time', 'Run ID', 'Step', 'Result', 'Details', 'Tokens', 'Cost (USD)'];

const LONG_TEXT_COLUMNS = [
  'Notes', 'Comps', 'Why', 'Next Step', 'Summary', 'Full Report', 'Deal Desk Notes',
  'Add or Split Summary', 'Add or Split Report', 'Details', 'Texts', 'Costs',
];
const MERGED_CARD_COLUMNS = ['Found By', 'Lead IDs'];

// ---------------------------------------------------------------------------
// Output formats. The code fixes these so the bots' instructions can change freely.
// ---------------------------------------------------------------------------

function nullable_(type, description) {
  const s = { type: [type, 'null'] };
  if (description) s.description = description;
  return s;
}

const LEAD_FIELDS = {
  address: { type: 'string', description: 'Street address only, for example "123 Main St"' },
  city: { type: 'string' },
  state: nullable_('string'),
  zip: nullable_('string'),
  asking_price: nullable_('number', 'Asking or expected price in US dollars'),
  property_type: nullable_('string'),
  beds: nullable_('number'),
  baths: nullable_('number'),
  sqft: nullable_('number', 'Living area in square feet'),
  lot_sqft: nullable_('number', 'Lot size in square feet'),
  contact: nullable_('string', 'Seller, agent or other contact, and how to reach them'),
  source: nullable_('string', 'Where the lead came from'),
  link: nullable_('string', 'URL of the listing or post'),
  notes: nullable_('string', 'Why this is a lead'),
};

const LEAD_SCHEMA = {
  type: 'object',
  properties: {
    leads: {
      type: 'array',
      items: {
        type: 'object',
        properties: LEAD_FIELDS,
        required: Object.keys(LEAD_FIELDS),
        additionalProperties: false,
      },
    },
  },
  required: ['leads'],
  additionalProperties: false,
};

const DEAL_DESK_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'A few sentences on today\'s list as a whole' },
    ranked: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          lead_id: { type: 'string', description: 'The lead_id exactly as it was given' },
          rank: { type: 'integer', description: '1 is the best lead' },
          score: { type: 'integer', minimum: 1, maximum: 10, description: 'Deal score from 1 to 10' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tags from your instructions, such as VALUE-ADD',
          },
          comps: { type: 'string', description: 'Comparable sales and what they suggest' },
          why: { type: 'string', description: 'Why this lead got this score' },
          next_step: { type: 'string' },
        },
        required: ['lead_id', 'rank', 'score', 'tags', 'comps', 'why', 'next_step'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'ranked'],
  additionalProperties: false,
};

const ADD_OR_SPLIT_SCHEMA = {
  type: 'object',
  properties: {
    recommendation: { type: 'string', description: 'The short verdict' },
    summary: { type: 'string', description: 'Two or three sentences' },
    report: { type: 'string', description: 'The full report as plain text' },
  },
  required: ['recommendation', 'summary', 'report'],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Menu and entry points
// ---------------------------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Deal Pipeline')
    .addItem('Run test (sample data, no API cost)', 'runTestPipeline')
    .addItem('Test xAI connection', 'testXaiConnection')
    .addSeparator()
    .addItem('Run live pipeline now', 'runLivePipelineNow')
    .addItem('Reinstall 7 AM trigger', 'installDailyTrigger')
    .addSeparator()
    .addItem('Remove test rows', 'removeTestRows')
    .addItem('Repair tabs', 'setup')
    .addToUi();
}

/** Run once from the Apps Script editor after pasting the code. Safe to run again. */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('Run setup from Extensions > Apps Script inside the Deal Pipeline sheet.');
  }
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  ss.rename('Deal Pipeline');
  ss.setSpreadsheetTimeZone(TZ);

  [TAB.LEADS, TAB.DEAL_DESK, TAB.ADD_OR_SPLIT, TAB.CARDS, TAB.LOG].forEach(name => {
    ensureTab_(ss, name, HEADERS[name]);
  });
  ensureSettingsTab_(ss);

  const order = [TAB.LEADS, TAB.DEAL_DESK, TAB.ADD_OR_SPLIT, TAB.CARDS, TAB.SETTINGS, TAB.LOG];
  order.forEach((name, i) => {
    ss.setActiveSheet(ss.getSheetByName(name));
    ss.moveActiveSheet(i + 1);
  });
  const blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0) ss.deleteSheet(blank);

  installDailyTrigger();
  ss.setActiveSheet(ss.getSheetByName(TAB.SETTINGS));
  log_('SETUP', 'Setup', 'OK', 'Tabs ready. Daily trigger set for about 7:00 AM Pacific.');
  toast_('Setup done. Fill in the email addresses on the Settings tab.');
}

/** Daily trigger. */
function startMorningPipeline() {
  startPipeline_('LIVE', true);
}

/** Menu: full chain with sample data. No API calls. Every email goes to the test address. */
function runTestPipeline() {
  const id = startPipeline_('TEST', true);
  if (id) toast_('Test run ' + id + ' finished. Check the tabs, the Run Log and the test inbox.');
}

/** Menu: run the real chain now. */
function runLivePipelineNow() {
  const ui = SpreadsheetApp.getUi();
  const answer = ui.alert(
    'Run live pipeline now?',
    'This calls the bots (it costs API credit) and emails Cherry, Juan and Thea for real.',
    ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;
  const id = startPipeline_('LIVE', false);
  if (id) toast_('Live run ' + id + ' started. It continues in the background. Progress shows on the Run Log tab.');
}

/** Menu: one small real call to prove the key, billing and model work. */
function testXaiConnection() {
  const settings = getSettings_();
  const bot = {
    instructions: 'This is a connection test. Set ok to the word OK.',
    model: settings.bots[BOT.DEAL_DESK].model,
    webSearch: false,
  };
  const schema = {
    type: 'object',
    properties: { ok: { type: 'string' } },
    required: ['ok'],
    additionalProperties: false,
  };
  try {
    const r = callXai_('Connection test', bot, 'Connection test', 'connection_test', schema);
    log_('TEST-API', 'xAI connection', 'OK',
      'Model ' + bot.model + ' replied "' + r.data.ok + '"', r.tokens, r.cost);
    toast_('xAI connection works. Model ' + bot.model + ' replied "' + r.data.ok + '".');
  } catch (err) {
    log_('TEST-API', 'xAI connection', 'FAILED', errMsg_(err));
    toast_('xAI connection failed: ' + errMsg_(err));
    throw err;
  }
}

function installDailyTrigger() {
  deleteTriggers_(DAILY);
  ScriptApp.newTrigger(DAILY)
    .timeBased()
    .everyDays(1)
    .atHour(7)
    .nearMinute(0)
    .inTimezone(TZ)
    .create();
  toast_('Daily trigger set for about 7:00 AM Pacific.');
}

/** Menu: delete every row a test run wrote. */
function removeTestRows() {
  [TAB.LEADS, TAB.DEAL_DESK, TAB.ADD_OR_SPLIT].forEach(name => {
    const t = readTable_(name);
    const c = t.col['Run ID'];
    for (let i = t.rows.length - 1; i >= 0; i--) {
      if (String(t.rows[i][c]).indexOf('TEST') === 0) t.sheet.deleteRow(i + 2);
    }
  });
  const cards = readTable_(TAB.CARDS);
  const k = cards.col['Property Key'];
  for (let i = cards.rows.length - 1; i >= 0; i--) {
    if (String(cards.rows[i][k]).indexOf('test ') === 0) cards.sheet.deleteRow(i + 2);
  }
  toast_('Test rows removed.');
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

function startPipeline_(mode, inline) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    log_('', 'Start', 'SKIPPED', 'Another run was starting at the same moment.');
    return null;
  }
  let run;
  try {
    const existing = getRun_();
    if (existing && Date.now() - existing.startedAt < STALE_RUN_MS) {
      log_(existing.id, 'Start', 'SKIPPED', 'Run ' + existing.id + ' is still working.');
      toast_('Run ' + existing.id + ' is still working. Try again when it finishes.');
      return null;
    }
    if (existing) log_(existing.id, 'Start', 'ABANDONED', 'Older run never finished.');

    const now = new Date();
    const test = mode === 'TEST';
    run = {
      id: (test ? 'TEST-' : 'RUN-') + fmt_(now, 'yyyyMMdd-HHmmss') + ('00' + now.getMilliseconds()).slice(-3),
      test: test,
      startedAt: now.getTime(),
      queue: LEAD_BOTS.map(b => ({ type: 'LEAD_BOT', bot: b }))
        .concat([{ type: 'DEAL_DESK' }, { type: 'FINISH' }]),
      stats: {
        leadBotsRan: 0, leadsAdded: 0, duplicates: 0, ranked: 0, hot: 0,
        valueAdd: 0, reports: 0, skipped: [], failed: [], alerted: [],
      },
    };
    saveRun_(run);
    log_(run.id, 'Start', 'OK', test ? 'Test run with sample data' : 'Live run');
  } finally {
    lock.releaseLock();
  }
  if (inline) pipelineWorker();
  else scheduleWorker_(1000);
  return run.id;
}

/** Works through the queue. Called directly, and by one-off triggers when a run continues. */
function pipelineWorker() {
  const began = Date.now();
  deleteTriggers_(WORKER);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    scheduleWorker_(NEXT_STEP_MS);
    return;
  }
  try {
    const run = getRun_();
    if (!run) return;

    while (run.queue.length && Date.now() - began < START_TASK_WITHIN_MS) {
      const task = run.queue[0];
      if ((task.attempts || 0) >= MAX_ATTEMPTS) {
        failTask_(run, task, 'Stopped after ' + MAX_ATTEMPTS + ' tries (the call may have run past the time limit).');
        run.queue.shift();
        saveRun_(run);
        continue;
      }
      task.attempts = (task.attempts || 0) + 1;
      saveRun_(run);
      scheduleWorker_(WATCHDOG_MS);

      try {
        runTask_(run, task);
        run.queue.shift();
      } catch (err) {
        if (err.fatal || task.attempts >= MAX_ATTEMPTS) {
          failTask_(run, task, errMsg_(err));
          run.queue.shift();
        } else {
          log_(run.id, taskLabel_(task), 'RETRY', errMsg_(err));
          saveRun_(run);
          break;
        }
      }
      saveRun_(run);
    }

    deleteTriggers_(WORKER);
    if (run.queue.length) {
      scheduleWorker_(NEXT_STEP_MS);
    } else {
      clearRun_();
    }
  } finally {
    lock.releaseLock();
  }
}

function runTask_(run, task) {
  switch (task.type) {
    case 'LEAD_BOT': return taskLeadBot_(run, task.bot);
    case 'DEAL_DESK': return taskDealDesk_(run);
    case 'ADD_OR_SPLIT': return taskAddOrSplit_(run, task.leadId);
    case 'FINISH': return taskFinish_(run);
    default: throw fatal_('Unknown task ' + task.type);
  }
}

function taskLabel_(task) {
  if (task.type === 'LEAD_BOT') return task.bot;
  if (task.type === 'DEAL_DESK') return BOT.DEAL_DESK;
  if (task.type === 'ADD_OR_SPLIT') return BOT.ADD_OR_SPLIT + ' ' + task.leadId;
  return 'Finish';
}

function failTask_(run, task, message) {
  const label = taskLabel_(task);
  run.stats.failed.push(label);
  log_(run.id, label, 'FAILED', message);
  alert_(run, label + ' failed', message);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function taskLeadBot_(run, botName) {
  const bot = getSettings_().bots[botName];
  if (!run.test && !bot.instructions) {
    run.stats.skipped.push(botName);
    log_(run.id, botName, 'SKIPPED', 'Instruction field is empty.');
    return;
  }
  const known = recentAddresses_(KNOWN_ADDRESSES_SENT);
  const input = [
    'Today is ' + fmt_(new Date(), 'EEEE, MMMM d, yyyy') + ' (Pacific time).',
    'Run your daily lead search now and return every new lead you find.',
    known.length ? 'These properties are already in our pipeline. Skip them:\n' + known.join('\n') : '',
  ].filter(String).join('\n\n');

  const result = callBot_(run, botName, bot, input, 'leads', LEAD_SCHEMA, null);
  const leads = (result.data.leads || []).filter(l => l && String(l.address || '').trim());
  const counts = addLeads_(run, botName, leads);
  run.stats.leadBotsRan++;
  run.stats.leadsAdded += counts.added;
  run.stats.duplicates += counts.duplicates;
  log_(run.id, botName, 'OK',
    leads.length + ' leads returned, ' + counts.added + ' new, ' +
    counts.duplicates + ' already in the pipeline.', result.tokens, result.cost);
}

function taskDealDesk_(run) {
  const settings = getSettings_();
  const bot = settings.bots[BOT.DEAL_DESK];
  const leads = newLeads_(run);

  if (!leads.length) {
    if (run.stats.leadBotsRan > 0) {
      const to = settings.values[SETTING.CHERRY];
      sendMail_(run, to, 'Cherry', 'Deal Desk: no new leads today (' + fmt_(new Date(), 'MMM d') + ')',
        '<p>Deal Radar and Straight Talk ran this morning and found no new leads.</p>' + sheetLink_());
      log_(run.id, BOT.DEAL_DESK, 'OK', 'No new leads to rank. Cherry told.');
    } else {
      log_(run.id, BOT.DEAL_DESK, 'SKIPPED', 'No new leads to rank.');
    }
    return;
  }
  if (!run.test && !bot.instructions) {
    run.stats.skipped.push(BOT.DEAL_DESK);
    log_(run.id, BOT.DEAL_DESK, 'SKIPPED', 'Instruction field is empty.');
    alert_(run, 'Deal Desk instruction field is empty',
      leads.length + ' leads are waiting on the Leads tab. Fill in Deal Desk on the Settings tab.');
    return;
  }

  const batch = leads.slice(0, MAX_LEADS_PER_DEAL_DESK);
  const input = 'Today is ' + fmt_(new Date(), 'EEEE, MMMM d, yyyy') + ' (Pacific time).\n\n' +
    'Rank these ' + batch.length + ' new leads. Use each lead_id exactly as given.\n\n' +
    JSON.stringify(batch.map(leadForBot_), null, 1);
  const result = callBot_(run, BOT.DEAL_DESK, bot, input, 'deal_desk', DEAL_DESK_SCHEMA, batch);

  const byId = {};
  batch.forEach(l => { byId[l['Lead ID']] = l; });
  const seen = {};
  const ranked = (result.data.ranked || [])
    .filter(r => {
      if (!r || !byId[r.lead_id] || seen[r.lead_id]) return false;
      seen[r.lead_id] = true;
      return true;
    })
    .sort((a, b) => (a.rank || 999) - (b.rank || 999) || (b.score || 0) - (a.score || 0));
  if (!ranked.length) throw new Error('Deal Desk returned no rankings for the lead IDs it was given.');

  const hotScore = Number(settings.values[SETTING.HOT]) || 8;
  const now = new Date();
  const leadsTable = readTable_(TAB.LEADS);
  const rows = [];
  const items = [];
  const hot = [];
  const valueAdd = [];

  ranked.forEach((r, i) => {
    const lead = byId[r.lead_id];
    const tags = (r.tags || []).map(t => String(t).trim()).filter(String);
    const isHot = Number(r.score) >= hotScore;
    const item = { r: r, lead: lead, tags: tags, isHot: isHot, rank: i + 1 };
    rows.push({
      'Run Date': now, 'Rank': i + 1, 'Score': r.score, 'Hot': isHot ? 'YES' : '',
      'Address': lead['Address'], 'City': lead['City'], 'Tags': tags.join(', '),
      'Comps': r.comps, 'Why': r.why, 'Next Step': r.next_step,
      'Lead ID': r.lead_id, 'Property Key': lead['Property Key'], 'Run ID': run.id,
    });
    setCells_(leadsTable, lead._row, { 'Status': 'Ranked', 'Score': r.score });
    upsertCard_(lead['Property Key'], {
      'Score': r.score, 'Scored On': now, 'Hot': isHot ? 'YES' : 'NO', 'Tags': tags.join(', '),
      'Comps': r.comps, 'Deal Desk Notes': r.why, 'Next Step': r.next_step,
    });
    items.push(item);
    if (isHot) hot.push(item);
    if (isValueAdd_(tags)) valueAdd.push(item);
  });
  appendObjects_(TAB.DEAL_DESK, rows);

  const day = fmt_(now, 'MMM d');
  sendMail_(run, settings.values[SETTING.CHERRY], 'Cherry',
    'Deal Desk: ' + items.length + ' leads ranked, ' + hot.length + ' hot (' + day + ')',
    dealDeskEmail_(result.data.summary, items, false));
  if (hot.length) {
    sendMail_(run, settings.values[SETTING.JUAN], 'Juan',
      'Hot leads: ' + hot.length + ' scored ' + hotScore + ' or higher (' + day + ')',
      dealDeskEmail_('', hot, true));
  }

  const finish = run.queue.findIndex(t => t.type === 'FINISH');
  const newTasks = valueAdd.map(v => ({ type: 'ADD_OR_SPLIT', leadId: v.r.lead_id }));
  run.queue.splice(finish === -1 ? run.queue.length : finish, 0, ...newTasks);

  const missing = batch.length - ranked.length;
  run.stats.ranked += ranked.length;
  run.stats.hot += hot.length;
  run.stats.valueAdd += valueAdd.length;
  log_(run.id, BOT.DEAL_DESK, 'OK',
    ranked.length + ' ranked, ' + hot.length + ' hot, ' + valueAdd.length + ' VALUE-ADD.' +
    (missing ? ' ' + missing + ' leads were not ranked and stay New for tomorrow.' : '') +
    (leads.length > batch.length ? ' ' + (leads.length - batch.length) + ' more wait for the next run.' : ''),
    result.tokens, result.cost);
}

function taskAddOrSplit_(run, leadId) {
  const settings = getSettings_();
  const bot = settings.bots[BOT.ADD_OR_SPLIT];
  const lead = findLead_(leadId);
  if (!lead) throw fatal_('Lead ' + leadId + ' is not on the Leads tab.');

  if (!run.test && !bot.instructions) {
    if (run.stats.skipped.indexOf(BOT.ADD_OR_SPLIT) === -1) {
      run.stats.skipped.push(BOT.ADD_OR_SPLIT);
      alert_(run, 'Add or Split This House instruction field is empty',
        'VALUE-ADD leads are waiting. Fill in Add or Split This House on the Settings tab.');
    }
    log_(run.id, BOT.ADD_OR_SPLIT, 'SKIPPED', leadId + ': instruction field is empty.');
    return;
  }

  const card = getCard_(lead['Property Key']) || {};
  const payload = leadForBot_(lead);
  payload.deal_desk = {
    score: card['Score'], tags: card['Tags'], comps: card['Comps'], why: card['Deal Desk Notes'],
  };
  const input = 'Deal Desk tagged this property VALUE-ADD. Write your report on it.\n\n' +
    JSON.stringify(payload, null, 1);
  const result = callBot_(run, BOT.ADD_OR_SPLIT, bot, input, 'add_or_split', ADD_OR_SPLIT_SCHEMA, lead);
  const d = result.data;

  const place = place_(lead);
  const to = settings.values[SETTING.THEA];
  const sent = sendMail_(run, to, 'Thea', 'Add or Split: ' + place,
    addOrSplitEmail_(lead, card, d));

  appendObjects_(TAB.ADD_OR_SPLIT, [{
    'Date': new Date(), 'Address': lead['Address'], 'City': lead['City'], 'Score': card['Score'],
    'Recommendation': d.recommendation, 'Summary': d.summary, 'Full Report': d.report,
    'Lead ID': leadId, 'Property Key': lead['Property Key'],
    'Emailed To': sent ? sent : 'NOT SENT', 'Run ID': run.id,
  }]);
  upsertCard_(lead['Property Key'], {
    'Add or Split Recommendation': d.recommendation,
    'Add or Split Summary': d.summary,
    'Add or Split Report': d.report,
  });
  run.stats.reports++;
  log_(run.id, BOT.ADD_OR_SPLIT, 'OK', place + ': ' + d.recommendation, result.tokens, result.cost);
}

function taskFinish_(run) {
  const s = run.stats;
  const parts = [
    s.leadsAdded + ' new leads (' + s.duplicates + ' already known)',
    s.ranked + ' ranked, ' + s.hot + ' hot',
    s.reports + ' Add or Split reports',
  ];
  if (s.skipped.length) parts.push('skipped: ' + s.skipped.join(', '));
  if (s.failed.length) parts.push('failed: ' + s.failed.join(', '));
  const minutes = Math.round((Date.now() - run.startedAt) / 6000) / 10;
  log_(run.id, 'Finish', s.failed.length ? 'DONE WITH ERRORS' : 'DONE',
    parts.join('. ') + '. Took ' + minutes + ' min.');
}

// ---------------------------------------------------------------------------
// xAI
// ---------------------------------------------------------------------------

function callBot_(run, botName, bot, input, schemaName, schema, mockContext) {
  if (run.test) return { data: mockReply_(botName, mockContext), tokens: 0, cost: 0 };
  return callXai_(botName, bot, input, schemaName, schema);
}

function callXai_(botName, bot, input, schemaName, schema) {
  const key = PropertiesService.getScriptProperties().getProperty('XAI_API_KEY');
  if (!key) throw fatal_('XAI_API_KEY is not set. Add it under Project Settings > Script properties.');

  const body = {
    model: bot.model || DEFAULT_MODEL,
    instructions: bot.instructions,
    input: [{ role: 'user', content: input }],
    text: { format: { type: 'json_schema', name: schemaName, schema: schema, strict: true } },
  };
  if (bot.webSearch) body.tools = [{ type: 'web_search' }, { type: 'x_search' }];

  const res = UrlFetchApp.fetch(XAI_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + key },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
    timeoutSeconds: XAI_TIMEOUT_SECONDS,
  });
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code !== 200) {
    const err = new Error(botName + ': xAI answered HTTP ' + code + ': ' + text.slice(0, 500));
    // 408, 429 and 5xx are worth one more try. Anything else (bad key, no credit, bad model) is not.
    err.fatal = !(code === 408 || code === 429 || code >= 500);
    throw err;
  }

  const json = JSON.parse(text);
  if (json.status && json.status !== 'completed') {
    throw new Error(botName + ': reply came back ' + json.status + ' ' +
      JSON.stringify(json.incomplete_details || {}));
  }
  const out = outputText_(json);
  let data;
  try {
    data = JSON.parse(out);
  } catch (e) {
    const first = out.indexOf('{');
    const last = out.lastIndexOf('}');
    try {
      data = JSON.parse(out.slice(first, last + 1));
    } catch (e2) {
      throw new Error(botName + ': reply was not in the expected format: ' + out.slice(0, 300));
    }
  }
  const usage = json.usage || {};
  const tokens = usage.total_tokens || ((usage.input_tokens || 0) + (usage.output_tokens || 0));
  const cost = usage.cost_in_nano_usd != null ? Number(usage.cost_in_nano_usd) / 1e9 : '';
  return { data: data, tokens: tokens, cost: cost };
}

function outputText_(json) {
  const parts = [];
  (json.output || []).forEach(item => {
    if (item.type !== 'message') return;
    (item.content || []).forEach(c => {
      if (c.type === 'output_text' && c.text) parts.push(c.text);
    });
  });
  if (parts.length) return parts.join('');
  if (typeof json.output_text === 'string') return json.output_text;
  throw new Error('The xAI reply had no text in it.');
}

// ---------------------------------------------------------------------------
// Leads and property cards
// ---------------------------------------------------------------------------

function addLeads_(run, botName, leads) {
  const t = readTable_(TAB.LEADS);
  const c = t.col;
  const keyToIndex = {};
  t.rows.forEach((r, i) => {
    const rid = String(r[c['Run ID']] || '');
    const inScope = run.test ? rid === run.id : rid.indexOf('TEST') !== 0;
    if (inScope && r[c['Property Key']]) keyToIndex[r[c['Property Key']]] = i;
  });

  const now = new Date();
  const prefix = (run.test ? 'T-' : 'L-') + fmt_(now, 'yyyyMMdd') + '-';
  let seq = t.rows.filter(r => String(r[c['Lead ID']]).indexOf(prefix) === 0).length;
  const newRows = [];
  const addedKeys = {};
  let duplicates = 0;

  leads.forEach(l => {
    const key = propertyKey_(l.address, l.city);
    if (keyToIndex[key] !== undefined) {
      duplicates++;
      const i = keyToIndex[key];
      const found = String(t.rows[i][c['Found By']] || '');
      const merged = mergeList_(found, botName);
      if (merged !== found) {
        t.sheet.getRange(i + 2, c['Found By'] + 1).setValue(merged);
        t.rows[i][c['Found By']] = merged;
      }
      upsertCard_(key, { 'Found By': botName });
      return;
    }
    if (addedKeys[key]) {
      duplicates++;
      return;
    }
    addedKeys[key] = true;
    seq++;
    const id = prefix + ('00' + seq).slice(-3);
    newRows.push({
      'Lead ID': id, 'Date Found': now, 'Found By': botName,
      'Address': l.address, 'City': l.city, 'State': l.state, 'ZIP': l.zip,
      'Asking Price': l.asking_price, 'Property Type': l.property_type, 'Beds': l.beds,
      'Baths': l.baths, 'Sq Ft': l.sqft, 'Lot Sq Ft': l.lot_sqft, 'Seller / Contact': l.contact,
      'Source': l.source, 'Link': l.link, 'Notes': l.notes, 'Status': 'New', 'Score': '',
      'Property Key': key, 'Run ID': run.id,
    });
    upsertCard_(key, {
      'Address': l.address, 'City': l.city, 'State': l.state, 'ZIP': l.zip,
      'Found By': botName, 'Asking Price': l.asking_price, 'Link': l.link, 'Lead IDs': id,
    });
  });
  appendObjects_(TAB.LEADS, newRows);
  return { added: newRows.length, duplicates: duplicates };
}

/** Leads still waiting for Deal Desk, oldest first. */
function newLeads_(run) {
  const t = readTable_(TAB.LEADS);
  const c = t.col;
  const out = [];
  t.rows.forEach((r, i) => {
    const rid = String(r[c['Run ID']] || '');
    const inScope = run.test ? rid === run.id : rid.indexOf('TEST') !== 0;
    if (inScope && r[c['Status']] === 'New') out.push(rowObject_(t, r, i + 2));
  });
  return out;
}

function findLead_(leadId) {
  const t = readTable_(TAB.LEADS);
  const c = t.col['Lead ID'];
  for (let i = t.rows.length - 1; i >= 0; i--) {
    if (t.rows[i][c] === leadId) return rowObject_(t, t.rows[i], i + 2);
  }
  return null;
}

function recentAddresses_(limit) {
  const t = readTable_(TAB.LEADS);
  const c = t.col;
  return t.rows
    .filter(r => String(r[c['Run ID']] || '').indexOf('TEST') !== 0)
    .slice(-limit)
    .map(r => r[c['Address']] + ', ' + r[c['City']]);
}

function leadForBot_(o) {
  const map = {
    lead_id: 'Lead ID', address: 'Address', city: 'City', state: 'State', zip: 'ZIP',
    asking_price: 'Asking Price', property_type: 'Property Type', beds: 'Beds', baths: 'Baths',
    sqft: 'Sq Ft', lot_sqft: 'Lot Sq Ft', contact: 'Seller / Contact', source: 'Source',
    link: 'Link', notes: 'Notes', found_by: 'Found By',
  };
  const out = {};
  Object.keys(map).forEach(k => {
    const v = o[map[k]];
    if (v !== '' && v !== null && v !== undefined) out[k] = v;
  });
  return out;
}

function getCard_(key) {
  const t = readTable_(TAB.CARDS);
  const c = t.col['Property Key'];
  for (let i = 0; i < t.rows.length; i++) {
    if (t.rows[i][c] === key) return rowObject_(t, t.rows[i], i + 2);
  }
  return null;
}

/** One row per property. Creates the row the first time, then fills in whatever is new. */
function upsertCard_(key, fields) {
  const t = readTable_(TAB.CARDS);
  const kc = t.col['Property Key'];
  const index = t.rows.findIndex(r => r[kc] === key);
  const now = new Date();
  const row = index === -1 ? t.headers.map(() => '') : t.rows[index].slice();
  if (index === -1) {
    row[kc] = key;
    row[t.col['First Seen']] = now;
  }
  Object.keys(fields).forEach(h => {
    if (!(h in t.col)) return;
    let v = fields[h];
    if (v === undefined || v === null || v === '') return;
    if (MERGED_CARD_COLUMNS.indexOf(h) !== -1) v = mergeList_(row[t.col[h]], v);
    row[t.col[h]] = v;
  });
  row[t.col['Last Updated']] = now;
  const out = [row.map(cellValue_)];
  const at = index === -1 ? t.sheet.getLastRow() + 1 : index + 2;
  t.sheet.getRange(at, 1, 1, out[0].length).setValues(out);
}

/** "123 Main St, San Mateo" without repeating the city if the bot already put it in the address. */
function place_(lead) {
  const address = String(lead['Address'] || '');
  const city = String(lead['City'] || '');
  if (!city || address.toLowerCase().indexOf(city.toLowerCase()) !== -1) return address;
  return address + ', ' + city;
}

function isValueAdd_(tags) {
  return tags.some(t => String(t).toUpperCase().replace(/[\s_]+/g, '-').indexOf('VALUE-ADD') !== -1);
}

const STREET_WORDS = {
  street: 'st', avenue: 'ave', av: 'ave', road: 'rd', drive: 'dr', boulevard: 'blvd',
  lane: 'ln', court: 'ct', place: 'pl', circle: 'cir', terrace: 'ter', highway: 'hwy',
  parkway: 'pkwy', north: 'n', south: 's', east: 'e', west: 'w',
  apartment: 'unit', apt: 'unit', suite: 'unit', ste: 'unit',
};

function normText_(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[.,#']/g, ' ').replace(/\s+/g, ' ').trim();
}

/** "123 Main Street, San Mateo" and "123 main st" in San Mateo give the same key. */
function propertyKey_(address, city) {
  const street = normText_(String(address == null ? '' : address).split(',')[0])
    .split(' ').map(w => STREET_WORDS[w] || w).join(' ');
  return street + '|' + normText_(city);
}

function mergeList_(existing, add) {
  const list = String(existing || '').split(',').map(s => s.trim()).filter(String);
  String(add || '').split(',').map(s => s.trim()).filter(String).forEach(v => {
    if (list.indexOf(v) === -1) list.push(v);
  });
  return list.join(', ');
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/** Returns the address it went to, or '' if nothing was sent. Never throws. */
function sendMail_(run, to, who, subject, html) {
  const settings = getSettings_();
  let note = '';
  if (run.test) {
    note = '<p style="background:#fff4d6;padding:8px;font-family:Arial,sans-serif;font-size:13px">' +
      'TEST RUN. In a live run this goes to ' + esc_(who) + (to ? ' (' + esc_(to) + ')' : ' (no address set yet)') +
      '.</p>';
    to = settings.values[SETTING.TEST] || settings.values[SETTING.ALERTS] || currentUser_();
    subject = '[TEST] ' + subject;
  }
  if (!to) {
    log_(run.id, 'Email', 'NOT SENT', who + ' has no email address on the Settings tab: ' + subject);
    if (run.stats.alerted.indexOf(who) === -1) {
      run.stats.alerted.push(who);
      alert_(run, who + ' has no email address', 'Fill it in on the Settings tab. Unsent: ' + subject);
    }
    return '';
  }
  try {
    MailApp.sendEmail({ to: to, subject: subject, htmlBody: note + html, name: 'Deal Pipeline' });
    return to;
  } catch (err) {
    log_(run.id, 'Email', 'FAILED', 'To ' + to + ': ' + errMsg_(err));
    return '';
  }
}

function alert_(run, subject, details) {
  try {
    let to = '';
    try {
      to = getSettings_().values[SETTING.ALERTS];
    } catch (e) {
      // Settings tab unreadable. Fall back to the account running the script.
    }
    to = to || currentUser_();
    if (!to) return;
    MailApp.sendEmail({
      to: to,
      subject: (run && run.test ? '[TEST] ' : '') + '[Deal Pipeline] ' + subject,
      htmlBody: '<p>' + esc_(details) + '</p><p>Run: ' + esc_(run ? run.id : '') + '</p>' + sheetLink_(),
      name: 'Deal Pipeline',
    });
  } catch (err) {
    console.error('Alert email failed: ' + errMsg_(err));
  }
}

function dealDeskEmail_(summary, items, withComps) {
  const headers = ['#', 'Score', 'Property', 'Tags', 'Why', 'Next step'];
  if (withComps) headers.push('Comps');
  const rows = items.map(it => {
    const lead = it.lead;
    const place = esc_(place_(lead));
    const link = /^https?:\/\//.test(String(lead['Link'])) ?
      '<br><a href="' + esc_(lead['Link']) + '">listing</a>' : '';
    const n = Number(lead['Asking Price']);
    const price = lead['Asking Price'] !== '' && isFinite(n) && n > 0 ? '<br>$' + n.toLocaleString('en-US') : '';
    const cells = [
      it.rank, '<b>' + esc_(it.r.score) + '</b>' + (it.isHot ? ' &#128293;' : ''),
      place + price + link, esc_(it.tags.join(', ')), esc_(it.r.why), esc_(it.r.next_step),
    ];
    if (withComps) cells.push(esc_(it.r.comps));
    return cells;
  });
  return (summary ? '<p style="font-family:Arial,sans-serif">' + esc_(summary) + '</p>' : '') +
    table_(headers, rows) + sheetLink_();
}

function addOrSplitEmail_(lead, card, d) {
  const style = 'font-family:Arial,sans-serif;font-size:14px';
  return '<div style="' + style + '">' +
    '<p><b>' + esc_(place_(lead)) + '</b>' +
    (card['Score'] ? ' &middot; Deal Desk score ' + esc_(card['Score']) : '') + '</p>' +
    '<p><b>Recommendation:</b> ' + esc_(d.recommendation) + '</p>' +
    '<p>' + esc_(d.summary) + '</p>' +
    '<pre style="white-space:pre-wrap;font-family:Arial,sans-serif;font-size:13px">' + esc_(d.report) + '</pre>' +
    '</div>' + sheetLink_();
}

function table_(headers, rows) {
  const cell = 'padding:6px 8px;border-bottom:1px solid #e5e5e5;vertical-align:top';
  const head = headers.map(h =>
    '<th style="text-align:left;padding:6px 8px;border-bottom:2px solid #999">' + esc_(h) + '</th>').join('');
  const body = rows.map(r => '<tr>' + r.map(v => '<td style="' + cell + '">' + v + '</td>').join('') + '</tr>').join('');
  return '<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px">' +
    '<tr>' + head + '</tr>' + body + '</table>';
}

function sheetLink_() {
  return '<p style="font-family:Arial,sans-serif;font-size:13px"><a href="' + esc_(ss_().getUrl()) +
    '">Open the Deal Pipeline sheet</a></p>';
}

function esc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Test data (used only by "Run test")
// ---------------------------------------------------------------------------

function mockReply_(botName, context) {
  if (botName === BOT.DEAL_RADAR) {
    return { leads: [
      mockLead_('TEST 101 Sample St', 1250000, 'Corner lot, owner retiring, garage could become an ADU'),
      mockLead_('TEST 202 Example Ave', 980000, 'Estate sale, needs a full rehab'),
    ] };
  }
  if (botName === BOT.STRAIGHT_TALK) {
    return { leads: [
      mockLead_('TEST 303 Demo Rd', 1100000, 'Wide lot, seller open to a quick close'),
      mockLead_('TEST 101 Sample Street', 1250000, 'Same house Deal Radar found, to test duplicate handling'),
    ] };
  }
  if (botName === BOT.DEAL_DESK) {
    const ranked = context.map(l => {
      const a = String(l['Address']);
      const score = a.indexOf('101') !== -1 ? 9 : a.indexOf('303') !== -1 ? 8 : 6;
      return {
        lead_id: l['Lead ID'],
        rank: 0,
        score: score,
        tags: score >= 8 ? ['VALUE-ADD'] : ['REHAB'],
        comps: 'Sample comps: 3 sales within half a mile in the last 6 months, $1.30M to $1.45M.',
        why: 'Sample reasoning for the test run.',
        next_step: score >= 8 ? 'Call the seller today' : 'Watch for a price drop',
      };
    }).sort((a, b) => b.score - a.score);
    ranked.forEach((r, i) => { r.rank = i + 1; });
    return { summary: 'Test run. These are sample leads, not real properties.', ranked: ranked };
  }
  if (botName === BOT.ADD_OR_SPLIT) {
    return {
      recommendation: 'Add a detached ADU (sample)',
      summary: 'Sample report for ' + context['Address'] + '. The lot is wide enough for a detached ADU.',
      report: 'TEST REPORT\n\nLot: about 6,000 sq ft.\nOption 1: detached ADU in the back yard.\n' +
        'Option 2: lot split under SB 9.\n\nThis text is sample data from the test run.',
    };
  }
  throw new Error('No test data for ' + botName);
}

function mockLead_(address, price, notes) {
  return {
    address: address, city: 'Redwood City', state: 'CA', zip: '94061', asking_price: price,
    property_type: 'Single family', beds: 3, baths: 2, sqft: 1450, lot_sqft: 6000,
    contact: 'Test contact', source: 'Test data', link: null, notes: notes,
  };
}

// ---------------------------------------------------------------------------
// Sheet helpers
// ---------------------------------------------------------------------------

function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw fatal_('The "' + name + '" tab is missing. Run Deal Pipeline > Repair tabs.');
  return sh;
}

function readTable_(name) {
  const sh = sheet_(name);
  const values = sh.getDataRange().getValues();
  const headers = (values[0] || []).map(String);
  const col = {};
  headers.forEach((h, i) => { if (h) col[h] = i; });
  return { sheet: sh, headers: headers, col: col, rows: values.slice(1) };
}

function rowObject_(t, row, rowNumber) {
  const o = { _row: rowNumber };
  t.headers.forEach((h, i) => { if (h) o[h] = row[i]; });
  return o;
}

function setCells_(t, rowNumber, fields) {
  Object.keys(fields).forEach(h => {
    if (h in t.col) t.sheet.getRange(rowNumber, t.col[h] + 1).setValue(cellValue_(fields[h]));
  });
}

function appendObjects_(name, objects) {
  if (!objects.length) return;
  const sh = sheet_(name);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const rows = objects.map(o => headers.map(h => cellValue_(o[h])));
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
}

/** Keeps bot text from being read as a formula and from overflowing a cell. */
function cellValue_(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) v = v.join(', ');
  if (typeof v === 'string') {
    if (v.length > CELL_LIMIT) v = v.slice(0, CELL_LIMIT) + ' [cut off: too long for one cell]';
    if (/^[=+\-@]/.test(v) && isNaN(Number(v))) v = '\'' + v;
  }
  return v;
}

function ensureTab_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  const lastCol = sh.getLastColumn();
  const existing = lastCol ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
  const have = existing.filter(String);
  const missing = headers.filter(h => have.indexOf(h) === -1);
  if (missing.length) {
    sh.getRange(1, have.length + 1, 1, missing.length).setValues([missing]);
  }
  const all = have.concat(missing);
  sh.getRange(1, 1, 1, all.length).setFontWeight('bold').setBackground('#eef2f7');
  sh.setFrozenRows(1);
  all.forEach((h, i) => {
    const long = LONG_TEXT_COLUMNS.indexOf(h) !== -1;
    sh.setColumnWidth(i + 1, long ? 320 : 130);
    if (long && sh.getMaxRows() > 1) {
      sh.getRange(2, i + 1, sh.getMaxRows() - 1, 1).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
    }
  });
  return sh;
}

function ensureSettingsTab_(ss) {
  let sh = ss.getSheetByName(TAB.SETTINGS);
  if (!sh) {
    sh = ss.insertSheet(TAB.SETTINGS);
    const botRows = Object.keys(BOT).map(k => [BOT[k], '', DEFAULT_MODEL, 'ON']);
    sh.getRange(1, 1, 1, 4).setValues([['Bot', 'Instructions (Juan fills these in)', 'Model', 'Web + X search']]);
    sh.getRange(2, 1, botRows.length, 4).setValues(botRows);
    const start = botRows.length + 3;
    sh.getRange(start, 1, 1, 3).setValues([['Setting', 'Value', 'What it does']]);
    sh.getRange(start + 1, 1, 6, 3).setValues([
      [SETTING.CHERRY, '', 'Gets the ranked Deal Desk list every morning'],
      [SETTING.JUAN, '', 'Gets every lead at or above the hot lead score'],
      [SETTING.THEA, '', 'Gets each Add or Split This House report'],
      [SETTING.ALERTS, '', 'Gets error alerts. Blank means the account that runs the script'],
      [SETTING.TEST, '', 'Test runs send every email here instead. Blank means the alerts address'],
      [SETTING.HOT, 8, 'Score that counts as a hot lead'],
    ]);
    sh.getRange(1, 1, 1, 4).setFontWeight('bold').setBackground('#eef2f7');
    sh.getRange(start, 1, 1, 3).setFontWeight('bold').setBackground('#eef2f7');
    sh.setColumnWidth(1, 240);
    sh.setColumnWidth(2, 520);
    sh.setColumnWidth(3, 140);
    sh.setColumnWidth(4, 120);
    sh.getRange(2, 2, botRows.length, 1).setWrap(true).setVerticalAlignment('top');
    sh.getRange(2, 4, botRows.length, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(['ON', 'OFF'], true).build());
    sh.setFrozenRows(1);
    return sh;
  }
  // Tab already exists: keep everything in it and add any rows that are missing.
  const labels = sh.getDataRange().getValues().map(r => String(r[0]).trim());
  Object.keys(BOT).forEach(k => {
    if (labels.indexOf(BOT[k]) === -1) sh.appendRow([BOT[k], '', DEFAULT_MODEL, 'ON']);
  });
  Object.keys(SETTING).forEach(k => {
    if (labels.indexOf(SETTING[k]) === -1) sh.appendRow([SETTING[k], k === 'HOT' ? 8 : '', '']);
  });
  return sh;
}

function getSettings_() {
  const values = sheet_(TAB.SETTINGS).getDataRange().getValues();
  const botNames = Object.keys(BOT).map(k => BOT[k]);
  const labels = Object.keys(SETTING).map(k => SETTING[k]);
  const bots = {};
  const vals = {};
  values.forEach(r => {
    const label = String(r[0]).trim();
    if (botNames.indexOf(label) !== -1) {
      bots[label] = {
        instructions: String(r[1] == null ? '' : r[1]).trim(),
        model: String(r[2] == null ? '' : r[2]).trim() || DEFAULT_MODEL,
        webSearch: String(r[3] == null ? '' : r[3]).trim().toUpperCase() !== 'OFF',
      };
    } else if (labels.indexOf(label) !== -1) {
      vals[label] = String(r[1] == null ? '' : r[1]).trim();
    }
  });
  botNames.forEach(b => {
    if (!bots[b]) bots[b] = { instructions: '', model: DEFAULT_MODEL, webSearch: true };
  });
  return { bots: bots, values: vals };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function log_(runId, step, result, details, tokens, cost) {
  console.log([runId, step, result, details].join(' | '));
  try {
    appendObjects_(TAB.LOG, [{
      'Time': new Date(), 'Run ID': runId, 'Step': step, 'Result': result, 'Details': details,
      'Tokens': tokens || '', 'Cost (USD)': cost === '' || cost == null ? '' : cost,
    }]);
  } catch (err) {
    console.error('Could not write to the Run Log: ' + errMsg_(err));
  }
}

function getRun_() {
  const raw = PropertiesService.getScriptProperties().getProperty(RUN_KEY);
  return raw ? JSON.parse(raw) : null;
}

function saveRun_(run) {
  PropertiesService.getScriptProperties().setProperty(RUN_KEY, JSON.stringify(run));
}

function clearRun_() {
  PropertiesService.getScriptProperties().deleteProperty(RUN_KEY);
}

function scheduleWorker_(ms) {
  deleteTriggers_(WORKER);
  ScriptApp.newTrigger(WORKER).timeBased().after(ms).create();
}

function deleteTriggers_(handler) {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === handler) ScriptApp.deleteTrigger(t);
  });
}

function fatal_(message) {
  const err = new Error(message);
  err.fatal = true;
  return err;
}

function errMsg_(err) {
  return err && err.message ? err.message : String(err);
}

function fmt_(date, pattern) {
  return Utilities.formatDate(date, TZ, pattern);
}

function currentUser_() {
  try {
    return Session.getEffectiveUser().getEmail();
  } catch (err) {
    return '';
  }
}

function toast_(message) {
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast(message, 'Deal Pipeline', 10);
  } catch (err) {
    // No spreadsheet open (trigger run). The Run Log has the details.
  }
}
