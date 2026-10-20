/**
 * Twin Network — "NEW LEAD" Google Chat alerts for San Francisco, the Peninsula,
 * San Jose and Oakland.
 *
 * This file does ONE thing: when a new lead lands on the sheet in an area we
 * buy in, it posts it to Google Chat. Nothing here is about offer deadlines —
 * flipscout-alerts.gs already does those, and the two never overlap.
 *
 * Lives in the prod sheet ("Updated Flip Scout Agent") beside the other
 * Twin Network scripts. Everything is prefixed pn so it cannot collide with them:
 * all the .gs files in one Apps Script project share a single namespace.
 *
 * WHAT POSTS. A lead posts once, and only if ALL of these hold:
 *   - its city or county is in PN_AREAS (San Francisco county, San Mateo
 *     county, and the cities of San Jose and Oakland by default);
 *   - MLS Status is live — not sold, withdrawn, expired, cancelled or off
 *     market, and not pending or contingent;
 *   - Notes do not start with PASS (the app's own rule, and what the Board's
 *     "Pass ↗" writes) and do not contain "no alerts";
 *   - it has a First Added date.
 *
 * SETUP, once:
 *   1. Sheet → Extensions → Apps Script → + (Files) → Script → name it
 *      "flipscout-newleads". Paste this in. Save.
 *   2. Pick pnSetup from the function dropdown and press Run. Approve the
 *      permissions it asks for.
 *   3. Reload the sheet. A "🆕 New Lead Alerts" menu appears.
 *   4. Menu → "Check now". The first run posts TODAY'S leads in our areas and
 *      quietly writes down everything older, so nobody gets a thousand
 *      messages. If nothing was pulled today it says "no message sent".
 *      Missed a day? Menu → "Post today again (catch up)".
 *
 * After that it checks EVERY HOUR, EVERY DAY, from 8:00 to 19:00 Pacific
 * (8am, 9am, 10am … 6pm — twelve checks a day). Each message is stamped with
 * the date and time it went out.
 *
 * IT POSTS EVERY SINGLE DAY, without fail. New leads the moment they land,
 * and on a day with none, one "✅ checked — nothing new" note at the first
 * check after 8am. So a morning with NO message from this script means the
 * script is broken, never that the Peninsula was quiet. If it ever does go
 * quiet for a few days, the next message it sends says so, out loud, at the
 * bottom. Menu → "Is it running? (health check)" answers it on the spot.
 *
 * THE WEBHOOK. It reuses CHAT_WEBHOOK, the Script Property your existing
 * alerts already post with, so there is nothing new to create. To send new
 * leads to a DIFFERENT space instead, add a second property PN_WEBHOOK and
 * this file uses that one. Either way the URL is a password: it lives in
 * Script Properties, never in this file and never in a chat message.
 *
 * THE AREAS. PN_AREAS below, or a Script Property PN_AREAS to change them
 * without touching code ("San Francisco, San Mateo, Palo Alto"). Entries can
 * be a COUNTY or a single CITY, so you can take all of San Mateo county and
 * just the couple of Santa Clara cities you actually want.
 * Keep it the same as the Lead Board's 🔔 → Areas, or the pop-up on the board
 * and this alert will disagree about what counts.
 */

const PN_LEADS = 'Leads';
const PN_BOARD_URL = 'https://claude.ai/artifact/HawhBkTkvpFaqz8YFLArh1';
// Counties and/or cities. 'San Francisco' and 'San Mateo' are whole COUNTIES
// (so San Mateo takes Daly City, Pacifica, Half Moon Bay and the rest of the
// Peninsula with it). 'San Jose' and 'Oakland' are single CITIES — the rest of
// Santa Clara and Alameda county stays out, so Fremont, Sunnyvale, Hayward and
// the like do not start arriving. Add a whole county by naming it instead.
const PN_AREAS = ['San Francisco', 'San Mateo', 'San Jose', 'Oakland'];
const PN_MARK_KEY = 'PN_NEW_MARK';
const PN_MAX = 8;        // leads listed in one message; the rest are counted
// The check runs every hour, all week, but only posts inside this window:
// from 8:00 up to (not including) 19:00 Pacific. So 8, 9, 10 … 18 — twelve
// checks a day, every day, and silence overnight.
const PN_FROM = 8;
const PN_TO = 19;
const PN_TZ = 'America/Los_Angeles';

