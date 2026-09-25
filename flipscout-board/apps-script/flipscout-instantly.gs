/**
 * FlipScout — automatic listing-agent emails through Instantly.
 *
 * Lives in the prod sheet next to flip-scout-reject.gs and flipscout-alerts.gs,
 * and uses FS_LEADS, FS_PASSED, FS_CLOSED, fsPost_, fsPage_ and fsSafeEmail_
 * from the alerts file (same project, one namespace). Prefix fsi.
 *
 * The pair: Instantly SENDS (3-step campaign, stop on reply). This script
 * decides WHO and brings the results back.
 *
 * THREE SLOTS. Instantly holds an email address once per campaign, so there
 * are three identical campaigns (FSI_CAMPAIGNS). Each house goes into the
 * first slot where its agent has nothing in progress; a finished entry in a
 * slot is removed first. All three busy → the house is queued as Waiting and
 * goes in when one frees up (soonest offer deadline first).
 *
 *  Every hour (fsiHourly)
 *    1. Read each campaign's leads: 3 emails sent with no reply → Done,
 *       bounced → Bounced. Frees the slot.
 *    2. Stop (remove from its campaign) any house whose listing went pending /
 *       sold / withdrawn, passed in Notes, "no emails" in Notes, or left Leads.
 *       Waiting houses in that state are Dropped.
 *    3. Move Waiting houses into free slots.
 *    4. If automatic adding is ON: add new A leads (Active, agent email, not
 *       passed, deadline not past, never added), up to FSI_DAILY_MAX a day.
 *  Every 15 minutes (fsiReplies)
 *    5. Read new replies from all three campaigns. Mark that house Replied,
 *       keep the reply, read an offer deadline by rules, post to Google Chat
 *       (🚨 NEEDS JUAN on call / price wording or a deadline under 24h), and
 *       PAUSE the agent's other houses (Juan is talking to them now).
 *    6. The agent's deadline goes into Offer Due on Leads when Offer Due is
 *       blank or TBD, and back in if the app's Refresh blanks it.
 *
 *  The Board's "✉ Email agent" button adds one house on demand (fsiWebEmail_,
 *  reached through doGet in flipscout-alerts.gs).
 *
 *  Everything is logged on the "Agent Emails" tab, one row per house.
 *  Statuses: Emailing · Waiting · Replied · Paused · Done · Bounced · Stopped · Dropped
 *
 * SETUP (once)
 *   Script Properties: INSTANTLY_API_KEY = <key>   (never in git or chat)
 *   Paste this file, save, run fsiSetup, approve, reload the sheet.
 *   Automatic adding starts OFF; turn it on from the menu.
 */

const FSI_CAMPAIGNS = [
  '98ab8360-fe96-4bf5-812a-d8903f8bd5a8',   // 1  FlipScout – Listing agents
  '36bf11e0-b532-4a57-96e3-a08af4ecb938',   // 2  FlipScout – Listing agents Pt. 2
  '1d8d854a-2085-4140-9662-69678d7c61e4'    // 3  FlipScout – Listing agents Pt. 3
];
const FSI_API = 'https://api.instantly.ai/api/v2';
const FSI_TAB = 'Agent Emails';
const FSI_DAILY_MAX = 10;
// Test houses: not on the Leads tab, never counted against the daily limit, never auto-stopped.
const FSI_TESTS = [
  { mls: 'TEST0001', email: 'bryan@twinhomebuyer.com',    agent: 'Bryan Test',    addr: '123 Test Street, San Carlos, CA 94070' },
  { mls: 'TEST0002', email: 'rosanes@twinhomebuyer.com',  agent: 'Jonathan Test', addr: '123 Test Street, San Francisco, CA 94112' },
  { mls: 'TEST0003', email: 'lawrence@twinhomebuyer.com', agent: 'Lawrence Test', addr: '123 Test Street, Berkeley, CA 94703' },
  // more houses for the same agent: slots 2 and 3, then a 4th that has to wait
  { mls: 'TEST0004', email: 'bryan@twinhomebuyer.com',    agent: 'Bryan Test',    addr: '456 Test Avenue, Oakland, CA 94605' },
  { mls: 'TEST0005', email: 'bryan@twinhomebuyer.com',    agent: 'Bryan Test',    addr: '789 Test Court, San Jose, CA 95112' },
  { mls: 'TEST0006', email: 'bryan@twinhomebuyer.com',    agent: 'Bryan Test',    addr: '321 Test Lane, Hayward, CA 94545' }
];
const fsiIsTest_ = mls => FSI_TESTS.some(t => t.mls === mls);
const FSI_HEAD = ['Added On', 'MLS #', 'Address', 'Agent', 'Agent Email', 'Status', 'Replied On',
                  'Agent Offer Due', 'Needs Juan', 'Reply', 'Stopped On', 'Stop Reason', 'Instantly Lead ID', 'Added By', 'Campaign'];
const C = { added: 1, mls: 2, addr: 3, agent: 4, email: 5, status: 6, replied: 7, due: 8, juan: 9, reply: 10,
            stopped: 11, reason: 12, id: 13, by: 14, slot: 15 };      // sheet columns, 1-based
