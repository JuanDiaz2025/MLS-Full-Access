/**
 * Flip Scout Agent -> Google Sheets sync (pull model).
 *
 * Every refresh pulls the latest leads from the Flip Scout Agent feed
 * (leads_for_sheets.json in the GitHub repo) and APPENDS new ones into the
 * "Flip Scout Leads" tab. Dedup key is the Redfin link, so a still-active
 * listing never repeats. New leads also trigger an email to NOTIFY_EMAIL.
 *
 * If the repo branch changes, update FEED_URL below.
 */

var FEED_URL = 'https://raw.githubusercontent.com/JuanDiaz2025/Juan-s-Autonomous-Real-Estate-Flip-Scout-Agent/claude/python-code-goal-nn6zec/flip_scout/leads_for_sheets.json';
var SHEET_NAME = 'Flip Scout Leads';

// Who gets emailed when new leads land. Comma-separate for multiple recipients,
// e.g. 'bryan@twinhomebuyer.com,juan@twinhomebuyer.com'. Leave '' to disable email.
var NOTIFY_EMAIL = 'bryan@twinhomebuyer.com';

var COLUMNS = [
  { key: 'score', header: 'Score', format: '0' },
  { key: 'recommendation', header: 'Recommendation', format: '@' },
  { key: 'address', header: 'Address', format: '@' },
  { key: 'city', header: 'City', format: '@' },
  { key: 'zip', header: 'Zip', format: '@' },
  { key: 'beds', header: 'Beds', format: '0.#' },
  { key: 'baths', header: 'Baths', format: '0.#' },
  { key: 'sqft', header: 'SqFt', format: '#,##0' },
  { key: 'lot_sqft', header: 'Lot SqFt', format: '#,##0' },
  { key: 'year_built', header: 'Year Built', format: '0' },
  { key: 'price', header: 'Purchase Price', format: '$#,##0' },
  { key: 'arv', header: 'Estimated ARV', format: '$#,##0' },
  { key: 'rehab_light', header: 'Rehab Cost (Light)', format: '$#,##0' },
  { key: 'rehab_heavy', header: 'Rehab Cost (Heavy)', format: '$#,##0' },
  { key: 'holding_costs', header: 'Holding Costs (3mo)', format: '$#,##0' },
  { key: 'total_cost_light', header: 'Total Cost (Light)', format: '$#,##0' },
  { key: 'total_cost_heavy', header: 'Total Cost (Heavy)', format: '$#,##0' },
  { key: 'gross_profit_light', header: 'Gross Profit (Light)', format: '$#,##0' },
  { key: 'gross_profit_heavy', header: 'Gross Profit (Heavy)', format: '$#,##0' },
  { key: 'risks', header: 'Risks', format: '@' },
  { key: 'url', header: 'Redfin Link', format: '@' },
  { key: 'first_added', header: 'First Added', format: '@' },
];

var URL_COL_INDEX = COLUMNS.findIndex(function (c) { return c.key === 'url'; }) + 1; // 1-based
var PROFIT_COL_INDEX = COLUMNS.findIndex(function (c) { return c.key === 'gross_profit_light'; }) + 1; // 1-based

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Flip Scout')
    .addItem('Refresh Now', 'refreshFlipScoutSheet')
    .addItem('Resync Existing Leads', 'resyncExistingLeads')
    .addItem('Reject Selected Lead(s)', 'rejectSelectedLeads')
    .addItem('Clear All Leads', 'clearAllLeads')
    .addItem('Remove Non-Profitable Leads', 'removeNonProfitableLeads')
    .addItem('Show KPI Tab', 'showKpiTab')
    .addItem('Send Test Notification', 'sendTestNotification')
    .addItem('Enable Hourly Auto-Refresh', 'enableHourlyTrigger')
    .addItem('Disable Auto-Refresh', 'disableHourlyTrigger')
    .addToUi();
  updateKpiTab_(); // keep the KPI tab current every time the sheet is opened, no action needed
}

