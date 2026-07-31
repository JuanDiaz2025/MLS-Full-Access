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
 *   2. Edit CONFIG.SHARED_SECRET below to a long random string.
 *   3. Run setupSheet() once (authorize when prompted) — writes + formats headers.
 *   4. Deploy > New deployment > Web app
 *        Execute as: Me
 *        Who has access: Anyone with the link
 *      Copy the /exec URL.
 *   5. Paste that URL + the same secret into the desktop app (section 6).
 *
 * The "Anyone with the link" setting is what lets the app post without an OAuth
 * dance; the shared secret is what actually guards it. Treat the URL + secret as
 * credentials — anyone holding both can append rows.
 */
const CONFIG = {
  SPREADSHEET_ID: '1u7YXGGUp_TeJUP3nYDqTJDJgu5IjLtkX0KPlSkI4TE4',
  SHEET_NAME: 'Leads',                 // created by setupSheet() if missing
  FALLBACK_GID: 0,                     // the starting Sheet1, used if SHEET_NAME is absent
  SHARED_SECRET: 'CHANGE_ME_TO_A_LONG_RANDOM_STRING',
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

/** Locate the header row by looking for our own column names. */
function header_(sheet) {
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
  throw new Error('Header row not found — run setupSheet() first.');
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