const FSI_EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}$/i;
const FSI_PENDING = /pending|contingent|under contract/i;
const FSI_NO_EMAIL_NOTE = /no (?:outreach|e-?mails?)/i;
// what makes a reply Juan's to handle
const FSI_JUAN = /\b(call me|give me a (?:call|ring)|call you|phone call|speak (?:with|to) (?:the |your )?buyer|talk (?:with|to) (?:you|the buyer|your buyer)|(?:your|the) (?:best|highest) (?:price|offer)|price|below (?:asking|list)|under (?:asking|list)|highest and best|best and final|multiple offers|counter(?:offer)?|seller (?:would|will|may|might) (?:take|accept|consider)|backup offer|in escrow|accepted an offer)\b/i;
const FSI_CUE = /\boffers?\b[\s,:-]{0,3}(?:(?:are|will be|to be|must be|shall be|being|if any|,)\s+){0,2}(?:due|date|deadline|welcome|reviewed|review(?:ed)? on|presented|presentation|accepted|taken|considered|by|on)\b/gi;
const FSI_WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const FSI_MO = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const FSI_TZ = 'America/Los_Angeles';

/* ---------------------------------------------------------------- setup -- */

function fsiSetup() {
  const mine = ['fsiOnOpen', 'fsiHourly', 'fsiReplies',
                'fsoOnOpen', 'fsoHourly'];              // the old draft-in-Gmail script, retired
  ScriptApp.getProjectTriggers().filter(t => mine.indexOf(t.getHandlerFunction()) >= 0)
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('fsiOnOpen').forSpreadsheet(SpreadsheetApp.getActive()).onOpen().create();
  ScriptApp.newTrigger('fsiHourly').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('fsiReplies').timeBased().everyMinutes(15).create();
  fsiTab_();
  const names = FSI_CAMPAIGNS.map(id => fsiApi_('get', '/campaigns/' + id).name);   // throws if a key or id is wrong
  Logger.log('Connected to ' + names.map((n, i) => (i + 1) + ') "' + n + '"').join(', ') +
             '. Automatic adding is ' + ({ off: 'OFF', test: 'TEST leads only', on: 'ON' }[fsiMode_()]) + '. Reload the sheet for the ✉️ FlipScout Emails menu.');
}

function fsiOnOpen() {
  const mode = fsiMode_();
  const label = { off: 'OFF', test: 'TEST leads only', on: 'ON (real A leads)' }[mode];
  SpreadsheetApp.getUi().createMenu('✉️ FlipScout Emails')
    .addItem('Check Instantly connection', 'fsiCheck')
    .addItem('Preview — who would be added next (adds nothing)', 'fsiPreview')
    .addSeparator()
    .addItem('Check replies now', 'fsiRepliesNow')
    .addItem('Run the hourly check now', 'fsiHourlyNow')
    .addItem('Stop emails for the selected row(s)', 'fsiStopSelected')
    .addSeparator()
    .addItem('Automatic adding is ' + label + ' — change it', 'fsiChooseMode')
    .addItem('Add new leads now (up to ' + FSI_DAILY_MAX + ' a day)', 'fsiAddNow')
    .addSeparator()
    .addItem('TEST: put the ' + FSI_TESTS.length + ' TEST leads on the Leads tab', 'fsiPutTests')
    .addItem('TEST: remove the TEST leads (and stop their emails)', 'fsiRemoveTests')
    .addToUi();
}

/* -------------------------------------------------------------- menu ---- */

function fsiCheck() {
  const ui = SpreadsheetApp.getUi();
  const status = { 0: 'Draft — NOT LAUNCHED', 1: 'Active', 2: 'Paused', 3: 'Completed', 4: 'Running subsequences',
                   '-1': 'Accounts unhealthy', '-2': 'Bounce protect', '-99': 'Account suspended' };
  const lines = [], warn = [];
  FSI_CAMPAIGNS.forEach((id, i) => {
    let c;
    try { c = fsiApi_('get', '/campaigns/' + id); }
    catch (e) { lines.push((i + 1) + ') connection failed: ' + e.message); return; }
    const steps = ((c.sequences || [])[0] || {}).steps || [];
    const text = steps.map(s => ((s.variants || [])[0] || {})).map(v => (v.subject || '') + ' ' + (v.body || '')).join(' ');
    lines.push((i + 1) + ') ' + c.name + ' — ' + (status[c.status] || c.status) + ' · ' + steps.length + ' emails · from ' +
               ((c.email_list || []).join(', ') || 'NO INBOX'));
    const n = 'Campaign ' + (i + 1) + ': ';
    if (c.status !== 1) warn.push('• ' + n + 'launch it in Instantly (it sits idle until the script adds someone).');
    if (!c.stop_on_reply) warn.push('• ' + n + '"Stop sending emails on reply" is OFF.');
    if (steps.length !== 3) warn.push('• ' + n + steps.length + ' email step(s); we planned 3.');
    if (!/\{\{\s*address\s*\}\}/.test(text)) warn.push('• ' + n + 'no {{address}} in the emails.');
    if (!/\{\{\s*firstName\s*\}\}/.test(text)) warn.push('• ' + n + 'no {{firstName}} in the emails.');
  });
  const rows = fsiRows_(), count = s => rows.filter(r => r.status === s).length;
  ui.alert('Instantly connection',
    lines.join('\n') +
    '\n\nAutomatic adding: ' + ({ off: 'OFF', test: 'TEST leads only', on: 'ON' }[fsiMode_()]) +
    '\nAgent Emails tab: ' + ['Emailing', 'Waiting', 'Replied', 'Paused', 'Done', 'Stopped'].map(s => count(s) + ' ' + s.toLowerCase()).join(' · ') +
    (warn.length ? '\n\nTo fix:\n' + warn.join('\n') : '\n\nEverything looks right.') +
    (fsiProp_('FSI_LAST_ERROR') ? '\n\nLast error: ' + fsiProp_('FSI_LAST_ERROR') : ''),
    ui.ButtonSet.OK);
}