/** Manual trigger for the KPI tab (also runs automatically after every
 * Refresh/Reject/Clear/Remove action) - jumps you straight to it. */
function showKpiTab() {
  updateKpiTab_();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var kpiSheet = ss.getSheetByName(KPI_SHEET_NAME);
  if (kpiSheet) ss.setActiveSheet(kpiSheet);
}

/**
 * KPI tab - automated, always current, no need to ask anyone to compile it.
 */
var KPI_SHEET_NAME = 'KPI';
var TOTAL_NONPROFIT_REMOVED_KEY = 'KPI_TOTAL_NONPROFIT_REMOVED';
var OLD_TOTAL_ADDED_KEY = 'KPI_TOTAL_ADDED';
var OLD_TOTAL_REJECTED_KEY = 'KPI_TOTAL_REJECTED';

function incrementCounter_(key, by) {
  var props = PropertiesService.getScriptProperties();
  var current = parseInt(props.getProperty(key) || '0', 10);
  var next = current + by;
  props.setProperty(key, String(next));
  return next;
}

function getCounter_(key) {
  return parseInt(PropertiesService.getScriptProperties().getProperty(key) || '0', 10);
}

function updateKpiTab_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var leadsSheet = ss.getSheetByName(SHEET_NAME);
  var currentlyKept = leadsSheet ? Math.max(0, leadsSheet.getLastRow() - 1) : 0;

  var rejectedSheet = ss.getSheetByName(REJECTED_SHEET_NAME);
  var totalRejected = rejectedSheet ? Math.max(0, rejectedSheet.getLastRow() - 1) : 0;

  var totalNonProfitRemoved = getCounter_(TOTAL_NONPROFIT_REMOVED_KEY);
  var totalRemoved = totalRejected + totalNonProfitRemoved;
  var totalAdded = currentlyKept + totalRemoved;

  var props = PropertiesService.getScriptProperties();
  props.deleteProperty(OLD_TOTAL_ADDED_KEY);
  props.deleteProperty(OLD_TOTAL_REJECTED_KEY);

  var kpiSheet = ss.getSheetByName(KPI_SHEET_NAME);
  if (!kpiSheet) {
    kpiSheet = ss.insertSheet(KPI_SHEET_NAME);
  }
  kpiSheet.clear();

  var rows = [
    ['Metric', 'Value'],
    ['Currently kept (in sheet now)', currentlyKept],
    ['Total ever added (kept + removed)', totalAdded],
    ['Total rejected (Reject Selected Lead(s))', totalRejected],
    ['Total removed (Remove Non-Profitable Leads)', totalNonProfitRemoved],
    ['Total removed (all reasons)', totalRemoved],
    ['Last updated', new Date().toString()],
  ];
  kpiSheet.getRange(1, 1, rows.length, 2).setValues(rows);
  kpiSheet.getRange(1, 1, 1, 2).setFontWeight('bold');
  kpiSheet.autoResizeColumns(1, 2);
}

var REJECTED_SHEET_NAME = 'Rejected (do not edit)';
var OLD_REJECTED_URLS_KEY = 'REJECTED_URLS';

function getRejectedSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(REJECTED_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(REJECTED_SHEET_NAME);
    sheet.hideSheet();
    sheet.getRange(1, 1).setValue('Rejected Redfin URL');
  }
  return sheet;
}

