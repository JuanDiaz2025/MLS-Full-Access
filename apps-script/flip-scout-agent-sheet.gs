/**
 * Twin Home Buyer — "Flip Scout Agent" sheet endpoint.
 *
 * Target sheet: https://docs.google.com/spreadsheets/d/1u7YXGGUp_TeJUP3nYDqTJDJgu5IjLtkX0KPlSkI4TE4
 *
 * This is the sheet the FlipScout desktop app writes to. It exposes a Web App
 * endpoint so the app can push leads the moment a scan finishes — no copy/paste.
 *
 * Adds the two columns Bryan asked for on top of the old Layout B:
 *   - "DOM"                          days on market (scraped straight from Matrix)
 *   - "Estimated ARV (After Repair)" what the property is worth once repaired
 *
 * SETUP (once):
 *   1. Open the sheet > Extensions > Apps Script, paste this file, Save.
 *   2. Deploy > New deployment > Web app
 *        Execute as: Me
 *        Who has access: Anyone with the link
 *   3. Back on the sheet: ⚡ Flip Scout > Connect the app. That builds every tab
 *      and shows the URL + secret to paste into section 7 of the desktop app.
 *
 * The secret below is pre-set and already matches the app, so there is nothing
 * to type. The menu is deliberately three items — everything else happens on
 * its own.
 *
 * The "Anyone with the link" setting is what lets the app post without an OAuth
 * dance; the shared secret is what actually guards it. Treat the URL + secret as
 * credentials — anyone holding both can append rows.
 */
const CONFIG = {
  SPREADSHEET_ID: '1u7YXGGUp_TeJUP3nYDqTJDJgu5IjLtkX0KPlSkI4TE4',
  SHEET_NAME: 'Leads',                 // created by setupSheet() if missing
  FALLBACK_GID: 0,                     // the starting Sheet1, used if SHEET_NAME is absent
  // Pre-generated so the script and the desktop app already agree — nothing to
  // type. Replace it (here AND in desktop-app/sheet-config.json) if it leaks.
  SHARED_SECRET: 'ZM85Wtbzf3lx7_412HVvII5_ifAVCzIA',
};

/** Canonical column order. Changing this is safe: rows are written by header
 *  name, so reordering or inserting a column in the sheet keeps working. */
const HEADERS = [
  'Score', 'Recommendation', 'Flip Quality',
  'MLS #', 'Address', 'City', 'Zip',
  'Beds', 'Baths', 'SqFt', 'Lot SqFt', 'Year Built', 'DOM',
  'Purchase Price', 'Estimated ARV (After Repair)',
  'Rehab Cost (Light)', 'Rehab Cost (Heavy)', 'Holding Costs (3mo)',
  'Total Cost (Light)', 'Total Cost (Heavy)',
  'Gross Profit (Light)', 'Gross Profit (Heavy)', 'Max Offer',
  'ARV Basis', 'Risks', 'MLS Link', 'First Added',
];

const MONEY_COLS = [
  'Purchase Price', 'Estimated ARV (After Repair)',
  'Rehab Cost (Light)', 'Rehab Cost (Heavy)', 'Holding Costs (3mo)',
  'Total Cost (Light)', 'Total Cost (Heavy)',
  'Gross Profit (Light)', 'Gross Profit (Heavy)', 'Max Offer',
];
const INT_COLS = ['Score', 'Beds', 'SqFt', 'Lot SqFt', 'Year Built', 'DOM'];