function fsiPreview() {
  const p = fsiPick_(new Date());
  const ui = SpreadsheetApp.getUi();
  ui.alert('Next leads to add (nothing added)',
    (p.list.length
      ? p.list.map(l => '• ' + fsiShort_(l.addr) + ' → ' + (l.agent || 'agent') + ' <' + l.email + '>' + (l.due ? ' · offers ' + l.due : '')).join('\n')
      : 'Nobody right now.') +
    '\n\n' + p.room + ' of ' + FSI_DAILY_MAX + ' left for today · ' + p.eligible + ' eligible in total' +
    (Object.keys(p.skipped).length ? '\n\nSkipped A leads:\n' + Object.keys(p.skipped).map(k => '• ' + p.skipped[k] + ' ' + k).join('\n') : ''),
    ui.ButtonSet.OK);
}

// Put the test houses on the Leads tab as ordinary A / Active leads, so they
// travel the same road as real ones: the hourly job (in TEST-only mode) or the
// Board's button hands them to Instantly.
function fsiPutTests() {
  // start clean: earlier test runs leave rows here and entries in Instantly
  fsiLocked_(() => {
    const tab = fsiTab_();
    fsiRows_().filter(r => fsiIsTest_(r.mls)).reverse().forEach(r => {
      if (r.id) fsiDelete_(r.id);
      tab.deleteRow(r.row);
    });
  });
  const sh = SpreadsheetApp.getActive().getSheetByName(FS_LEADS);
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const have = {};
  fsiLeads_().forEach(l => { have[l.mls] = true; });
  const today = Utilities.formatDate(new Date(), FSI_TZ, 'yyyy-MM-dd');
  let n = 0;
  FSI_TESTS.filter(t => !have[t.mls]).forEach(t => {
    const v = { 'Status': 'Needs Comps', 'MLS #': t.mls, 'Address': t.addr, 'Beds': 3, 'SqFt': 1000, 'Year Built': 1950, 'DOM': 1,
                'Purchase Price': 100000, '$/SqFt': 100, 'Notes': 'TEST lead — not a real property', 'First Added': today,
                'Bucket': 'A — Work Now', 'Opportunity Score': 99, 'Why': 'TEST lead for the Instantly emails',
                'Listing Agent': t.agent, 'MLS Status': 'Active', 'Agent Phone': '(000) 000-0000', 'Agent Email': t.email };
    sh.appendRow(head.map(h => v[h] === undefined ? '' : v[h]));
    n++;
  });
  SpreadsheetApp.getUi().alert(n ? n + ' TEST lead(s) added to the bottom of the Leads tab.' : 'The TEST leads are already on the Leads tab.',
    'Next: ✉️ FlipScout Emails → Automatic adding → TEST leads only, then "Run the hourly check now" (or wait for the hour).\n\n' +
    'Do not run the app\'s Refresh while testing — it would look the TEST numbers up on the MLS, not find them, and the script would then stop them as "not active".',
    SpreadsheetApp.getUi().ButtonSet.OK);
}

