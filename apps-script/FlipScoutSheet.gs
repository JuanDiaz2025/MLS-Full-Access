/**
 * Flip Scout — sheet-side menu + auto-refresh for the "Property Review" tab.
 *
 * Adds a "Flip Scout" menu with:
 *   • Refresh Now              — pull new leads from the feed, append (dedup + skip rejected)
 *   • Resync Existing Leads    — refresh numbers/risks on rows already here (keeps First Added)
 *   • Enable Hourly Auto-Refresh  — installs a 1-hour time trigger that runs Refresh Now
 *   • Disable Hourly Auto-Refresh
 *   • Show KPI Tab
 *
 * Leads come from CONFIG.FEED_URL — a JSON endpoint returning either
 *   [ {lead}, {lead}, ... ]   or   { "leads": [ {lead}, ... ] }
 * where each {lead} is keyed by the sheet's column headers
 * (Score, Recommendation, Address, ... Redfin Link, Flip Quality, ...).
 * Dedup is by Redfin Link, against both existing rows and the Rejected tab.
 */
const CONFIG = {
  SHEET_GID: 1510205894,                 // Property Review tab
  FEED_URL: 'PASTE_YOUR_LEADS_FEED_URL_HERE',  // raw JSON of investigated leads
  REJECT_TAB_MATCH: 'reject',            // any tab whose name contains this holds rejected Redfin URLs
  KPI_TAB: 'KPI',
};

const MONEY_COLS = [
  'Purchase Price', 'Estimated ARV', 'Rehab Cost (Light)', 'Rehab Cost (Heavy)',
  'Holding Costs (3mo)', 'Total Cost (Light)', 'Total Cost (Heavy)',
  'Gross Profit (Light)', 'Gross Profit (Heavy)',
];
// Columns overwritten on Resync (everything except identity + First Added + human notes).
const RESYNC_COLS = [
  'Score', 'Recommendation', 'Beds', 'Baths', 'SqFt', 'Lot SqFt', 'Year Built',
  'Purchase Price', 'Estimated ARV', 'Rehab Cost (Light)', 'Rehab Cost (Heavy)',
  'Holding Costs (3mo)', 'Total Cost (Light)', 'Total Cost (Heavy)',
  'Gross Profit (Light)', 'Gross Profit (Heavy)', 'Risks', 'Flip Quality',
];

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Flip Scout')
    .addItem('Refresh Now', 'refreshNow')
    .addItem('Resync Existing Leads', 'resyncExisting')
    .addSeparator()
    .addItem('Enable Hourly Auto-Refresh', 'enableHourly')
    .addItem('Disable Hourly Auto-Refresh', 'disableHourly')
    .addSeparator()
    .addItem('Show KPI Tab', 'showKpi')
    .addToUi();
}

/* ---------- menu actions ---------- */

function refreshNow() {
  const feed = fetchFeed_();
  const sheet = getSheet_();
  const h = findHeader_(sheet);
  const have = existingLinks_(sheet, h);        // Redfin links already in the tab
  const rejected = rejectedLinks_();            // Redfin links on the Rejected tab
  let added = 0, skipped = 0;
  feed.forEach(lead => {
    const link = String(lead['Redfin Link'] || '').trim();
    if (link && (have.has(link) || rejected.has(link))) { skipped++; return; }
    appendLead_(sheet, h, lead);
    if (link) have.add(link);
    added++;
  });
  toast_(`Refresh: +${added} new, ${skipped} skipped (dup/rejected).`);
}

function resyncExisting() {
  const feed = fetchFeed_();
  const byLink = {};
  feed.forEach(l => { const k = String(l['Redfin Link'] || '').trim(); if (k) byLink[k] = l; });
  const sheet = getSheet_();
  const h = findHeader_(sheet);
  const last = sheet.getLastRow();
  if (last <= h.headerRow) { toast_('No rows to resync.'); return; }
  const width = Math.max.apply(null, Object.values(h.colIndex)) + 1;
  const rng = sheet.getRange(h.headerRow + 1, 1, last - h.headerRow, width);
  const rows = rng.getValues();
  const linkCol = h.colIndex['Redfin Link'];
  let updated = 0;
  rows.forEach(row => {
    const link = String(row[linkCol] || '').trim();
    const lead = byLink[link];
    if (!lead) return;
    const d = Object.assign({}, lead); computeDerived_(d);
    RESYNC_COLS.forEach(c => {
      if (h.colIndex[c] != null && d[c] != null && d[c] !== '')
        row[h.colIndex[c]] = MONEY_COLS.indexOf(c) >= 0 ? num_(d[c]) : d[c];
    });
    updated++;
  });
  rng.setValues(rows);
  toast_(`Resynced ${updated} existing row(s). First Added preserved.`);
}

function enableHourly() {
  disableHourly();
  ScriptApp.newTrigger('refreshNow').timeBased().everyHours(1).create();
  toast_('Hourly auto-refresh ENABLED (runs Refresh Now every hour).');
}
function disableHourly() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'refreshNow') ScriptApp.deleteTrigger(t);
  });
  toast_('Hourly auto-refresh disabled.');
}

function showKpi() {
  const ss = SpreadsheetApp.getActive();
  const kpi = ss.getSheetByName(CONFIG.KPI_TAB);
  if (kpi) ss.setActiveSheet(kpi); else toast_('No "' + CONFIG.KPI_TAB + '" tab found.');
}

/* ---------- helpers ---------- */