const PN_CLOSED = /sold|withdrawn|expired|cancel|off.?market|closed|duplicate/i;
const PN_PENDING = /pending|contingent|under contract/i;
const PN_PASSED = /^\s*(?:pass\b|passing\b|passed\b|we'?re passing|rejected\b|not a (?:fit|deal))/i;

// City → county, the same list the Lead Board reads an address with.
const PN_COUNTY = (() => {
  const by = {
    'San Francisco': 'San Francisco',
    // every San Mateo county town, including the unincorporated ones the MLS
    // sometimes uses, so nothing on the Peninsula is ever read as "Other"
    'San Mateo': 'Daly City|Pacifica|South San Francisco|Redwood City|San Bruno|San Mateo|Menlo Park|East Palo Alto|Belmont|El Granada|San Carlos|Burlingame|Foster City|Millbrae|La Honda|Half Moon Bay|Woodside|Moss Beach|Montara|Atherton|Portola Valley|Brisbane|Colma|Hillsborough|Pescadero|Emerald Hills|Broadmoor|Ladera|West Menlo Park|North Fair Oaks|San Gregorio|Loma Mar|Princeton By The Sea|Palomar Park|Sharp Park|Baywood Park|Burlingame Hills|Devonshire',
    'Santa Clara': 'San Jose|Morgan Hill|Gilroy|Santa Clara|Milpitas|Campbell|Sunnyvale|Los Gatos|San Martin|Mountain View|Palo Alto|Cupertino|Saratoga|Los Altos|Monte Sereno',
    'Alameda': 'Oakland|Berkeley|San Leandro|Hayward|Fremont|Livermore|Union City|Castro Valley|Newark|Albany|Alameda|Dublin|Pleasanton|Sunol|San Lorenzo|Emeryville|Piedmont',
    'Contra Costa': 'Richmond|Antioch|Pittsburg|Concord|Martinez|Pleasant Hill|Oakley|Walnut Creek|Orinda|Brentwood|Lafayette|Clayton|Discovery Bay|San Pablo|El Sobrante|El Cerrito|Pacheco|San Ramon|North Richmond|Moraga|Danville|Pinole|Bay Point|Kensington|Hercules|Rodeo|Crockett|Byron|Knightsen|Alamo',
    'Marin': 'San Rafael|Mill Valley|Novato|San Anselmo|Fairfax|Bolinas|Larkspur|Corte Madera|Woodacre|Sausalito|Tiburon|Greenbrae|Kentfield|Point Reyes Station|Inverness|Stinson Beach|Forest Knolls|Lagunitas',
    'Sonoma': 'Santa Rosa|Sebastopol|Petaluma|Guerneville|Sonoma|Cloverdale|Rohnert Park|Healdsburg|Windsor|Cotati|Occidental|Monte Rio|Forestville|Glen Ellen|Timber Cove|The Sea Ranch|Bodega Bay|Kenwood|Geyserville|Penngrove|Cazadero|Jenner',
    'Napa': 'Napa|Saint Helena|St Helena|American Canyon|Calistoga|Yountville|Angwin',
    'Solano': 'Vallejo|Vacaville|Fairfield|Suisun City|Dixon|Benicia|Rio Vista|Winters'
  };
  const map = {};
  Object.keys(by).forEach(c => by[c].split('|').forEach(t => { map[t.toLowerCase()] = c; }));
  return map;
})();

/* ------------------------------------------------------------- setup ---- */

function pnSetup() {
  ScriptApp.getProjectTriggers()
    .filter(t => ['pnCheck', 'pnOnOpen'].indexOf(t.getHandlerFunction()) >= 0)
    .forEach(t => ScriptApp.deleteTrigger(t));
  // flip-scout-reject.gs owns the sheet's own onOpen, so this menu arrives
  // through an installable trigger instead
  ScriptApp.newTrigger('pnOnOpen').forSpreadsheet(SpreadsheetApp.getActive()).onOpen().create();
  ScriptApp.newTrigger('pnCheck').timeBased().everyHours(1).create();
  if (!pnWebhook_()) {
    throw new Error('Trigger is on, but no webhook is set. Add CHAT_WEBHOOK (or PN_WEBHOOK) ' +
      'under Project Settings → Script Properties.');
  }
  const on = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'pnCheck').length;
  if (!on) throw new Error('The hourly trigger did not get created. Run pnSetup again.');
  Logger.log('New-lead alerts on. Every hour, every day, ' + PN_FROM + ':00 to ' + PN_TO + ':00 Pacific, for ' +
    pnAreas().join(' / ') + '.\nIt posts EVERY day — the new leads, or a "nothing new" note.' +
    '\nReload the sheet, then run "🆕 New Lead Alerts → Check now" ONCE.');
}