function fsiRemoveTests() {
  const ui = SpreadsheetApp.getUi();
  if (ui.alert('Remove the TEST leads?', 'Deletes the TEST rows from the Leads tab and stops any TEST emails still going out. The Agent Emails tab keeps its record.',
               ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;
  fsiLocked_(() => {
    fsiRows_().filter(r => fsiIsTest_(r.mls) && (r.status === 'Emailing' || r.status === 'Waiting'))
      .forEach(r => r.status === 'Waiting' ? fsiEnd_(r, 'Dropped', 'Test finished') : fsiEnd_(r, 'Stopped', 'Test finished', true));
    const sh = SpreadsheetApp.getActive().getSheetByName(FS_LEADS);
    const v = sh.getDataRange().getValues(), iM = v[0].map(h => String(h).trim()).indexOf('MLS #');
    for (let i = v.length - 1; i >= 1; i--) if (fsiIsTest_(String(v[i][iM]).trim().toUpperCase())) sh.deleteRow(i + 1);
  });
  if (fsiMode_() === 'test') PropertiesService.getScriptProperties().setProperty('FSI_AUTO', 'off');
  ui.alert('TEST leads removed. Automatic adding is ' + (fsiMode_() === 'on' ? 'ON' : 'OFF') + '.');
}

function fsiChooseMode() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Automatic adding',
    'Now: ' + { off: 'OFF', test: 'TEST leads only', on: 'ON (real A leads)' }[fsiMode_()] + '\n\n' +
    'Type one word and press OK:\n  off   — nothing is added automatically\n  test  — only the TEST leads on the Leads tab\n' +
    '  on    — real A leads, up to ' + FSI_DAILY_MAX + ' a day', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const m = String(r.getResponseText()).trim().toLowerCase();
  if (['off', 'test', 'on'].indexOf(m) < 0) { ui.alert('Type off, test or on.'); return; }
  PropertiesService.getScriptProperties().setProperty('FSI_AUTO', m);
  ui.alert('Automatic adding is now ' + { off: 'OFF', test: 'TEST leads only', on: 'ON (real A leads)' }[m] +
           '. It runs every hour; "Run the hourly check now" runs it straight away. Reload the sheet to refresh the menu label.');
}

function fsiRepliesNow() {
  const n = fsiReplies();
  SpreadsheetApp.getActive().toast(n ? n + ' new repl' + (n === 1 ? 'y' : 'ies') + ' — see the Agent Emails tab and Google Chat.'
                                     : 'No new replies.', 'FlipScout Emails', 8);
}

function fsiHourlyNow() {
  fsiHourly();
  SpreadsheetApp.getActive().toast('Done — see the Agent Emails tab.', 'FlipScout Emails', 6);
}


function fsiAddNow() {
  const n = fsiLocked_(() => fsiAddNew_(new Date())) || 0;
  SpreadsheetApp.getActive().toast(n ? n + ' house(s) handed to Instantly.' : 'Nothing to add (see Preview for why).', 'FlipScout Emails', 8);
}

// Rows selected on the Agent Emails or Leads tab.
function fsiStopSelected() {
  const ui = SpreadsheetApp.getUi(), sh = SpreadsheetApp.getActiveSheet();
  const name = sh.getName();
  if (name !== FSI_TAB && name !== FS_LEADS) { ui.alert('Select the row(s) on the Agent Emails or Leads tab first.'); return; }
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const iM = head.indexOf('MLS #'), want = {};
  sh.getActiveRangeList().getRanges().forEach(r => {
    const v = sh.getRange(r.getRow(), iM + 1, r.getNumRows(), 1).getValues();
    v.forEach((x, k) => { if (r.getRow() + k > 1 && x[0]) want[String(x[0]).trim().toUpperCase()] = true; });
  });
  const who = fsSafeEmail_() || 'someone';
  const n = fsiLocked_(() => {
    const rows = fsiRows_().filter(r => want[r.mls] && (r.status === 'Emailing' || r.status === 'Waiting'));
    rows.forEach(r => r.status === 'Waiting' ? fsiEnd_(r, 'Dropped', 'Stopped by ' + who) : fsiEnd_(r, 'Stopped', 'Stopped by ' + who, true));
    return rows.length;
  }) || 0;
  ui.alert(n ? 'Stopped ' + n + ' house(s). Instantly will send them nothing more.' : 'None of the selected houses are being emailed or waiting.');
}

/* ------------------------------------------------------ the timed jobs -- */

function fsiHourly() {
  fsiLocked_(() => {
    const now = new Date();
    fsiSyncDone_();
    fsiStops_();
    fsiPlaceWaiting_(now);
    if (fsiMode_() !== 'off') fsiAddNew_(now);
  });
}

// Returns how many new replies it handled.
function fsiReplies() {
  return fsiLocked_(() => {
    const got = fsiReadReplies_();
    fsiReheal_();
    return got;
  }) || 0;
}

/* --------------------------------------------------------------- slots -- */

const FSI_BUSY = { Emailing: 1 };                     // a house that still holds its slot
// The first campaign where this agent has nothing in progress, or 0.
function fsiFreeSlot_(email, rows) {
  for (let s = 1; s <= FSI_CAMPAIGNS.length; s++) {
    if (!rows.some(r => r.email === email && r.slot === s && FSI_BUSY[r.status])) return s;
  }
  return 0;
}

// Put a house into Instantly now, or queue it. Returns the row written.
// force (the test lead): clear the agent's previous rows first.
function fsiPlace_(l, by, force) {
  let rows = fsiRows_();
  if (force) {
    rows.filter(r => r.mls === l.mls && (r.status === 'Emailing' || r.status === 'Waiting'))
      .forEach(r => fsiEnd_(r, 'Stopped', 'Replaced by a new test', true));
    rows = fsiRows_();
  }
  const slot = fsiFreeSlot_(l.email, rows);
  const sh = fsiTab_();
  if (!slot) {
    sh.appendRow([new Date(), l.mls, l.addr, l.agent, l.email, 'Waiting', '', '', '', '', '', 'Agent has ' + FSI_CAMPAIGNS.length + ' houses in progress', '', by || 'Automatic', '']);
    return { slot: 0, waiting: true };
  }
  const id = fsiSend_(l, slot, rows);
  sh.appendRow([new Date(), l.mls, l.addr, l.agent, l.email, 'Emailing', '', '', '', '', '', '', id, by || 'Automatic', slot]);
  return { slot, id };
}

// Add to campaign `slot`, first removing the agent's finished entry there.
function fsiSend_(l, slot, rows) {
  const sh = fsiTab_();
  rows.filter(r => r.email === l.email && r.slot === slot && r.id).forEach(r => {
    fsiDelete_(r.id);
    sh.getRange(r.row, C.id).setValue('');                  // entry gone from Instantly; the row stays as the record
  });
  const res = fsiApi_('post', '/leads', {
    campaign: FSI_CAMPAIGNS[slot - 1], email: l.email, first_name: fsiFirst_(l.agent),
    last_name: String(l.agent || '').split(/\s+/).slice(1).join(' '),
    custom_variables: { address: fsiShort_(l.addr), full_address: l.addr, mls: l.mls },
    skip_if_in_campaign: true
  });
  if (!res || !res.id) throw new Error('Instantly did not add ' + l.email + ' to campaign ' + slot + ' (already in it?)');
  return res.id;
}

function fsiDelete_(id) {
  try { fsiApi_('delete', '/leads/' + id); }
  catch (e) { if (!/\b404\b/.test(e.message)) throw e; }      // already gone is fine
}

// End a house: Stopped / Paused / Done / Dropped / Bounced. remove = take it out of Instantly.
function fsiEnd_(r, status, why, remove) {
  const sh = fsiTab_();
  if (remove && r.id) { fsiDelete_(r.id); sh.getRange(r.row, C.id).setValue(''); }
  sh.getRange(r.row, C.status).setValue(status);
  sh.getRange(r.row, C.stopped, 1, 2).setValues([[new Date(), why]]);
  r.status = status;
}

function fsiTestLead_(mls) {
  const t = FSI_TESTS.find(x => x.mls === mls) || FSI_TESTS[0];
  return { mls: t.mls, addr: t.addr, agent: t.agent, email: t.email, notes: '', mstat: 'Active' };
}

/* -------------------------------------------------------------- adding -- */

function fsiPick_(now) {
  const rows = fsiRows_(), have = {};
  rows.forEach(r => { have[r.mls] = true; });
  const today = Utilities.formatDate(now, FSI_TZ, 'yyyy-MM-dd');
  const addedToday = rows.filter(r => !fsiIsTest_(r.mls) && r.slot && r.added &&
    Utilities.formatDate(new Date(r.added), FSI_TZ, 'yyyy-MM-dd') === today).length;
  const room = Math.max(0, FSI_DAILY_MAX - addedToday);
  const ok = [], skipped = {};
  const skip = why => { skipped[why] = (skipped[why] || 0) + 1; };
  const testOnly = fsiMode_() === 'test';
  fsiLeads_().forEach(l => {
    if (!/^A/i.test(l.bucket)) return;
    if (testOnly && !fsiIsTest_(l.mls)) return;
    if (have[l.mls]) return skip('already handled');
    const why = fsiBlock_(l, now);
    if (why) return skip(why);
    ok.push(l);
  });
  const t = l => { const d = fsiDeadline_(l.due); return d ? d.getTime() : Infinity; };
  ok.sort((a, b) => t(a) - t(b) || (+b.score || 0) - (+a.score || 0));
  return { list: ok.slice(0, room), room, eligible: ok.length, skipped };
}

// Why a lead must not be emailed right now, or ''.
function fsiBlock_(l, now) {
  if (FS_PASSED.test(l.notes)) return 'passed in Notes';
  if (FSI_NO_EMAIL_NOTE.test(l.notes)) return '"no emails" in Notes';
  if (!/^active$/i.test(l.mstat)) return l.mstat ? 'not Active on the MLS (' + l.mstat.toLowerCase() + ')' : 'no MLS status';
  if (!l.email) return 'no agent email';
  const d = fsiDeadline_(l.due);
  if (d && d < now) return 'offer deadline passed';
  return '';
}

function fsiAddNew_(now) {
  let n = 0;
  fsiPick_(now).list.forEach(l => {
    try { if (fsiPlace_(l, 'Automatic').slot) n++; } catch (e) { fsiErr_('adding ' + l.mls + ': ' + e.message); }
  });
  return n;
}

// Waiting houses go into free slots, soonest deadline first.
function fsiPlaceWaiting_(now) {
  const leads = {};
  fsiLeads_().forEach(l => { leads[l.mls] = l; });
  const t = r => { const d = fsiDeadline_((leads[r.mls] || {}).due); return d ? d.getTime() : Infinity; };
  fsiRows_().filter(r => r.status === 'Waiting').sort((a, b) => t(a) - t(b)).forEach(r => {
    const l = leads[r.mls] || (fsiIsTest_(r.mls) ? fsiTestLead_(r.mls) : null);
    const why = !l ? 'Lead is no longer on the Leads tab' : fsiBlock_(l, now);
    if (why) { fsiEnd_(r, 'Dropped', why); return; }
    const rows = fsiRows_(), slot = fsiFreeSlot_(r.email, rows);
    if (!slot) return;
    try {
      const id = fsiSend_(l, slot, rows), sh = fsiTab_();
      sh.getRange(r.row, C.added).setValue(new Date());
      sh.getRange(r.row, C.status).setValue('Emailing');
      sh.getRange(r.row, C.reason).setValue('');
      sh.getRange(r.row, C.id).setValue(id);
      sh.getRange(r.row, C.slot).setValue(slot);
    } catch (e) { fsiErr_('placing waiting ' + r.mls + ': ' + e.message); }
  });
}

/* ----------------------------------------- the Board's Email button -- */

// doGet (flipscout-alerts.gs) sends action=email here. A person chose this
// lead, so any bucket is fine; the safety checks still apply.
function fsiWebEmail_(mls, by) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return fsPage_('Busy', 'FlipScout is updating right now. Close this tab and click the button again in a minute.');
  try {
    let l;
    const test = fsiIsTest_(mls) && !fsiLeads_().some(x => x.mls === mls);   // a TEST lead that is not on the sheet
    if (test) l = fsiTestLead_(mls);
    else {
      l = fsiLeads_().find(x => x.mls === mls);
      if (!l) return fsPage_('Lead not on the sheet', mls + ' is not on the Leads tab (it may have been rejected). Nothing was sent.');
      const done = fsiRows_().filter(r => r.mls === mls).pop();
      if (done) return fsPage_('Already handled', fsiShort_(l.addr) + ' was handed to Instantly on ' +
        Utilities.formatDate(new Date(done.added), FSI_TZ, 'MMM d') + ' — now ' + done.status.toLowerCase() + '. See the Agent Emails tab.');
      const why = fsiBlock_(l, new Date());
      if (why) return fsPage_('Not sent', fsiShort_(l.addr) + ': ' + why + '. Nothing was sent.');
    }
    const r = fsiPlace_(l, by || 'Board', test);
    if (r.waiting) return fsPage_('Queued', (l.agent || l.email) + ' already has ' + FSI_CAMPAIGNS.length +
      ' houses being emailed. ' + fsiShort_(l.addr) + ' is Waiting and goes out as soon as one of them finishes. You can close this tab.');
    return fsPage_('✓ Sent to Instantly', fsiShort_(l.addr) + ' → ' + (l.agent || 'the agent') + ' <' + l.email + '> (campaign ' + r.slot + '). ' +
      'Instantly sends the first email within the sending hours, then the follow-ups; it stops when the agent replies. You can close this tab.');
  } catch (e) {
    fsiErr_('Board email ' + mls + ': ' + e.message);
    return fsPage_('Not sent', 'Instantly refused it: ' + e.message);
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------ finishing and stopping -- */

// Instantly's own view of each house: 3 emails sent → Done, bounced → Bounced.
function fsiSyncDone_() {
  const open = fsiRows_().filter(r => r.status === 'Emailing' && r.id);
  if (!open.length) return;
  const state = {};
  FSI_CAMPAIGNS.forEach((cid, i) => {
    if (!open.some(r => r.slot === i + 1)) return;
    let after = '';
    for (let page = 0; page < 20; page++) {
      const res = fsiApi_('post', '/leads/list', after ? { campaign: cid, limit: 100, starting_after: after } : { campaign: cid, limit: 100 });
      (res.items || []).forEach(x => { state[x.id] = x; });
      after = res.next_starting_after;
      if (!after || !(res.items || []).length) break;
    }
  });
  open.forEach(r => {
    const x = state[r.id];
    if (!x) return;
    if (x.status === 3 && !(x.email_reply_count > 0)) fsiEnd_(r, 'Done', 'All 3 emails sent, no reply');
    else if (x.status === -1) fsiEnd_(r, 'Bounced', 'The agent email bounced');
  });
}

function fsiStops_() {
  const leads = {};
  fsiLeads_().forEach(l => { leads[l.mls] = l; });
  fsiRows_().filter(r => (r.status === 'Emailing' || r.status === 'Waiting') && !(fsiIsTest_(r.mls) && !leads[r.mls])).forEach(r => {
    const l = leads[r.mls];
    const why = !l ? 'Lead is no longer on the Leads tab'
      : FS_CLOSED.test(l.mstat) || FSI_PENDING.test(l.mstat) ? 'Listing ' + l.mstat.toLowerCase()
      : FS_PASSED.test(l.notes) ? 'Passed in Notes'
      : FSI_NO_EMAIL_NOTE.test(l.notes) ? '"no emails" in Notes' : '';
    if (!why) return;
    try { r.status === 'Waiting' ? fsiEnd_(r, 'Dropped', why) : fsiEnd_(r, 'Stopped', why, true); }
    catch (e) { fsiErr_('stopping ' + r.mls + ': ' + e.message); }
  });
}

/* ------------------------------------------------------------- replies -- */

function fsiReadReplies_() {
  const props = PropertiesService.getScriptProperties();
  let seen = [];
  try { seen = JSON.parse(props.getProperty('FSI_REPLY_SEEN') || '[]'); } catch (e) {}
  const news = [], sh = fsiTab_();

  FSI_CAMPAIGNS.forEach((cid, i) => {
    const slot = i + 1, key = 'FSI_REPLY_SINCE_' + slot;
    const since = props.getProperty(key) || (slot === 1 ? props.getProperty('FSI_REPLY_SINCE') || '' : '');
    const res = fsiApi_('get', '/emails?campaign_id=' + cid + '&email_type=received&sort_order=desc&limit=100');
    const items = (res && res.items || []).filter(m => (!since || String(m.timestamp_email || m.timestamp_created) >= since) && seen.indexOf(m.id) < 0);
    if (!items.length) return;
    items.slice().reverse().forEach(m => {                   // oldest first
      const from = String(m.lead || m.from_address_email || '').toLowerCase();
      const rows = fsiRows_();
      // the house this thread is about: same agent, same campaign, newest first
      const mine = rows.filter(x => x.email === from && (x.slot || 1) === slot);
      const r = mine.filter(x => x.status === 'Emailing').pop() || mine.filter(x => x.status !== 'Stopped').pop() || mine.pop();
      if (!r) return;                                        // not one of ours
      const when = new Date(m.timestamp_email || m.timestamp_created || Date.now());
      const text = fsiStripQuote_((m.body && (m.body.text || fsiHtmlText_(m.body.html))) || m.content_preview || '');
      const due = fsiReplyDue_(text, when);
      const juan = fsiNeedsJuan_(text, due, when);
      sh.getRange(r.row, C.status, 1, 5).setValues([['Replied', when, due || r.agentDue || '', juan || '', text.slice(0, 1500)]]);
      r.status = 'Replied';
      // Juan is talking to this agent now: pause their other houses
      const paused = [];
      rows.filter(x => x.email === from && x.row !== r.row && (x.status === 'Emailing' || x.status === 'Waiting')).forEach(x => {
        try {
          x.status === 'Waiting' ? fsiEnd_(x, 'Paused', 'Agent replied about ' + fsiShort_(r.addr))
                                 : fsiEnd_(x, 'Paused', 'Agent replied about ' + fsiShort_(r.addr), true);
          paused.push(fsiShort_(x.addr));
        } catch (e) { fsiErr_('pausing ' + x.mls + ': ' + e.message); }
      });
      news.push({ r, text, due, juan, paused });
    });
    const newest = items.map(m => String(m.timestamp_email || m.timestamp_created || '')).sort().pop();
    props.setProperty(key, newest || since);
    seen = seen.concat(items.map(m => m.id)).slice(-300);
  });
  props.setProperty('FSI_REPLY_SEEN', JSON.stringify(seen));
  if (news.length) {
    try { fsPost_(fsiChat_(news)); } catch (e) { fsiErr_('Chat: ' + e.message); }
  }
  return news.length;
}

function fsiChat_(news) {
  const juan = news.filter(n => n.juan).length;
  const head = (juan ? '🚨 *FLIPSCOUT NEEDS JUAN — AGENT REPLIED*' : '📬 *FLIPSCOUT — AGENT REPLIED*') +
               (news.length > 1 ? ' (' + news.length + ')' : '');
  return head + '\n\n' + news.map(n => {
    const r = n.r, test = fsiIsTest_(r.mls);
    return [
      (test ? '🧪 TEST — ' : '') + '*' + r.addr + '*',
      (r.agent || 'Agent') + ' <' + r.email + '>',
      '“' + (n.text.length > 220 ? n.text.slice(0, 217).trim() + '…' : n.text) + '”',
      n.due ? '⏰ Offers due: *' + n.due + '* (read from the reply — confirm)' : '',
      n.juan ? '🚨 ' + n.juan : '',
      n.paused.length ? '⏸ Paused emails about ' + n.paused.join(', ') + ' — Juan is talking to this agent' : '',
      test ? '' : 'MLS: https://www.mlslistings.com/Property/' + r.mls
    ].filter(Boolean).join('\n');
  }).join('\n\n') + '\n\nReply from Instantly → Unibox: https://app.instantly.ai/app/unibox';
}

// The agent's date goes into Offer Due when the MLS gave none (blank / TBD),
// and back in whenever the app's Refresh blanks it again.
function fsiReheal_() {
  const want = {};
  fsiRows_().forEach(r => { if (r.agentDue && fsiDeadline_(r.agentDue)) want[r.mls] = r.agentDue; });
  if (!Object.keys(want).length) return;
  const sh = SpreadsheetApp.getActive().getSheetByName(FS_LEADS);
  const v = sh.getDataRange().getDisplayValues(), head = v[0].map(h => String(h).trim());
  const iM = head.indexOf('MLS #'), iD = head.indexOf('Offer Due');
  if (iM < 0 || iD < 0) return;
  for (let i = 1; i < v.length; i++) {
    const mls = String(v[i][iM]).trim().toUpperCase(), cur = String(v[i][iD]).trim();
    if (want[mls] && (!cur || /^TBD$/i.test(cur)) && cur !== want[mls]) sh.getRange(i + 1, iD + 1).setValue(want[mls]);
  }
}

/* ----------------------------------------------------- reading a reply -- */

// Only what the agent wrote, not our email quoted underneath.
function fsiStripQuote_(t) {
  const s = String(t || '').replace(/\r/g, '');
  const cut = s.search(/\n\s*On [^\n]{5,200}(?:\n[^\n]{0,120})?wrote:|\n\s*>|\n-{2,}\s*Original Message|\nFrom:\s|\n_{5,}/i);
  return (cut >= 0 ? s.slice(0, cut) : s).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}

function fsiHtmlText_(h) {
  return String(h || '').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

// "2026-09-28 (Mon) 5:00 PM", "2026-09-28 (Mon)", "TBD" or "".
// The MLS rules first ("Offers due 9/28 by 5pm"); then, because the agent is
// answering "when are offers due?", a short reply that just names a day
// ("Monday at 5pm", "tomorrow by noon") counts too.
function fsiReplyDue_(text, when) {
  const t = String(text || ''), now = when || new Date();
  FSI_CUE.lastIndex = 0;
  let m;
  while ((m = FSI_CUE.exec(t))) {
    const w = t.slice(m.index, m.index + 110);
    const d = fsiFindDate_(w, now);
    if (d) return d + fsiFindTime_(w);
    if (/\bT\.?B\.?D\b|to be determined|to be announced|\bTBA\b|no (?:offer )?(?:date|deadline) (?:yet|set)/i.test(w.slice(0, 60))) return 'TBD';
  }
  const head = t.slice(0, 400);
  if (/\b(?:no (?:offer )?(?:date|deadline) (?:yet|set)|as they come in|T\.?B\.?D)\b/i.test(head)) return 'TBD';
  const d = fsiFindDate_(head, now), tm = fsiFindTime_(head);
  if (d && (tm || /\b(?:due|deadline|by|offers?)\b/i.test(head))) return d + tm;
  return '';
}

function fsiFindDate_(w, now) {
  const pad = n => ('0' + n).slice(-2);
  const fmt = dt => dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate()) +
                    ' (' + ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getDay()] + ')';
  // "today" in Pacific, as a plain calendar date
  const p = Utilities.formatDate(now, FSI_TZ, 'yyyy-M-d').split('-').map(Number);
  const base = new Date(p[0], p[1] - 1, p[2]);
  const num = w.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  const word = w.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s*(\d{4}))?/i);
  const first = [num, word].filter(Boolean).sort((a, b) => a.index - b.index)[0];
  if (first) {
    let mo, d, y;
    if (first === num) { mo = +num[1]; d = +num[2]; y = num[3] ? +num[3] : 0; }
    else { mo = FSI_MO.indexOf(word[1].slice(0, 3).toLowerCase()) + 1; d = +word[2]; y = word[3] ? +word[3] : 0; }
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
    if (y && y < 100) y += 2000;
    if (!y) { y = base.getFullYear(); if (new Date(y, mo - 1, d) < new Date(base.getTime() - 60 * 864e5)) y++; }
    return fmt(new Date(y, mo - 1, d));
  }
  if (/\btoday\b|\btonight\b/i.test(w)) return fmt(base);
  if (/\btomorrow\b/i.test(w)) return fmt(new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1));
  const wd = w.match(/\b(sun|mon|tue|wed|thu|fri|sat)(?:day|sday|nesday|rsday|urday)?\b\.?/i);
  if (wd) {
    const target = FSI_WD.indexOf(wd[1].toLowerCase());
    let add = (target - base.getDay() + 7) % 7;
    if (add === 0) add = 7;                                  // "Monday", said on a Monday, means next Monday
    return fmt(new Date(base.getFullYear(), base.getMonth(), base.getDate() + add));
  }
  return '';
}