// ---------------------------------------------------------------- web app ----

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.secret !== CONFIG.SHARED_SECRET) return json_({ ok: false, error: 'unauthorized' });

    // A KPI post carries the day's counters instead of leads.
    if (body.kpi) return json_({ ok: true, kpi: upsertKpi_(body.kpi) });

    // Accept a single lead or a batch — the app pushes a whole scan at once.
    const leads = body.leads || (body.lead ? [body.lead] : []);
    if (!leads.length) return json_({ ok: false, error: 'no lead(s) in request' });

    const results = appendLeads(leads);
    return json_({
      ok: true,
      added: results.filter(r => !r.skipped).length,
      skipped: results.filter(r => r.skipped).length,
      results: results,
    });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/** Health check + header introspection, so the app can verify its config. */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.secret !== CONFIG.SHARED_SECRET) return json_({ ok: false, error: 'unauthorized' });
  // The app asks for this before every scan so rejected leads stay buried.
  if (p.rejected) return json_({ ok: true, rejected: rejectedList_() });
  const sheet = getSheet_();
  const h = header_(sheet);
  return json_({
    ok: true, sheet: sheet.getName(),
    columns: HEADERS.filter(c => h.idx[c] != null),
    missingColumns: HEADERS.filter(c => h.idx[c] == null),
    rows: Math.max(0, lastDataRow_(sheet, h) - h.row),
  });
}

// ----------------------------------------------------------------- append ----

function appendLeads(leads) {
  const sheet = getSheet_();
  const h = header_(sheet);
  const seen = existingKeys_(sheet, h);

  const rows = [], results = [];
  for (const raw of leads) {
    const lead = normalize_(raw);
    const key = keyOf_(lead);
    if (key && seen[key]) { results.push({ skipped: true, reason: 'duplicate', key: key, address: lead['Address'] }); continue; }
    if (key) seen[key] = true;           // also de-dupes within this same batch
    compute_(lead);
    if (!lead['First Added']) lead['First Added'] = new Date();
    rows.push(HEADERS.map(c => (h.idx[c] == null ? null : valueFor_(lead, c))));
    results.push({ skipped: false, address: lead['Address'] || '', mls: lead['MLS #'] || '' });
  }
  if (!rows.length) return results;

  // Build a dense block in the sheet's own column order, then write in ONE call.
  const width = sheet.getLastColumn() || HEADERS.length;
  const block = rows.map(r => {
    const out = new Array(width).fill('');
    HEADERS.forEach((c, i) => { if (h.idx[c] != null && r[i] != null) out[h.idx[c]] = r[i]; });
    return out;
  });
  const start = lastDataRow_(sheet, h) + 1;
  if (start + block.length > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), block.length + 10);
  sheet.getRange(start, 1, block.length, width).setValues(block);
  formatRange_(sheet, h, start, block.length);
  return results;
}

/** Accept both the app's camelCase lead objects and literal sheet-header keys. */
const ALIASES = {
  score: 'Score', recommendation: 'Recommendation', flipQuality: 'Flip Quality',
  mls: 'MLS #', address: 'Address', addr: 'Address', city: 'City', zip: 'Zip',
  beds: 'Beds', bds: 'Beds', baths: 'Baths', sqft: 'SqFt', lotSqft: 'Lot SqFt',
  yearBuilt: 'Year Built', dom: 'DOM', daysOnMarket: 'DOM',
  price: 'Purchase Price', purchasePrice: 'Purchase Price',
  arv: 'Estimated ARV (After Repair)', estimatedArv: 'Estimated ARV (After Repair)',
  afterRepairValue: 'Estimated ARV (After Repair)',
  rehabLight: 'Rehab Cost (Light)', rehabHeavy: 'Rehab Cost (Heavy)',
  holding: 'Holding Costs (3mo)', holdingCosts: 'Holding Costs (3mo)',
  totalLight: 'Total Cost (Light)', totalHeavy: 'Total Cost (Heavy)',
  grossLight: 'Gross Profit (Light)', grossHeavy: 'Gross Profit (Heavy)',
  recommendedMaxOffer: 'Max Offer', maxOffer: 'Max Offer',
  arvBasis: 'ARV Basis', risks: 'Risks', link: 'MLS Link', mlsLink: 'MLS Link',
  firstAdded: 'First Added',
};

function normalize_(raw) {
  const out = {};
  Object.keys(raw || {}).forEach(k => {
    const canon = HEADERS.indexOf(k) >= 0 ? k : ALIASES[k];
    if (canon && (out[canon] == null || out[canon] === '')) out[canon] = raw[k];
  });
  return out;
}