function getRejectedUrls_() {
  var sheet = getRejectedSheet_();
  var rejected = {};
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, 1).getValues().forEach(function (row) {
      if (row[0]) rejected[row[0]] = true;
    });
  }

  var oldRaw = PropertiesService.getScriptProperties().getProperty(OLD_REJECTED_URLS_KEY);
  if (oldRaw) {
    try {
      var oldRejected = JSON.parse(oldRaw);
      var newUrls = Object.keys(oldRejected).filter(function (u) { return !rejected[u]; });
      if (newUrls.length > 0) {
        sheet.getRange(sheet.getLastRow() + 1, 1, newUrls.length, 1)
          .setValues(newUrls.map(function (u) { return [u]; }));
        newUrls.forEach(function (u) { rejected[u] = true; });
      }
    } catch (e) {
      // old value was corrupt/unparseable - nothing to migrate, fall through
    }
    PropertiesService.getScriptProperties().deleteProperty(OLD_REJECTED_URLS_KEY);
  }

  return rejected;
}

function addRejectedUrls_(urls) {
  var sheet = getRejectedSheet_();
  var existing = getRejectedUrls_();
  var toAdd = urls.filter(function (u) { return u && !existing[u]; });
  if (toAdd.length === 0) return;
  sheet.getRange(sheet.getLastRow() + 1, 1, toAdd.length, 1)
    .setValues(toAdd.map(function (u) { return [u]; }));
}

function rejectSelectedLeads() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    ui.alert('No "' + SHEET_NAME + '" sheet found.');
    return;
  }

  var selection = sheet.getActiveRangeList();
  if (!selection) {
    ui.alert('Select the row(s) you want to reject first (click a row number, or select any cell in each row), then run this again.');
    return;
  }

  var rowIndices = {};
  selection.getRanges().forEach(function (range) {
    var startRow = range.getRow();
    var numRows = range.getNumRows();
    for (var i = 0; i < numRows; i++) {
      var r = startRow + i;
      if (r > 1) rowIndices[r] = true; // never touch the header row
    }
  });

  var rows = Object.keys(rowIndices).map(Number).sort(function (a, b) { return a - b; });
  if (rows.length === 0) {
    ui.alert('No lead rows selected (header row can\'t be rejected).');
    return;
  }

  var urlColIdx = URL_COL_INDEX;
  var urls = rows.map(function (r) { return sheet.getRange(r, urlColIdx).getValue(); });

  var response = ui.alert('Reject Selected Lead(s)',
    'Delete ' + rows.length + ' row(s) and permanently exclude them from future refreshes? This cannot be undone from inside the script.',
    ui.ButtonSet.YES_NO);
  if (response !== ui.Button.YES) return;

  addRejectedUrls_(urls);

  // delete bottom-up so row indices above don't shift as we go
  rows.sort(function (a, b) { return b - a; });
  rows.forEach(function (r) { sheet.deleteRow(r); });

  updateKpiTab_();
  ui.alert(rows.length + ' lead(s) rejected and permanently excluded.');
}