function pnOnOpen() {
  SpreadsheetApp.getUi().createMenu('🆕 New Lead Alerts')
    .addItem('Check now', 'pnCheckNow')
    .addItem('Preview — show what would send, send nothing', 'pnPreview')
    .addItem('Post today again (catch up)', 'pnCatchUp')
    .addItem('Is it running? (health check)', 'pnHealth')
    .addSeparator()
    .addItem('Which areas?', 'pnShowAreas')
    .addItem('Send test message', 'pnTest')
    .addToUi();
}

/* -------------------------------------------------------------- areas --- */

function pnAreas() {
  const raw = PropertiesService.getScriptProperties().getProperty('PN_AREAS');
  if (!raw) return PN_AREAS.slice();
  const list = raw.split(',').map(s => s.trim()).filter(Boolean);
  return list.length ? list : PN_AREAS.slice();
}

// "1420 Guerrero Street, San Francisco, CA 94110" -> "San Francisco"
function pnCityOf_(addr) {
  const m = /,\s*([^,]+?),\s*CA\b/i.exec(String(addr || ''));
  return m ? m[1].trim().replace(/\b\w/g, c => c.toUpperCase()) : '';
}
function pnCountyOf_(addr) { return PN_COUNTY[pnCityOf_(addr).toLowerCase()] || 'Other'; }

// An area in the list may name a county or a single city, so the Peninsula can
// be "all of San Mateo county" plus whichever Santa Clara cities you want.
function pnWatched_(addr, areas) {
  const city = pnCityOf_(addr), county = pnCountyOf_(addr);
  return areas.some(a => a === county || a.toLowerCase() === city.toLowerCase());
}

/* -------------------------------------------------------------- reading -- */

function pnReadLeads_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(PN_LEADS);
  if (!sh) throw new Error('This spreadsheet has no "' + PN_LEADS + '" tab.');
  const values = sh.getDataRange().getDisplayValues();
  const head = values[0].map(h => String(h).trim());
  const need = ['MLS #', 'Address', 'Notes', 'MLS Status', 'First Added'];
  const missing = need.filter(n => head.indexOf(n) < 0);
  if (missing.length) throw new Error('The Leads tab is missing these columns: ' + missing.join(', '));
  const get = (row, name) => { const i = head.indexOf(name); return i < 0 ? '' : String(row[i] || '').trim(); };
  return values.slice(1).filter(r => get(r, 'MLS #')).map(r => ({
    mls: get(r, 'MLS #').toUpperCase(),
    addr: get(r, 'Address'),
    notes: get(r, 'Notes'),
    mstat: get(r, 'MLS Status'),
    added: get(r, 'First Added').slice(0, 10),
    bucket: get(r, 'Bucket'),
    score: get(r, 'Opportunity Score'),
    due: get(r, 'Offer Due'),
    price: get(r, 'Purchase Price').replace(/[^0-9.]/g, ''),
    ppsf: get(r, '$/SqFt').replace(/[^0-9.]/g, ''),
    beds: get(r, 'Beds'),
    sqft: get(r, 'SqFt'),
    // the whole "Name, Brokerage" the sheet holds, not just the name
    agent: get(r, 'Listing Agent'),
    phone: get(r, 'Agent Phone')
  }));
}