function fsiFindTime_(w) {
  if (/\bnoon\b/i.test(w)) return ' 12:00 PM';
  if (/\bmidnight\b/i.test(w)) return ' 12:00 AM';
  const tm = w.match(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\b\.?/i);
  return tm ? ' ' + (+tm[1]) + ':' + (tm[2] || '00') + ' ' + tm[3].toUpperCase() + 'M' : '';
}

function fsiNeedsJuan_(text, due, when) {
  const m = FSI_JUAN.exec(text || '');
  if (m) return 'says “' + m[0] + '”';
  const d = fsiDeadline_(due);
  if (d && d - when < 24 * 36e5) return 'offers due in under 24 hours';
  return '';
}

/* -------------------------------------------------------------- helpers -- */

function fsiApi_(method, path, body) {
  const key = fsiProp_('INSTANTLY_API_KEY');
  if (!key) throw new Error('INSTANTLY_API_KEY is missing — add it under Project Settings → Script Properties.');
  const opt = { method, muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + key } };
  if (body) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(body); }
  for (let attempt = 0; ; attempt++) {
    const res = UrlFetchApp.fetch(FSI_API + path, opt), code = res.getResponseCode();
    if (code === 429 && attempt < 2) { Utilities.sleep(20000); continue; }
    const txt = res.getContentText();
    if (code >= 300) {
      const hint = code === 401 ? ' (the API key is wrong or was deleted)' : code === 402 ? ' (Instantly says the plan has no API access)'
                 : code === 403 ? ' (the API key is missing a scope)' : '';
      throw new Error('Instantly ' + method.toUpperCase() + ' ' + path.split('?')[0] + ' → ' + code + hint + ': ' + txt.slice(0, 200));
    }
    return txt ? JSON.parse(txt) : {};
  }
}

