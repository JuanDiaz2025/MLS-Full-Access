/**
 * Twin Home Buyer — Lead appender for the "Property Review" tab (Layout B).
 * Appends an investigated lead as a new row, matching the sheet's header order,
 * auto-computing cost/profit columns, stamping First Added, and de-duping by
 * Redfin Link. Exposed as a Web App so it can be called programmatically.
 *
 * Deploy: Extensions > Apps Script > paste > set SHARED_SECRET >
 *   Deploy > New deployment > Web app (Execute as: Me; Access: Anyone with link).
 */
const CONFIG = {
  SPREADSHEET_ID: '10kBdkMqQ6_7xiLt8peF0WfU3R1Go8bOZnYiUmNFJSIA',
  SHEET_GID: 1510205894,          // Property Review tab
  SHARED_SECRET: 'CHANGE_ME_TO_A_LONG_RANDOM_STRING', // set this; share with the caller
};

const MONEY_COLS = [
  'Purchase Price', 'Estimated ARV', 'Rehab Cost (Light)', 'Rehab Cost (Heavy)',
  'Holding Costs (3mo)', 'Total Cost (Light)', 'Total Cost (Heavy)',
  'Gross Profit (Light)', 'Gross Profit (Heavy)',
];

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    if (body.secret !== CONFIG.SHARED_SECRET) return json_({ ok: false, error: 'unauthorized' });
    return json_({ ok: true, result: appendLead(body.lead || {}) });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  if (!e || (e.parameter || {}).secret !== CONFIG.SHARED_SECRET) return json_({ ok: false, error: 'unauthorized' });
  const h = findHeader_(getTargetSheet_());
  return json_({ ok: true, headerRow: h.headerRow, columns: Object.keys(h.colIndex) });
}

function appendLead(lead) {
  const sheet = getTargetSheet_();
  const h = findHeader_(sheet);
  const idx = h.colIndex;
  const width = Math.max.apply(null, Object.values(idx)) + 1;

  // Find where THIS table ends. The tab also holds a metrics summary, a
  // dashboard, and a long "Rejected Redfin URL" list BELOW the leads table, so
  // sheet.getLastRow() points past all of them (the old bug wrote rows there).
  // Scan down a stable key column from the header until the first blank row to
  // get the leads table's own end.
  const keyIdx = (idx['Address'] != null) ? idx['Address']
               : (idx['Redfin Link'] != null ? idx['Redfin Link'] : 0);
  const scanHeight = Math.max(sheet.getMaxRows() - h.headerRow, 1);
  const keyVals = sheet.getRange(h.headerRow + 1, keyIdx + 1, scanHeight, 1).getValues();
  let tableRows = 0;
  for (let i = 0; i < keyVals.length; i++) {
    if (String(keyVals[i][0]).trim() === '') break;
    tableRows++;
  }

  // De-dupe on Redfin Link, scanning ONLY this table's rows.
  const link = String(lead['Redfin Link'] || '').trim();
  if (link && idx['Redfin Link'] != null && tableRows > 0) {
    const linkVals = sheet.getRange(h.headerRow + 1, idx['Redfin Link'] + 1, tableRows, 1).getValues();
    if (linkVals.some(r => String(r[0]).trim() === link)) {
      return { skipped: true, reason: 'duplicate Redfin Link', link: link };
    }
  }

  const data = Object.assign({}, lead);
  computeDerived_(data);
  if (!data['First Added']) data['First Added'] = new Date().toString();

  const row = new Array(width).fill('');
  Object.keys(idx).forEach(header => {
    if (data[header] != null && data[header] !== '') {
      row[idx[header]] = MONEY_COLS.indexOf(header) >= 0 ? num_(data[header]) : data[header];
    }
  });

  // Insert a fresh row at the END OF THE LEADS TABLE (pushing whatever is below
  // it further down), so the lead lands inside the table — not beneath the
  // dashboard / rejected-URL list.
  const lastTableRow = h.headerRow + tableRows; // last data row, or header row if empty
  sheet.insertRowAfter(lastTableRow);
  const targetRow = lastTableRow + 1;
  sheet.getRange(targetRow, 1, 1, width).setValues([row]);
  MONEY_COLS.forEach(header => {
    if (idx[header] != null) sheet.getRange(targetRow, idx[header] + 1).setNumberFormat('$#,##0');
  });
  return { skipped: false, row: targetRow, address: data['Address'] || '' };
}

function getTargetSheet_() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const byGid = ss.getSheets().filter(s => s.getSheetId() === CONFIG.SHEET_GID)[0];
  // Do NOT silently fall back to the first tab — that would append to the wrong
  // sheet. Fail loudly so the gid gets fixed.
  if (!byGid) throw new Error('Tab with gid ' + CONFIG.SHEET_GID + ' not found in spreadsheet.');
  return byGid;
}

function findHeader_(sheet) {
  const values = sheet.getRange(1, 1, Math.min(sheet.getLastRow() || 1, 30), sheet.getLastColumn() || 1).getValues();
  for (let r = 0; r < values.length; r++) {
    const cells = values[r].map(v => String(v).trim());
    if (cells.indexOf('Score') >= 0 && cells.indexOf('Recommendation') >= 0 && cells.indexOf('Redfin Link') >= 0) {
      const map = {};
      cells.forEach((c, i) => { if (c) map[c] = i; });
      return { headerRow: r + 1, colIndex: map };
    }
  }
  throw new Error('Layout B header row not found (need Score + Recommendation + Redfin Link).');
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

function num_(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}
function blank_(v) { return v == null || v === ''; }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function testAppend() {
  Logger.log(appendLead({
    'Score': 8, 'Recommendation': 'Strong Deal',
    'Address': '1234 Test St', 'City': 'Oakland', 'Zip': '94601',
    'Beds': 3, 'Baths': 2, 'SqFt': 1400, 'Lot SqFt': 4000, 'Year Built': 1950,
    'Purchase Price': 600000, 'Estimated ARV': 1000000,
    'Rehab Cost (Light)': 90000, 'Rehab Cost (Heavy)': 190000, 'Holding Costs (3mo)': 18000,
    'Risks': 'None', 'Redfin Link': 'https://www.redfin.com/CA/Test/123-Test-St/home/000000',
    'Flip Quality': 'Good Flip'
  }));
}