function valueFor_(lead, col) {
  const v = lead[col];
  if (v == null || v === '') return '';
  if (MONEY_COLS.indexOf(col) >= 0 || INT_COLS.indexOf(col) >= 0) return num_(v);
  return v;
}

/** Derived money columns — never ask the caller to compute what we can. */
function compute_(d) {
  const p = num_(d['Purchase Price']);
  const arv = num_(d['Estimated ARV (After Repair)']);
  const rl = num_(d['Rehab Cost (Light)']);
  const rh = num_(d['Rehab Cost (Heavy)']);
  const hold = num_(d['Holding Costs (3mo)']);
  if (blank_(d['Total Cost (Light)']) && p) d['Total Cost (Light)'] = p + rl + hold;
  if (blank_(d['Total Cost (Heavy)']) && p) d['Total Cost (Heavy)'] = p + rh + hold;
  if (blank_(d['Gross Profit (Light)']) && arv) d['Gross Profit (Light)'] = arv - num_(d['Total Cost (Light)']);
  if (blank_(d['Gross Profit (Heavy)']) && arv) d['Gross Profit (Heavy)'] = arv - num_(d['Total Cost (Heavy)']);
  // Max offer = ARV minus light rehab, holding, and the required profit margin.
  if (blank_(d['Max Offer']) && arv) {
    const gate = arv >= 1e6 ? 100000 : arv >= 500000 ? 70000 : 50000;
    d['Max Offer'] = Math.round(arv - rl - hold - gate);
  }
}

// ------------------------------------------------------------------ sheet ----

function getSheet_() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const byName = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (byName) return byName;
  const byGid = ss.getSheets().filter(s => s.getSheetId() === CONFIG.FALLBACK_GID)[0];
  if (byGid) return byGid;
  return ss.getSheets()[0];
}

/** Locate the header row by looking for our own column names.
 *  If the tab has never been set up, build it instead of failing — otherwise the
 *  very first append (or testAppend) dies on a sheet that is simply still empty. */
function header_(sheet, _retry) {
  const maxRow = Math.min(sheet.getLastRow() || 1, 20);
  const maxCol = Math.max(sheet.getLastColumn() || 1, 1);
  const values = sheet.getRange(1, 1, maxRow, maxCol).getValues();
  for (let r = 0; r < values.length; r++) {
    const cells = values[r].map(v => String(v).trim());
    if (cells.indexOf('Address') >= 0 && (cells.indexOf('MLS #') >= 0 || cells.indexOf('Score') >= 0)) {
      const idx = {};
      cells.forEach((c, i) => { if (c) idx[c] = i; });
      return { row: r + 1, idx: idx };
    }
  }
  if (_retry) throw new Error('Header row still not found after setup — check that CONFIG.SPREADSHEET_ID points at the right file.');
  setupSheet();
  return header_(getSheet_(), true);
}

/** Last row of the leads table (stops at the first blank key cell, so anything
 *  parked below the table is never overwritten). */
function lastDataRow_(sheet, h) {
  const keyCol = (h.idx['Address'] != null ? h.idx['Address'] : 0) + 1;
  const height = Math.max(sheet.getMaxRows() - h.row, 0);
  if (!height) return h.row;
  const vals = sheet.getRange(h.row + 1, keyCol, height, 1).getValues();
  let n = 0;
  for (let i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).trim() === '') break;
    n++;
  }
  return h.row + n;
}