function fsiLeads_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(FS_LEADS);
  const v = sh.getDataRange().getDisplayValues(), head = v[0].map(h => String(h).trim());
  const get = (r, n) => { const i = head.indexOf(n); return i < 0 ? '' : String(r[i] || '').trim(); };
  return v.slice(1).map(r => {
    const e = get(r, 'Agent Email').split(/[\s,;]+/).find(x => FSI_EMAIL.test(x));
    return { mls: get(r, 'MLS #').toUpperCase(), addr: get(r, 'Address'), notes: get(r, 'Notes'),
             bucket: get(r, 'Bucket'), score: get(r, 'Opportunity Score'), due: get(r, 'Offer Due'),
             mstat: get(r, 'MLS Status'), agent: get(r, 'Listing Agent').split(',')[0].trim(),
             email: e ? e.toLowerCase() : '' };
  }).filter(l => l.mls);
}

function fsiRows_() {
  return fsiTab_().getDataRange().getValues().slice(1).map((r, i) => ({
    row: i + 2, added: r[0], mls: String(r[1]).trim().toUpperCase(), addr: String(r[2]), agent: String(r[3]),
    email: String(r[4]).trim().toLowerCase(), status: String(r[5]), agentDue: String(r[7] || ''), id: String(r[12] || ''),
    // rows from before the three campaigns have no Campaign cell: they were all in campaign 1
    slot: +r[14] || (r[12] ? 1 : 0)
  })).filter(r => r.mls);
}