/* ------------------------------------------------------------- the check -- */

// What would post right now. Also returns what to remember afterwards.
function pnBuild_() {
  const areas = pnAreas();
  let mark = {};
  try { mark = JSON.parse(PropertiesService.getScriptProperties().getProperty(PN_MARK_KEY) || '{}') || {}; } catch (e) { mark = {}; }
  const first = !mark.day;
  const already = {};
  (Array.isArray(mark.mls) ? mark.mls : []).forEach(m => { already[m] = 1; });

  const all = pnReadLeads_();
  let newest = mark.day || '';
  const fresh = [];
  all.forEach(l => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(l.added)) return;        // no pull date: nothing to go on
    if (l.added > newest) newest = l.added;
    // a day we have already worked through, or a lead from that day we posted
    if (mark.day && (l.added < mark.day || (l.added === mark.day && already[l.mls]))) return;
    if (!pnWatched_(l.addr, areas)) return;
    if (PN_CLOSED.test(l.mstat) || PN_PENDING.test(l.mstat)) return;
    if (PN_PASSED.test(l.notes) || /no alerts/i.test(l.notes)) return;
    fresh.push(l);
  });
  fresh.sort((a, b) => (a.added < b.added ? 1 : a.added > b.added ? -1 : 0));

  // What gets remembered: the newest pull date, and the MLS numbers on that
  // date only. A Script Property value stops at 9 KB, so the whole sheet
  // would not fit — one day's worth always does, and it resets by itself.
  // said = the last day a message went out, so the daily "all quiet" note
  // fires once a day and not once an hour.
  const next = { day: newest, mls: all.filter(l => l.added === newest).map(l => l.mls), said: mark.said || '' };
  return { fresh, next, first, areas, said: mark.said || '' };
}

function pnSave_(next) {
  PropertiesService.getScriptProperties().setProperty(PN_MARK_KEY, JSON.stringify(next));
}

// Returns how many leads it posted. force = ignore the working-hours window.
function pnCheck(force) {
  const hour = Number(Utilities.formatDate(new Date(), PN_TZ, 'H'));
  if (force !== true && (hour < PN_FROM || hour >= PN_TO)) return 0;

  const today = pnToday_();
  const got = pnBuild_();

  // Every post below happens BEFORE pnSave_, so if Chat refuses the message
  // nothing is written down and the next hourly check tries the same leads again.

  if (got.first) {
    // Never run before. The whole sheet looks new, and nobody wants a thousand
    // messages — so everything older than today is written down silently.
    // TODAY'S leads still post: the day you switch this on is the day you most
    // want to hear about, and the hour before you installed it still counts.
    const todays = got.fresh.filter(l => l.added === today);
    pnPost_(todays.length ? pnText_(todays, got.areas) : pnQuiet_(got.areas, ''));
    got.next.said = today;
    pnSave_(got.next);
    Logger.log('First run: wrote down the ' + got.next.mls.length + ' lead(s) pulled ' +
      got.next.day + ', and posted the ' + todays.length + ' from today.');
    return todays.length;
  }

  if (got.fresh.length) {
    pnPost_(pnText_(got.fresh, got.areas, got.said));
    got.next.said = today;
    pnSave_(got.next);
    Logger.log('Posted ' + got.fresh.length + ' new lead(s).');
    return got.fresh.length;
  }

  // Nothing new today. Say so anyway, once per day, on the first check after
  // 8am. That is the whole point: a day with no message from this script now
  // means the script is BROKEN, not that the Peninsula was quiet. If Chat is
  // silent one morning, something needs fixing — you never have to wonder.
  if (got.said !== today) {
    pnPost_(pnQuiet_(got.areas, got.said));
    got.next.said = today;
    Logger.log('Nothing new. Posted the daily all-clear.');
  }
  pnSave_(got.next);
  return 0;
}