/** De-dupe keys: MLS # when present, else address+city. */
function existingKeys_(sheet, h) {
  const end = lastDataRow_(sheet, h);
  const seen = {};
  if (end <= h.row) return seen;
  const n = end - h.row;
  const get = col => (h.idx[col] == null ? null : sheet.getRange(h.row + 1, h.idx[col] + 1, n, 1).getValues());
  const mls = get('MLS #'), addr = get('Address'), city = get('City');
  for (let i = 0; i < n; i++) {
    const m = mls && String(mls[i][0]).trim();
    if (m) seen['mls:' + m.toUpperCase()] = true;
    const a = addr && String(addr[i][0]).trim();
    if (a) seen['addr:' + (a + '|' + (city ? String(city[i][0]).trim() : '')).toUpperCase()] = true;
  }
  return seen;
}

function keyOf_(lead) {
  const m = String(lead['MLS #'] || '').trim();
  if (m) return 'mls:' + m.toUpperCase();
  const a = String(lead['Address'] || '').trim();
  if (a) return 'addr:' + (a + '|' + String(lead['City'] || '').trim()).toUpperCase();
  return '';
}

function formatRange_(sheet, h, startRow, numRows) {
  MONEY_COLS.forEach(c => {
    if (h.idx[c] != null) sheet.getRange(startRow, h.idx[c] + 1, numRows, 1).setNumberFormat('$#,##0');
  });
  INT_COLS.forEach(c => {
    if (h.idx[c] != null) sheet.getRange(startRow, h.idx[c] + 1, numRows, 1).setNumberFormat('0');
  });
  if (h.idx['First Added'] != null) {
    sheet.getRange(startRow, h.idx['First Added'] + 1, numRows, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  }
}

// ------------------------------------------------------------------ setup ----

/** Run once from the Apps Script editor. Idempotent — safe to re-run. */
function setupSheet() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    // Reuse the starting empty Sheet1 rather than leaving a stray tab behind.
    const first = ss.getSheets()[0];
    if (ss.getSheets().length === 1 && first.getLastRow() === 0) {
      first.setName(CONFIG.SHEET_NAME); sheet = first;
    } else {
      sheet = ss.insertSheet(CONFIG.SHEET_NAME);
    }
  }
  if (sheet.getMaxColumns() < HEADERS.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), HEADERS.length - sheet.getMaxColumns());

  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
    .setFontWeight('bold').setBackground('#1f3864').setFontColor('#ffffff')
    .setVerticalAlignment('middle').setWrap(true);
  sheet.setRowHeight(1, 42);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(5); // through Address, so money columns scroll under it

  const idx = {}; HEADERS.forEach((c, i) => { idx[c] = i; });
  const widths = {
    'Score': 55, 'Recommendation': 110, 'Flip Quality': 115, 'MLS #': 95,
    'Address': 210, 'City': 110, 'Zip': 65, 'Beds': 55, 'Baths': 60,
    'SqFt': 70, 'Lot SqFt': 80, 'Year Built': 85, 'DOM': 60,
    'ARV Basis': 150, 'Risks': 260, 'MLS Link': 200, 'First Added': 140,
  };
  HEADERS.forEach((c, i) => sheet.setColumnWidth(i + 1, widths[c] || 125));

  const maxRows = Math.max(sheet.getMaxRows() - 1, 1);
  MONEY_COLS.forEach(c => sheet.getRange(2, idx[c] + 1, maxRows, 1).setNumberFormat('$#,##0'));
  INT_COLS.forEach(c => sheet.getRange(2, idx[c] + 1, maxRows, 1).setNumberFormat('0'));

  applyConditionalFormatting_(sheet, idx, maxRows);
  if (!sheet.getFilter()) sheet.getRange(1, 1, sheet.getMaxRows(), HEADERS.length).createFilter();

  SpreadsheetApp.flush();
  return 'Ready: ' + HEADERS.length + ' columns on tab "' + sheet.getName() + '"';
}