function refreshFlipScoutSheet() {
  var response = UrlFetchApp.fetch(FEED_URL, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) {
    throw new Error('Could not fetch leads feed (HTTP ' + response.getResponseCode() + '). ' +
      'Check FEED_URL still points at a real branch/file in the repo.');
  }

  var feed = JSON.parse(response.getContentText());
  var leads = feed.leads || [];

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  var isNewSheet = !sheet;
  if (isNewSheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }

  var headers = COLUMNS.map(function (c) { return c.header; });

  var hasStaleHeader = false;
  if (!isNewSheet && sheet.getLastRow() > 0) {
    var existingHeaderRow = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0];
    hasStaleHeader = !headers.every(function (h, i) { return existingHeaderRow[i] === h; });
  }

  if (isNewSheet || sheet.getLastRow() === 0 || hasStaleHeader) {
    if (hasStaleHeader) {
      sheet.clear();
    }
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }

  var existingUrls = {};
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var existing = sheet.getRange(2, URL_COL_INDEX, lastRow - 1, 1).getValues();
    existing.forEach(function (row) {
      if (row[0]) existingUrls[row[0]] = true;
    });
  }

  var rejectedUrls = getRejectedUrls_();
  var newLeads = leads.filter(function (lead) {
    if (existingUrls[lead.url] || rejectedUrls[lead.url]) return false;
    if (lead.manual_include === true) return true;
    return lead.gross_profit_light > 0;
  });

  ss.toast(newLeads.length + ' new lead(s) found, ' + Object.keys(existingUrls).length + ' already in sheet.', 'Flip Scout', 5);

  if (newLeads.length === 0) {
    sheet.getRange(1, 1).setNote('Last checked: ' + new Date().toString() +
      '\nFeed generated: ' + feed.generated_at + '\nNo new leads this check.');
    updateKpiTab_();
    return;
  }

  var now = new Date().toString();
  var rows = newLeads.map(function (lead) {
    return COLUMNS.map(function (c) {
      if (c.key === 'first_added') return now;
      var v = lead[c.key];
      return v === undefined || v === null ? '' : v;
    });
  });

  var startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, rows.length, headers.length).setValues(rows);

  COLUMNS.forEach(function (c, i) {
    sheet.getRange(startRow, i + 1, rows.length, 1).setNumberFormat(c.format);
  });

  sheet.autoResizeColumns(1, headers.length);
  sheet.getRange(1, 1).setNote('Last checked: ' + now +
    '\nFeed generated: ' + feed.generated_at +
    '\n' + newLeads.length + ' new lead(s) added this check.');

  // Email a heads-up with the new leads.
  notifyNewLeads_(newLeads, feed);

  updateKpiTab_();
}

/**
 * Emails NOTIFY_EMAIL a summary of the new leads just appended. Silent no-op
 * if NOTIFY_EMAIL is blank or there are no new leads. Safe to call every
 * refresh — it only fires when something new actually landed.
 */
function notifyNewLeads_(newLeads, feed) {
  if (!NOTIFY_EMAIL || !newLeads || newLeads.length === 0) return;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var n = newLeads.length;
  var subject = 'Flip Scout: ' + n + ' new lead' + (n === 1 ? '' : 's') + ' in the sheet';

  var lines = newLeads.map(function (l) {
    return '• ' + [l.recommendation, l.address, l.city, l.zip].filter(String).join(' | ') +
      '\n    Price $' + money_(l.price) +
      '  |  ARV $' + money_(l.arv) +
      '  |  Profit (Light) $' + money_(l.gross_profit_light) +
      '  |  Score ' + (l.score == null ? '' : l.score) +
      (l.risks && l.risks !== 'None' ? '\n    Risks: ' + l.risks : '') +
      '\n    ' + (l.url || '');
  });

  var body = n + ' new lead(s) added to "' + SHEET_NAME + '":\n\n' +
    lines.join('\n\n') +
    '\n\nSheet: ' + ss.getUrl() +
    '\nFeed generated: ' + (feed && feed.generated_at ? feed.generated_at : 'n/a');

  MailApp.sendEmail(NOTIFY_EMAIL, subject, body);
}