// The daily "checked, nothing new" note.
function pnQuiet_(areas, said) {
  return '✅ *Twin Network checked — nothing new in ' + areas.join(' / ') + '*' +
    '\n🗓 ' + Utilities.formatDate(new Date(), PN_TZ, 'EEE, MMM d yyyy · h:mm a') +
    '\nNo new listings in our areas since the last check.' + pnGap_(said) +
    '\n\nBoard: ' + PN_BOARD_URL;
}

// Warns in the message itself when the script has not spoken for a while —
// so a stopped trigger announces itself the moment it starts again.
function pnGap_(said) {
  if (!said) return '';
  const a = new Date(said + 'T12:00:00Z'), b = new Date(pnToday_() + 'T12:00:00Z');
  const days = Math.round((b - a) / 86400000);
  return days > 1
    ? '\n\n⚠️ Heads up: the last message was ' + pnDay_(said) + ', ' + days +
      ' days ago. The hourly trigger stopped and has only just started again — ' +
      'check Extensions → Apps Script → ⏰ Triggers.'
    : '';
}

function pnText_(list, areas, said) {
  // The sheet stores these as numbers, and a column can come through as
  // "2634.0" or "2,634" depending on how it is formatted. Read the number and
  // print it ourselves, so a bed count never reads "4.0 bd".
  const num = v => {
    const s = String(v == null ? '' : v).replace(/[^0-9.\-]/g, '');
    const n = Number(s);
    return s !== '' && isFinite(n) ? n : null;
  };
  const show = v => { const n = num(v); return n === null ? '' : n.toLocaleString('en-US'); };
  const money = v => { const n = num(v); return n ? '$' + n.toLocaleString('en-US') : ''; };
  const blocks = list.slice(0, PN_MAX).map(l => {
    const facts = [
      money(l.price),
      num(l.ppsf) ? '$' + Math.round(num(l.ppsf)).toLocaleString('en-US') + '/sqft' : '',
      show(l.sqft) ? show(l.sqft) + ' sqft' : '',
      show(l.beds) ? show(l.beds) + ' bd' : '',
      l.bucket ? l.bucket.charAt(0).toUpperCase() + (show(l.score) ? ' ' + show(l.score) : '') : '',
      /^active$/i.test(l.mstat) ? '' : l.mstat          // say it when it is not plain Active
    ].filter(Boolean).join(' · ');
    // The agent is stored as "Name, Brokerage"; only the first comma is
    // swapped, so a brokerage with commas of its own stays intact.
    const agent = l.agent ? l.agent.replace(/,\s*/, ' · ') : '';
    // The day the lead reached the sheet, said only when it is not today —
    // a message sent after a quiet spell can carry yesterday's leads too.
    const pulled = l.added && l.added !== pnToday_() ? '\n📅 Pulled ' + pnDay_(l.added) : '';
    return '*' + l.addr + '*' +                         // the whole address, street through zip
      pulled +
      (facts ? '\n' + facts : '') +
      (l.due && !/^T\.?B\.?D/i.test(l.due) ? '\n⏰ Offers due ' + l.due : '') +
      (agent ? '\n👤 ' + agent : '') +
      // said out loud when missing: about one lead in four has no phone on the
      // sheet, and a silently absent line reads as "no agent to call"
      (l.phone ? '\n📞 ' + l.phone : agent ? '\n📞 no phone on the sheet — see the Board' : '') +
      (!agent && !l.phone ? '\n👤 No agent details on the sheet — see the Board' : '') +
      '\nMLS: https://www.mlslistings.com/Property/' + l.mls;
  });
  const rest = list.length - blocks.length;
  // The date and time this went out, so a message in the space is never
  // ambiguous about which day it is reporting on.
  const stamp = Utilities.formatDate(new Date(), PN_TZ, 'EEE, MMM d yyyy · h:mm a');
  return '🆕 *NEW IN ' + areas.join(' / ').toUpperCase() + '* — ' +
    list.length + (list.length === 1 ? ' lead' : ' leads') + '\n' +
    '🗓 ' + stamp + '\n\n' +
    blocks.join('\n\n') +
    (rest ? '\n\n+' + rest + ' more — see the Board' : '') +
    pnGap_(said) +
    '\n\nBoard: ' + PN_BOARD_URL;
}