function applyConditionalFormatting_(sheet, idx, maxRows) {
  const rules = [];
  const rec = sheet.getRange(2, idx['Recommendation'] + 1, maxRows, 1);
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Strong Deal')
    .setBackground('#d9ead3').setFontColor('#274e13').setRanges([rec]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Marginal')
    .setBackground('#fff2cc').setFontColor('#7f6000').setRanges([rec]).build());

  const q = sheet.getRange(2, idx['Flip Quality'] + 1, maxRows, 1);
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Good Flip')
    .setBackground('#d9ead3').setFontColor('#274e13').setRanges([q]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Flip W/ Caution')
    .setBackground('#fce5cd').setFontColor('#783f04').setRanges([q]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Negative')
    .setBackground('#f4cccc').setFontColor('#990000').setRanges([q]).build());

  // Negative profit should be visible at a glance in both rehab scenarios.
  ['Gross Profit (Light)', 'Gross Profit (Heavy)'].forEach(c => {
    const r = sheet.getRange(2, idx[c] + 1, maxRows, 1);
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(0)
      .setFontColor('#990000').setRanges([r]).build());
  });

  // A long DOM is a flag, never a drop (the 45-day cap was removed) — tint it
  // so a stale listing is obvious without filtering it out.
  const dom = sheet.getRange(2, idx['DOM'] + 1, maxRows, 1);
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(90)
    .setBackground('#fce5cd').setRanges([dom]).build());

  sheet.setConditionalFormatRules(rules);
}

// -------------------------------------------------------------- KPI tab ----
// One row per calendar day. The app posts the running totals for "today" after
// every scan, so the row is UPSERTED by date rather than appended - three scans
// in a day update one row instead of making three.

const KPI_TAB = 'KPI';
const REJECTED_TAB = 'Rejected';
// Columns the APP owns (overwritten on each push) …
const KPI_HEADERS = [
  'Date', 'Runs', 'Scanned', 'Candidates', 'Already Checked (skipped)',
  'Reviewed', 'Kept', 'Dropped',
  'Dropped: Renovated', 'Dropped: Multi-unit', 'Dropped: Fire',
  'Dropped: Few photos', 'Dropped: Other',
  'Leads', 'Clear Gate', 'Sent to Sheet', 'Already There',
  // … and columns the REVIEWER owns. The app must never clobber these.
  'Reviewer Removed', 'Reviewer Kept', 'Reviewer',
  'Keep Rate', 'Gate Rate', 'Last Run',
];
const KPI_KEYS = [
  'date', 'runs', 'scanned', 'candidates', 'skippedAlreadyChecked',
  'reviewed', 'kept', 'dropped',
  'droppedRenovated', 'droppedMultiUnit', 'droppedFire',
  'droppedFewPhotos', 'droppedOther',
  'leads', 'gateCleared', 'pushed', 'pushSkipped',
];
const KPI_REVIEWER_COLS = ['Reviewer Removed', 'Reviewer Kept', 'Reviewer'];

function kpiSheet_() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  let sh = ss.getSheetByName(KPI_TAB);
  if (!sh) sh = ss.insertSheet(KPI_TAB);
  const first = sh.getRange(1, 1).getValue();
  if (String(first).trim() !== 'Date') {
    if (sh.getMaxColumns() < KPI_HEADERS.length) sh.insertColumnsAfter(sh.getMaxColumns(), KPI_HEADERS.length - sh.getMaxColumns());
    sh.getRange(1, 1, 1, KPI_HEADERS.length).setValues([KPI_HEADERS])
      .setFontWeight('bold').setBackground('#1f3864').setFontColor('#ffffff').setWrap(true);
    sh.setRowHeight(1, 42);
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 95);
    for (let i = 2; i <= KPI_HEADERS.length; i++) sh.setColumnWidth(i, 90);
  }
  return sh;
}