function fsiTab_() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(FSI_TAB) || ss.insertSheet(FSI_TAB);
  const cur = sh.getRange(1, 1, 1, FSI_HEAD.length).getValues()[0];
  if (cur.join('|') !== FSI_HEAD.join('|')) {
    sh.getRange(1, 1, 1, FSI_HEAD.length).setValues([FSI_HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

// "2026-09-30 (Wed) 12:00 PM" / "2026-09-30 (Wed)" → Date (Pacific); else null
function fsiDeadline_(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:\s*\(\w+\))?(?:\s+(\d{1,2}):(\d{2}) ([AP])M)?/.exec(v || '');
  if (!m) return null;
  let h = 23, mi = 59;
  if (m[4]) { h = (+m[4] % 12) + (m[6] === 'P' ? 12 : 0); mi = +m[5]; }
  const iso = m[1] + '-' + m[2] + '-' + m[3] + 'T' + ('0' + h).slice(-2) + ':' + ('0' + mi).slice(-2) + ':00';
  return new Date(iso + Utilities.formatDate(new Date(iso + 'Z'), FSI_TZ, 'XXX'));
}

function fsiFirst_(name) {
  const w = String(name || '').replace(/\(.*?\)/g, ' ').split(/\s+/).filter(x => x && !/^[A-Z]\.?$/i.test(x));
  if (!w.length) return 'there';
  const f = w[0];
  return f === f.toUpperCase() ? f.charAt(0) + f.slice(1).toLowerCase() : f;
}

// "1908 Pennsylvania Ave, Richmond, CA 94801" → "1908 Pennsylvania Ave, Richmond"
function fsiShort_(a) {
  const p = String(a || '').split(',').map(x => x.trim()).filter(Boolean);
  return p.length >= 3 ? p[0] + ', ' + p[1] : p.join(', ').replace(/\s+\d{5}(?:-\d{4})?$/, '');
}

// off · test (only the TEST leads) · on (real A leads)
function fsiMode_() { const m = fsiProp_('FSI_AUTO'); return m === 'on' || m === 'test' ? m : 'off'; }
function fsiProp_(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }
function fsiErr_(msg) {
  Logger.log(msg);
  PropertiesService.getScriptProperties().setProperty('FSI_LAST_ERROR',
    Utilities.formatDate(new Date(), FSI_TZ, 'MMM d h:mm a') + ' — ' + String(msg).slice(0, 300));
}

function fsiLocked_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return null;                     // the other job is running; next run picks it up
  try { return fn(); }
  catch (e) { fsiErr_(e.message || e); throw e; }
  finally { lock.releaseLock(); }
}