// Today in Pacific, as "2026-10-17" — the same shape First Added uses.
function pnToday_() { return Utilities.formatDate(new Date(), PN_TZ, 'yyyy-MM-dd'); }

// "2026-10-16" -> "Thu, Oct 16". Read at midday so the day never slips a zone.
function pnDay_(iso) {
  const d = new Date(String(iso).slice(0, 10) + 'T12:00:00Z');
  return isNaN(d) ? String(iso) : Utilities.formatDate(d, 'UTC', 'EEE, MMM d');
}

/* --------------------------------------------------------------- menu ---- */

function pnCheckNow() {
  const n = pnCheck(true);
  const areas = pnAreas().join(' / ');
  SpreadsheetApp.getActive().toast(
    n ? 'Sent 1 message to Google Chat with ' + n + (n === 1 ? ' new lead.' : ' new leads.')
      : 'Nothing new in ' + areas + ' — no message sent.',
    '🆕 New Lead Alerts', 6);
}

// Is this thing actually on? Answers the only question that matters when
// Chat has been quiet: is there an hourly trigger, is there a webhook, and
// when did it last say anything.
function pnHealth() {
  const ui = SpreadsheetApp.getUi();
  const trig = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'pnCheck');
  let mark = {};
  try { mark = JSON.parse(PropertiesService.getScriptProperties().getProperty(PN_MARK_KEY) || '{}') || {}; } catch (e) {}
  const p = PropertiesService.getScriptProperties();
  const which = p.getProperty('PN_WEBHOOK') ? 'PN_WEBHOOK (its own space)'
    : p.getProperty('CHAT_WEBHOOK') ? 'CHAT_WEBHOOK (shared with the deadline alerts)'
      : 'NONE — nothing can be sent';
  const lines = [
    (trig.length ? '\u2705' : '\u274C') + ' Hourly trigger: ' + (trig.length ? 'on' : 'MISSING — run pnSetup'),
    (which.indexOf('NONE') < 0 ? '\u2705' : '\u274C') + ' Webhook: ' + which,
    (mark.said ? '\u2705' : '\u274C') + ' Last message: ' + (mark.said ? pnDay_(mark.said) : 'never'),
    '     Last pull date it has seen: ' + (mark.day || 'none'),
    '     Watching: ' + pnAreas().join(' / '),
    '     Posting hours: ' + PN_FROM + ':00 to ' + PN_TO + ':00 Pacific, every day'
  ];
  ui.alert('New-lead alerts — health check', lines.join('\n') +
    '\n\nThis script posts to Chat EVERY DAY: either the new leads, or a ' +
    '"nothing new" note. A day with no message at all means it is broken.',
    ui.ButtonSet.OK);
}