function upsertKpi_(kpi) {
  const sh = kpiSheet_();
  const date = String(kpi.date || '').trim();
  if (!date) throw new Error('kpi.date is required (YYYY-MM-DD)');

  const n = Math.max(0, sh.getLastRow() - 1);
  let target = 0;
  if (n) {
    const dates = sh.getRange(2, 1, n, 1).getValues();
    for (let i = 0; i < n; i++) {
      // Cell may come back as a Date object if Sheets auto-parsed it.
      const v = dates[i][0];
      const s = (v instanceof Date) ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(v).trim();
      if (s === date) { target = i + 2; break; }
    }
  }
  const num = k => Number(kpi[k] || 0);
  const keepRate = num('reviewed') ? num('kept') / num('reviewed') : '';
  const gateRate = num('leads') ? num('gateCleared') / num('leads') : '';

  const isNew = !target;
  if (isNew) target = sh.getLastRow() + 1;

  // Write only the app-owned span, then the rate/timestamp columns. The
  // reviewer's own columns sit between them and are left untouched, so a scan
  // finishing never wipes what she logged that day.
  const row = KPI_KEYS.map(k => (k === 'date' ? date : num(k)));
  sh.getRange(target, 1, 1, row.length).setValues([row]);

  const idx = kpiIdx_(sh);
  if (isNew) {
    KPI_REVIEWER_COLS.forEach(c => { if (idx[c] != null) sh.getRange(target, idx[c] + 1).setValue(c === 'Reviewer' ? '' : 0); });
  }
  if (idx['Keep Rate'] != null) sh.getRange(target, idx['Keep Rate'] + 1).setValue(keepRate).setNumberFormat('0%');
  if (idx['Gate Rate'] != null) sh.getRange(target, idx['Gate Rate'] + 1).setValue(gateRate).setNumberFormat('0%');
  if (idx['Last Run'] != null) sh.getRange(target, idx['Last Run'] + 1).setValue(kpi.lastRun || new Date().toISOString());
  sh.getRange(target, 1).setNumberFormat('@');   // keep the date a plain string
  return { date: date, row: target, created: isNew };
}

function kpiIdx_(sh) {
  const cells = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), KPI_HEADERS.length)).getValues()[0];
  const idx = {};
  cells.forEach((c, i) => { const s = String(c).trim(); if (s) idx[s] = i; });
  return idx;
}

/** Find (or create) today's KPI row and add `n` to a reviewer-owned counter. */
function bumpReviewerKpi_(column, n, who) {
  const sh = kpiSheet_();
  const idx = kpiIdx_(sh);
  if (idx[column] == null) throw new Error('KPI column not found: ' + column);
  const date = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  let target = 0;
  const rows = Math.max(0, sh.getLastRow() - 1);
  if (rows) {
    const dates = sh.getRange(2, 1, rows, 1).getValues();
    for (let i = 0; i < rows; i++) {
      const v = dates[i][0];
      const s = (v instanceof Date) ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(v).trim();
      if (s === date) { target = i + 2; break; }
    }
  }
  if (!target) {                                  // reviewer acted on a day with no scan
    target = sh.getLastRow() + 1;
    sh.getRange(target, 1).setValue(date).setNumberFormat('@');
  }
  const cell = sh.getRange(target, idx[column] + 1);
  cell.setValue(Number(cell.getValue() || 0) + n);
  if (who && idx['Reviewer'] != null) sh.getRange(target, idx['Reviewer'] + 1).setValue(who);
  if (idx['Last Run'] != null && !sh.getRange(target, idx['Last Run'] + 1).getValue()) {
    sh.getRange(target, idx['Last Run'] + 1).setValue(new Date().toISOString());
  }
  return { date: date, row: target, column: column, value: cell.getValue() };
}

// --------------------------------------------------------- rejected list ----
// Every lead the reviewer deletes is remembered here, and the desktop app pulls
// this list before each scan so a rejected property is never surfaced again.

function rejectedSheet_() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  let sh = ss.getSheetByName(REJECTED_TAB);
  if (!sh) sh = ss.insertSheet(REJECTED_TAB);
  if (String(sh.getRange(1, 1).getValue()).trim() !== 'MLS #') {
    sh.getRange(1, 1, 1, 5).setValues([['MLS #', 'Address', 'City', 'Rejected On', 'By']])
      .setFontWeight('bold').setBackground('#1f3864').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 100); sh.setColumnWidth(2, 220); sh.setColumnWidth(3, 120);
    sh.setColumnWidth(4, 110); sh.setColumnWidth(5, 160);
  }
  return sh;
}