/** Thousands-formatted integer for email text (no toLocaleString dependency). */
function money_(v) {
  var n = Math.round(Number(v) || 0);
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Menu helper: fire a test email so you can confirm notifications work. */
function sendTestNotification() {
  if (!NOTIFY_EMAIL) {
    SpreadsheetApp.getUi().alert('NOTIFY_EMAIL is blank — set it at the top of the script first.');
    return;
  }
  notifyNewLeads_([{
    recommendation: 'Strong Deal', address: '123 Test St', city: 'Oakland', zip: '94601',
    price: 500000, arv: 900000, gross_profit_light: 250000, score: 9,
    risks: 'None', url: 'https://www.redfin.com/CA/Test/123-Test-St/home/000000',
  }], { generated_at: new Date().toISOString() });
  SpreadsheetApp.getUi().alert('Test notification sent to ' + NOTIFY_EMAIL + '.');
}

function resyncExistingLeads() {
  var response = UrlFetchApp.fetch(FEED_URL, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) {
    throw new Error('Could not fetch leads feed (HTTP ' + response.getResponseCode() + '). ' +
      'Check FEED_URL still points at a real branch/file in the repo.');
  }

  var feed = JSON.parse(response.getContentText());
  var leadsByUrl = {};
  (feed.leads || []).forEach(function (lead) { leadsByUrl[lead.url] = lead; });

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    SpreadsheetApp.getUi().alert('No "' + SHEET_NAME + '" sheet found yet - run Refresh Now first.');
    return;
  }

  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    SpreadsheetApp.getUi().alert('No leads to resync.');
    return;
  }

  var firstAddedColIdx = COLUMNS.findIndex(function (c) { return c.key === 'first_added'; });
  var urlColIdx = URL_COL_INDEX - 1;

  var range = sheet.getRange(2, 1, lastRow - 1, COLUMNS.length);
  var rows = range.getValues();
  var updated = 0;

  for (var i = 0; i < rows.length; i++) {
    var lead = leadsByUrl[rows[i][urlColIdx]];
    if (!lead) continue; // no longer in the feed - leave this row alone

    var firstAdded = rows[i][firstAddedColIdx];
    rows[i] = COLUMNS.map(function (c) {
      if (c.key === 'first_added') return firstAdded;
      var v = lead[c.key];
      return v === undefined || v === null ? '' : v;
    });
    updated++;
  }

  range.setValues(rows);
  COLUMNS.forEach(function (c, i) {
    sheet.getRange(2, i + 1, rows.length, 1).setNumberFormat(c.format);
  });

  SpreadsheetApp.getUi().alert(updated + ' existing lead(s) refreshed with the latest feed data ' +
    '(risks, financials, recommendation). Rows no longer in the feed were left untouched.');
}

function clearAllLeads() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    ui.alert('No "' + SHEET_NAME + '" sheet found - nothing to clear.');
    return;
  }

  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    ui.alert('No leads to clear.');
    return;
  }

  var response = ui.alert('Clear All Leads',
    'This deletes all ' + (lastRow - 1) + ' lead row(s) below the header. This cannot be undone. Continue?',
    ui.ButtonSet.YES_NO);
  if (response !== ui.Button.YES) return;

  sheet.deleteRows(2, lastRow - 1);
  updateKpiTab_();
  ui.alert('Cleared. Run Refresh Now to repopulate from the current feed.');
}

function removeNonProfitableLeads() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    SpreadsheetApp.getUi().alert('No "' + SHEET_NAME + '" sheet found yet - run Refresh Now first.');
    return;
  }

  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    SpreadsheetApp.getUi().alert('No leads to check.');
    return;
  }

  var profitValues = sheet.getRange(2, PROFIT_COL_INDEX, lastRow - 1, 1).getValues();
  var rowsToDelete = [];
  for (var i = 0; i < profitValues.length; i++) {
    var v = profitValues[i][0];
    if (typeof v === 'number' && v <= 0) {
      rowsToDelete.push(i + 2); // +2: 1-based, plus header row
    }
  }

  rowsToDelete.sort(function (a, b) { return b - a; });
  rowsToDelete.forEach(function (rowIndex) {
    sheet.deleteRow(rowIndex);
  });

  incrementCounter_(TOTAL_NONPROFIT_REMOVED_KEY, rowsToDelete.length);
  updateKpiTab_();
  SpreadsheetApp.getUi().alert(rowsToDelete.length + ' non-profitable lead(s) removed.');
}

var TRIGGER_HANDLER = 'refreshFlipScoutSheet';

function enableHourlyTrigger() {
  disableHourlyTrigger(); // avoid duplicates if clicked more than once
  ScriptApp.newTrigger(TRIGGER_HANDLER).timeBased().everyHours(1).create();
  SpreadsheetApp.getUi().alert('Hourly auto-refresh enabled. New leads will be appended every hour, and you\'ll be emailed when any land - existing rows are never touched or duplicated.');
}

function disableHourlyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}