// Forget everything this has posted and treat the sheet as brand new, so
// today's leads in our areas go out again. For the day it was installed and
// swallowed them, or any time Chat missed a day.
function pnCatchUp() {
  PropertiesService.getScriptProperties().deleteProperty(PN_MARK_KEY);
  const n = pnCheck(true);
  SpreadsheetApp.getActive().toast(
    n ? 'Posted ' + n + ' lead' + (n === 1 ? '' : 's') + ' from today to Google Chat.'
      : 'No leads pulled today in ' + pnAreas().join(' / ') + ' — nothing sent.',
    '🆕 New Lead Alerts', 6);
}

function pnPreview() {
  const got = pnBuild_(), ui = SpreadsheetApp.getUi();
  ui.alert('New leads — preview (nothing is sent)',
    got.first
      ? 'This has never run.\n\nThe first run posts TODAY\u2019s leads in our areas and quietly ' +
        'writes down everything older, so nobody gets flooded. Run "Check now" once, then the ' +
        'hourly check takes over.'
      : got.fresh.length
        ? pnText_(got.fresh, got.areas).replace(/\*/g, '')
        : 'Nothing new in ' + got.areas.join(' / ') + ' since the last check.',
    ui.ButtonSet.OK);
}

function pnShowAreas() {
  const ui = SpreadsheetApp.getUi(), areas = pnAreas(), leads = pnReadLeads_();
  const counts = {};
  leads.forEach(l => { const c = pnCountyOf_(l.addr); counts[c] = (counts[c] || 0) + 1; });
  const lines = Object.keys(counts).sort((a, b) => counts[b] - counts[a])
    .map(c => (areas.indexOf(c) >= 0 ? '  ✓ ' : '     ') + c + ' — ' + counts[c] + ' leads');
  const watched = leads.filter(l => pnWatched_(l.addr, areas)).length;
  ui.alert('New-lead alerts go out for:',
    areas.join(', ') + '\n' + watched + ' of the ' + leads.length + ' leads on the sheet are in them.\n\n' +
    'Every county on the sheet:\n' + lines.join('\n') +
    '\n\nTo change them: Extensions → Apps Script → ⚙ Project Settings → Script Properties → ' +
    'PN_AREAS = a comma-separated list. A county takes the whole county; a single city takes ' +
    'just that city, e.g. "San Francisco, San Mateo, Palo Alto".\n\n' +
    'Keep it the same as the Lead Board’s 🔔 → Areas.',
    ui.ButtonSet.OK);
}

function pnTest() {
  pnPost_('🧪 *TEST — Twin Network new-lead alerts*\nWatching ' + pnAreas().join(' / ') +
    '.\n🗓 ' + Utilities.formatDate(new Date(), PN_TZ, 'EEE, MMM d yyyy · h:mm a') +
    '\nNew leads post here every hour, every day, from ' + PN_FROM + ':00 to ' + PN_TO + ':00 Pacific.' +
    '\n\nBoard: ' + PN_BOARD_URL);
  SpreadsheetApp.getActive().toast('Test message sent to Google Chat.', '🆕 New Lead Alerts', 5);
}

/* ------------------------------------------------------------- posting --- */

// Reuses the webhook the other alerts already post with; PN_WEBHOOK overrides
// it when new leads should go to a different space.
function pnWebhook_() {
  const p = PropertiesService.getScriptProperties();
  return p.getProperty('PN_WEBHOOK') || p.getProperty('CHAT_WEBHOOK') || '';
}

function pnPost_(text) {
  const hook = pnWebhook_();
  if (!hook) {
    throw new Error('No webhook set. Add CHAT_WEBHOOK (or PN_WEBHOOK, for a different space) ' +
      'under Project Settings → Script Properties.');
  }
  const res = UrlFetchApp.fetch(hook, {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    payload: JSON.stringify({ text: text }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('Google Chat refused the message: ' + res.getResponseCode() + ' ' +
      res.getContentText().slice(0, 200));
  }
}