function rejectedList_() {
  const sh = rejectedSheet_();
  const n = Math.max(0, sh.getLastRow() - 1);
  if (!n) return [];
  return sh.getRange(2, 1, n, 1).getValues()
    .map(r => String(r[0]).trim()).filter(String);
}

function addRejected_(items, who) {
  const sh = rejectedSheet_();
  const have = {};
  rejectedList_().forEach(m => { have[m.toUpperCase()] = true; });
  const date = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const rows = items
    .filter(it => it.mls && !have[String(it.mls).toUpperCase()])
    .map(it => [it.mls, it.addr || '', it.city || '', date, who || '']);
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, 5).setValues(rows);
  return rows.length;
}

// ------------------------------------------------------- in-sheet buttons ----
// Adds a "Flip Scout" menu to the sheet's toolbar. Reload the sheet once after
// saving the script for the menu to appear.

// Three items, nothing else. Everything the old menu did that mattered either
// happens automatically now or lives inside "Connect the app".
function onOpen() {
  SpreadsheetApp.getUi().createMenu('⚡ Flip Scout')
    .addItem('❌ Reject selected lead(s)', 'menuRejectSelected')
    .addItem('📊 Today\'s numbers', 'menuReviewerToday')
    .addItem('🔌 Connect the app', 'menuConnect')
    .addToUi();
}

/**
 * One click: build/repair every tab, then show the two values the desktop app
 * needs. This replaces the old set-up / KPI-tab / connection-info items.
 */
function menuConnect() {
  runMenu_('Connect the app', () => {
    setupSheet();       // Leads tab
    kpiSheet_();        // KPI tab
    rejectedSheet_();   // Rejected tab

    let url = '';
    try { url = ScriptApp.getService().getUrl() || ''; } catch (e) {}
    const secretOk = CONFIG.SHARED_SECRET && CONFIG.SHARED_SECRET !== 'CHANGE_ME_TO_A_LONG_RANDOM_STRING';

    if (!url) {
      return 'Tabs are ready (Leads, KPI, Rejected).\n\n'
        + 'The app is NOT connected yet — this script has not been deployed.\n\n'
        + 'Deploy > New deployment > Web app\n'
        + '   Execute as: Me\n'
        + '   Who has access: Anyone with the link\n'
        + 'Then run this again to get the link.';
    }
    return 'Tabs ready (Leads, KPI, Rejected).\n\n'
      + 'Paste these two into section 7 of the FlipScout app:\n\n'
      + 'URL:\n' + url + '\n\n'
      + 'Secret:\n' + (secretOk ? CONFIG.SHARED_SECRET : '⚠ still the placeholder — edit CONFIG.SHARED_SECRET at the top of this script')
      + '\n\nThen click "Test connection" in the app.';
  });
}

/** Every menu action runs through here so a failure shows a readable dialog
 *  instead of a silent red toast that disappears. */
function runMenu_(label, fn) {
  const ui = SpreadsheetApp.getUi();
  try {
    const msg = fn();
    if (msg) ui.alert(label, String(msg), ui.ButtonSet.OK);
  } catch (err) {
    ui.alert(label + ' — failed', String(err && err.message || err), ui.ButtonSet.OK);
  }
}

// ---- reviewer actions (the three items at the top of the menu) ----