function fetchFeed_() {
  if (!CONFIG.FEED_URL || CONFIG.FEED_URL.indexOf('http') !== 0)
    throw new Error('Set CONFIG.FEED_URL to your leads JSON endpoint first.');
  const res = UrlFetchApp.fetch(CONFIG.FEED_URL, { muteHttpExceptions: true, followRedirects: true });
  if (res.getResponseCode() >= 300) throw new Error('Feed fetch failed: HTTP ' + res.getResponseCode());
  const data = JSON.parse(res.getContentText() || '[]');
  const arr = Array.isArray(data) ? data : (data.leads || []);
  if (!Array.isArray(arr)) throw new Error('Feed JSON must be an array or {leads:[...]}.');
  return arr;
}

function getSheet_() {
  const ss = SpreadsheetApp.getActive();
  const byGid = ss.getSheets().filter(s => s.getSheetId() === CONFIG.SHEET_GID)[0];
  return byGid || ss.getSheets()[0];
}

function findHeader_(sheet) {
  const values = sheet.getRange(1, 1, Math.min(sheet.getLastRow() || 1, 15), sheet.getLastColumn() || 1).getValues();
  for (let r = 0; r < values.length; r++) {
    const cells = values[r].map(v => String(v).trim());
    if (cells.indexOf('Score') >= 0 && cells.indexOf('Recommendation') >= 0 && cells.indexOf('Redfin Link') >= 0) {
      const map = {}; cells.forEach((c, i) => { if (c) map[c] = i; });
      return { headerRow: r + 1, colIndex: map };
    }
  }
  throw new Error('Layout B header row not found (need Score + Recommendation + Redfin Link).');
}

function existingLinks_(sheet, h) {
  const set = new Set();
  const last = sheet.getLastRow();
  if (last <= h.headerRow) return set;
  const col = h.colIndex['Redfin Link'] + 1;
  sheet.getRange(h.headerRow + 1, col, last - h.headerRow, 1).getValues()
    .forEach(r => { const v = String(r[0]).trim(); if (v) set.add(v); });
  return set;
}

function rejectedLinks_() {
  const set = new Set();
  SpreadsheetApp.getActive().getSheets().forEach(s => {
    if (s.getName().toLowerCase().indexOf(CONFIG.REJECT_TAB_MATCH) < 0) return;
    const vals = s.getDataRange().getValues();
    vals.forEach(row => row.forEach(c => {
      const v = String(c).trim();
      if (v.indexOf('redfin.com') >= 0) set.add(v);
    }));
  });
  return set;
}

function appendLead_(sheet, h, lead) {
  const idx = h.colIndex;
  const d = Object.assign({}, lead);
  computeDerived_(d);
  if (!d['First Added']) d['First Added'] = new Date().toString();
  const width = Math.max.apply(null, Object.values(idx)) + 1;
  const row = new Array(width).fill('');
  Object.keys(idx).forEach(header => {
    if (d[header] != null && d[header] !== '')
      row[idx[header]] = MONEY_COLS.indexOf(header) >= 0 ? num_(d[header]) : d[header];
  });
  const t = sheet.getLastRow() + 1;
  sheet.getRange(t, 1, 1, width).setValues([row]);
  MONEY_COLS.forEach(c => { if (idx[c] != null) sheet.getRange(t, idx[c] + 1).setNumberFormat('$#,##0'); });
}

function computeDerived_(d) {
  const p = num_(d['Purchase Price']), arv = num_(d['Estimated ARV']);
  const rl = num_(d['Rehab Cost (Light)']), rh = num_(d['Rehab Cost (Heavy)']);
  const hold = num_(d['Holding Costs (3mo)']);
  if (blank_(d['Total Cost (Light)']) && p) d['Total Cost (Light)'] = p + rl + hold;
  if (blank_(d['Total Cost (Heavy)']) && p) d['Total Cost (Heavy)'] = p + rh + hold;
  if (blank_(d['Gross Profit (Light)']) && arv) d['Gross Profit (Light)'] = arv - num_(d['Total Cost (Light)']);
  if (blank_(d['Gross Profit (Heavy)']) && arv) d['Gross Profit (Heavy)'] = arv - num_(d['Total Cost (Heavy)']);
}

function num_(v) { if (v == null || v === '') return 0; if (typeof v === 'number') return v; const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; }
function blank_(v) { return v == null || v === ''; }
function toast_(m) { SpreadsheetApp.getActive().toast(m, 'Flip Scout', 6); }

/**
 * Quick manual test — Run this from the editor to prove rows are updating.
 * Appends one obvious dummy row to the Property Review tab. Delete the row after.
 */
function testRow() {
  const sheet = getSheet_();
  const h = findHeader_(sheet);
  appendLead_(sheet, h, {
    'Score': 'TEST', 'Recommendation': 'TEST ROW — delete me',
    'Address': '999 Testing Ave', 'City': 'Testville', 'Zip': '00000',
    'Beds': 9, 'Baths': 9, 'SqFt': 1234, 'Lot SqFt': 5678, 'Year Built': 2000,
    'Purchase Price': 111111, 'Estimated ARV': 222222,
    'Rehab Cost (Light)': 33333, 'Rehab Cost (Heavy)': 44444, 'Holding Costs (3mo)': 5555,
    'Risks': 'just a test row — ' + new Date().toString(),
    'Redfin Link': 'https://example.com/test-' + Date.now(),
    'Flip Quality': 'Test Flip'
  });
  toast_('Test row appended to the Property Review tab.');
}
