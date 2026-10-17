/**
 * FlipScout — "NEW LEAD" Google Chat alerts for San Francisco and the Peninsula.
 *
 * This file does ONE thing: when a new lead lands on the sheet in an area we
 * buy in, it posts it to Google Chat. Nothing here is about offer deadlines —
 * flipscout-alerts.gs already does those, and the two never overlap.
 *
 * Lives in the prod sheet ("Updated Flip Scout Agent") beside the other
 * FlipScout scripts. Everything is prefixed pn so it cannot collide with them:
 * all the .gs files in one Apps Script project share a single namespace.
 *
 * WHAT POSTS. A lead posts once, and only if ALL of these hold:
 *   - its city or county is in PN_AREAS (San Francisco + San Mateo by default);
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
 *   4. Menu → "Check now". THE FIRST RUN POSTS NOTHING — it writes down the
 *      leads already on the sheet so nobody gets a thousand messages. It will
 *      say "no message sent". That is correct.
 *
 * After that it checks EVERY HOUR, EVERY DAY, from 8:00 to 19:00 Pacific
 * (8am, 9am, 10am … 6pm — twelve checks a day). Each message is stamped with
 * the date and time it went out.
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
const PN_AREAS = ['San Francisco', 'San Mateo'];   // counties and/or cities
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
  Logger.log('New-lead alerts on. Every hour, every day, ' + PN_FROM + ':00 to ' + PN_TO + ':00 Pacific, for ' +
    pnAreas().join(' / ') + '.\nReload the sheet, then run "🆕 New Lead Alerts → Check now" ONCE: ' +
    'the first run posts nothing, it only writes down what is already on the sheet.');
}

function pnOnOpen() {
  SpreadsheetApp.getUi().createMenu('🆕 New Lead Alerts')
    .addItem('Check now', 'pnCheckNow')
    .addItem('Preview — show what would send, send nothing', 'pnPreview')
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
  const next = { day: newest, mls: all.filter(l => l.added === newest).map(l => l.mls) };
  return { fresh, next, first, areas };
}

function pnSave_(next) {
  PropertiesService.getScriptProperties().setProperty(PN_MARK_KEY, JSON.stringify(next));
}

// Returns how many leads it posted. force = ignore the working-hours window.
function pnCheck(force) {
  const hour = Number(Utilities.formatDate(new Date(), PN_TZ, 'H'));
  if (force !== true && (hour < PN_FROM || hour >= PN_TO)) return 0;

  const got = pnBuild_();
  if (got.first) {
    pnSave_(got.next);
    Logger.log('First run: wrote down the ' + got.next.mls.length + ' lead(s) pulled ' +
      got.next.day + '. Nothing posted, which is what should happen.');
    return 0;
  }
  if (!got.fresh.length) { pnSave_(got.next); return 0; }

  pnPost_(pnText_(got.fresh, got.areas));   // throws if Chat refuses, so nothing is marked posted
  pnSave_(got.next);
  Logger.log('Posted ' + got.fresh.length + ' new lead(s).');
  return got.fresh.length;
}

function pnText_(list, areas) {
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

function pnPreview() {
  const got = pnBuild_(), ui = SpreadsheetApp.getUi();
  ui.alert('New leads — preview (nothing is sent)',
    got.first
      ? 'This has never run.\n\nThe first run posts nothing: it writes down the leads already on ' +
        'the sheet so nobody gets flooded. Run "Check now" once, then the hourly check takes over.'
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
  pnPost_('🧪 *TEST — FlipScout new-lead alerts*\nWatching ' + pnAreas().join(' / ') +
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