/** Rows the reviewer currently has selected, as {row, mls, addr, city}. */
function selectedLeadRows_() {
  const sheet = getSheet_();
  const active = SpreadsheetApp.getActiveSheet();
  if (active.getSheetId() !== sheet.getSheetId()) {
    throw new Error('Select the row(s) on the "' + sheet.getName() + '" tab first.');
  }
  const h = header_(sheet);
  const end = lastDataRow_(sheet, h);
  const out = [];
  const seen = {};
  (SpreadsheetApp.getActiveRangeList()
    ? SpreadsheetApp.getActiveRangeList().getRanges()
    : [SpreadsheetApp.getActiveRange()]).forEach(rg => {
    for (let r = rg.getRow(); r < rg.getRow() + rg.getNumRows(); r++) {
      if (r <= h.row || r > end || seen[r]) continue;
      seen[r] = true;
      const get = c => (h.idx[c] == null ? '' : String(sheet.getRange(r, h.idx[c] + 1).getValue()).trim());
      out.push({ row: r, mls: get('MLS #'), addr: get('Address'), city: get('City') });
    }
  });
  if (!out.length) throw new Error('No lead rows selected. Click a row (or drag over several) and try again.');
  return { sheet: sheet, rows: out.sort((a, b) => a.row - b.row) };
}

function menuRejectSelected() {
  const ui = SpreadsheetApp.getUi();
  let sel;
  try { sel = selectedLeadRows_(); }
  catch (err) { ui.alert('Reject lead(s)', String(err.message || err), ui.ButtonSet.OK); return; }

  const list = sel.rows.map(r => '• ' + (r.addr || r.mls)).join('\n');
  const ok = ui.alert('Reject ' + sel.rows.length + ' lead(s)?',
    list + '\n\nThey are deleted from the list, remembered so they never come back, '
    + 'and counted in today\'s KPI.', ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;

  runMenu_('Reject lead(s)', () => {
    const who = safeUser_();
    addRejected_(sel.rows, who);
    // Delete bottom-up so earlier row numbers stay valid.
    for (let i = sel.rows.length - 1; i >= 0; i--) sel.sheet.deleteRow(sel.rows[i].row);
    const k = bumpReviewerKpi_('Reviewer Removed', sel.rows.length, who);
    return 'Rejected ' + sel.rows.length + ' lead(s).\n'
      + 'Today\'s removed count: ' + k.value + '\n\n'
      + 'They will not be scanned or re-added.';
  });
}

function menuReviewerToday() {
  runMenu_('My review numbers today', () => {
    const sh = kpiSheet_();
    const idx = kpiIdx_(sh);
    const date = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    const rows = Math.max(0, sh.getLastRow() - 1);
    for (let i = 0; i < rows; i++) {
      const v = sh.getRange(i + 2, 1).getValue();
      const s = (v instanceof Date) ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(v).trim();
      if (s !== date) continue;
      const g = c => (idx[c] == null ? 0 : sh.getRange(i + 2, idx[c] + 1).getValue() || 0);
      return date + '\n\n'
        + 'Leads added by the scan: ' + g('Sent to Sheet') + '\n'
        + 'You removed: ' + g('Reviewer Removed') + '\n'
        + 'You kept: ' + g('Reviewer Kept') + '\n\n'
        + 'Total rejected all-time: ' + rejectedList_().length;
    }
    return 'Nothing recorded for ' + date + ' yet.';
  });
}

/** Effective user can be blank depending on how the script is authorized. */
function safeUser_() {
  try { return Session.getActiveUser().getEmail() || ''; } catch (e) { return ''; }
}

// ------------------------------------------------------------------ utils ----

function num_(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}
function blank_(v) { return v == null || v === ''; }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/** Sanity check from the editor after setupSheet(). */
function testAppend() {
  Logger.log(JSON.stringify(appendLeads([{
    score: 8, recommendation: 'Strong Deal', flipQuality: 'Good Flip',
    mls: 'TEST0001', address: '1234 Test St', city: 'Oakland', zip: '94601',
    beds: 3, baths: 2, sqft: 1400, lotSqft: 4000, yearBuilt: 1950, dom: 12,
    price: 600000, arv: 1000000, rehabLight: 98000, rehabHeavy: 203000, holding: 18000,
    arvBasis: '±20% band, 7 comps @ $714/sf',
    risks: 'Verify foundation before offering',
    link: 'https://search.mlslistings.com/Matrix/Public/Portal.aspx?ID=TEST0001',
  }]), null, 2));
}
