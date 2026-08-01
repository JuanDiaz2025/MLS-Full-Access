/**
 * Flip Scout — reviewer rejections.  (Replaces flip-scout-agent-sheet.gs.)
 *
 * The desktop app writes leads into this spreadsheet directly now, so the
 * script no longer has to fetch, deploy, or sync anything. It does ONE job:
 *
 *   when someone takes a lead OFF the Leads tab, record the date and the reason.
 *
 * Two ways that happens, and both are covered:
 *   1. 🚫 Reject selected lead(s) — asks for a reason, then moves the row to
 *      Rejected with the date, the reason and who did it.
 *   2. Someone deletes the row by hand. That gives no reason, so the script
 *      catches it after the fact and logs it as "deleted directly — no reason
 *      given", with the address and price it had. Nothing disappears silently.
 *
 * Rejected MLS #s feed back into the app's ledger, so a rejected property is
 * never scanned, photo-reviewed, or re-added again.
 *
 * INSTALL (once):
 *   Sheet → Extensions → Apps Script → paste this file → Save →
 *   reload the sheet → ⚡ Flip Scout → "Turn on delete tracking".
 *   No deployment, no web app, no secret.
 */

const LEADS_TAB = 'Leads';
const KPI_TAB = 'KPI';
const REJECTED_TAB = 'Rejected';
const SNAPSHOT_TAB = '_FlipScout snapshot';   // hidden; how deletions are noticed

// One Address column holding the whole thing — street, city, state, zip — the
// same shape the app writes to Leads.
const REJECTED_HEADERS = [
  'Rejected On', 'MLS #', 'Address',
  'Price', '$/SqFt', 'SqFt', 'DOM',
  'Reason', 'Stage', 'By', 'MLS Link',
];

// Columns copied off a Leads row when it is rejected, so the Rejected tab shows
// the property rather than just an MLS number. Keys are Rejected-tab columns,
// values the Leads column each one is read from.
const CARRY = {
  'MLS #': 'MLS #', 'Address': 'Address',
  'Price': 'Purchase Price', '$/SqFt': '$/SqFt', 'SqFt': 'SqFt', 'DOM': 'DOM',
  'MLS Link': 'MLS Link',
};

// ------------------------------------------------------------------ menu ----

function onOpen() {
  SpreadsheetApp.getUi().createMenu('⚡ Flip Scout')
    .addItem('🚫 Reject selected lead(s)', 'menuRejectSelected')
    .addItem('📊 Refresh KPI', 'menuRefreshKpi')
    .addSeparator()
    .addItem('▶ Turn on delete tracking', 'menuEnableTracking')
    .addToUi();
}

// -------------------------------------------------------------- rejecting ----

function menuRejectSelected() {
  const ui = SpreadsheetApp.getUi();
  let sel;
  try { sel = selectedLeadRows_(); }
  catch (err) { ui.alert('Reject lead(s)', String(err.message || err), ui.ButtonSet.OK); return; }

  const list = sel.rows.map(r => '• ' + (r['Address'] || r['MLS #'])).join('\n');
  // Ask WHY. A rejection with no reason teaches nobody anything, and the whole
  // point of the Rejected tab is being able to see the pattern later.
  const resp = ui.prompt('Reject ' + sel.rows.length + ' lead(s)',
    list + '\n\nWhy are you rejecting ' + (sel.rows.length > 1 ? 'these' : 'this') + '?\n'
    + 'e.g. Already renovated · Bad street / location · Tenant occupied · '
    + 'Too small · Overpriced · Structural / foundation · Not a fixer · Duplicate\n\n'
    + 'Type a reason and press OK:', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;

  const reason = String(resp.getResponseText() || '').trim();
  if (!reason) {
    ui.alert('Reject lead(s)', 'No reason given — nothing was rejected. '
      + 'The reason is what makes the Rejected tab worth having.', ui.ButtonSet.OK);
    return;
  }

  try {
    const who = safeUser_();
    sel.rows.forEach(r => { r['Reason'] = reason; });
    const n = addRejected_(sel.rows, who, 'Reviewer');
    // Delete bottom-up so the earlier row numbers stay valid.
    for (let i = sel.rows.length - 1; i >= 0; i--) sel.sheet.deleteRow(sel.rows[i]._row);
    snapshot_();                       // the tracker must not re-report these
    rebuildKpi_();                     // the count is only useful if it is current
    ui.alert('Rejected', 'Rejected ' + sel.rows.length + ' lead(s).\n'
      + 'Reason logged: "' + reason + '"\n\n'
      + (n < sel.rows.length ? (sel.rows.length - n) + ' were already on the Rejected tab.\n\n' : '')
      + 'They will not be scanned or added back.', ui.ButtonSet.OK);
  } catch (err) {
    ui.alert('Reject lead(s) — failed', String(err && err.message || err), ui.ButtonSet.OK);
  }
}

function menuRefreshKpi() {
  const ui = SpreadsheetApp.getUi();
  try {
    const n = rebuildKpi_();
    ui.alert('KPI updated', n + ' day(s) of numbers.', ui.ButtonSet.OK);
  } catch (err) {
    ui.alert('Could not refresh the KPI', String(err && err.message || err), ui.ButtonSet.OK);
  }
}

// ------------------------------------------------------------------- KPI ----
// Four columns. Numbers. No chart.
//
//   Date | Rejected | On List | Scan Rejected
//
//   Rejected      — taken off the list by a PERSON, that day
//   On List       — qualified leads still sitting on the Leads tab
//   Scan Rejected — thrown out by the scan itself, that day
//
// The app writes Scan Rejected; the other two are counted here from the sheet,
// so they are right whether or not a scan has run today.

const KPI_HEADERS = ['Date', 'Rejected', 'On List', 'Scan Rejected'];

function kpiSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(KPI_TAB);
  if (!sh) sh = ss.insertSheet(KPI_TAB);
  // Any chart left by an earlier version goes, along with a header row from an
  // older layout. Checking only cell A1 was not enough: a 23-column tab still
  // began with "Date", so the old headings stayed and the numbers landed under
  // the wrong ones.
  sh.getCharts().forEach(c => sh.removeChart(c));
  const width = Math.max(sh.getLastColumn(), KPI_HEADERS.length);
  const cur = sh.getRange(1, 1, 1, width).getValues()[0].map(c => String(c).trim());
  const same = KPI_HEADERS.every((h, i) => cur[i] === h)
    && cur.slice(KPI_HEADERS.length).every(c => !c);
  if (!same) {
    sh.clear();
    sh.getRange(1, 1, 1, KPI_HEADERS.length).setValues([KPI_HEADERS])
      .setFontWeight('bold').setBackground('#1e3a5f').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    KPI_HEADERS.forEach((c, i) => sh.setColumnWidth(i + 1, i === 0 ? 110 : 130));
  }
  return sh;
}

/** yyyy-MM-dd from whatever the cell holds — a real Date or a stamped string. */
function dayKey_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const m = String(v || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : '';
}

/**
 * Recount from the Rejected and Leads tabs. Counting rather than accumulating
 * means a corrected or deleted row shows up immediately and the numbers cannot
 * drift out of step with the tabs they describe.
 */
function rebuildKpi_() {
  const sh = kpiSheet_();

  // Manual removals per day = Rejected rows the REVIEWER made, not the scan.
  const rej = rejectedSheet_();
  const ridx = headerIdx_(rej, REJECTED_HEADERS);
  const rn = Math.max(0, rej.getLastRow() - 1);
  const removed = {};
  if (rn) {
    const vals = rej.getRange(2, 1, rn, Math.max(rej.getLastColumn(), REJECTED_HEADERS.length)).getValues();
    vals.forEach(r => {
      const stage = String(r[ridx['Stage']] || '');
      if (!/reviewer|deleted by hand/i.test(stage)) return;   // scan drops are not manual
      const d = dayKey_(r[ridx['Rejected On']]);
      if (d) removed[d] = (removed[d] || 0) + 1;
    });
  }

  // How many qualified leads are still on the list right now.
  let onList = 0;
  try {
    const leads = leadsSheet_();
    const width = leads.getLastColumn();
    const ln = Math.max(0, leads.getLastRow() - 1);
    if (ln && width) {
      const head = leads.getRange(1, 1, 1, width).getValues()[0].map(c => String(c).trim());
      const mlsCol = head.indexOf('MLS #');
      const vals = leads.getRange(2, 1, ln, width).getValues();
      vals.forEach(v => { if (mlsCol < 0 || String(v[mlsCol] || '').trim()) onList++; });
    }
  } catch (e) { /* no Leads tab yet — the counts stay zero */ }

  // Scan Rejected is the app's number — keep whatever it last wrote.
  const kn = Math.max(0, sh.getLastRow() - 1);
  const prior = {};
  if (kn) {
    sh.getRange(2, 1, kn, KPI_HEADERS.length).getValues().forEach(r => {
      const d = dayKey_(r[0]);
      if (d) prior[d] = { scanRejected: r[3] };
    });
  }

  const days = {};
  Object.keys(prior).forEach(d => { days[d] = true; });
  Object.keys(removed).forEach(d => { days[d] = true; });
  const sorted = Object.keys(days).sort();
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  if (sorted.indexOf(today) < 0) sorted.push(today);

  const rows = sorted.map(d => [
    d,
    removed[d] || 0,
    d === today ? onList : '',           // a live count, so only today's row
    (prior[d] && prior[d].scanRejected) || 0,
  ]);

  if (kn) sh.getRange(2, 1, kn, KPI_HEADERS.length).clearContent();
  if (rows.length) {
    sh.getRange(2, 1, rows.length, KPI_HEADERS.length).setValues(rows);
    sh.getRange(2, 2, rows.length, KPI_HEADERS.length - 1).setNumberFormat('0');
  }
  return rows.length;
}

// ------------------------------------------------------- delete tracking ----
// A row deleted by hand carries no reason with it, so it has to be noticed
// afterwards: keep a snapshot of what is on Leads, and on any structural change
// log whatever went missing. Without this, "someone removed a qualified lead"
// leaves no trace at all.

function menuEnableTracking() {
  const ui = SpreadsheetApp.getUi();
  try {
    const ss = SpreadsheetApp.getActive();
    ScriptApp.getProjectTriggers().forEach(t => {
      if (t.getHandlerFunction() === 'onSheetChange') ScriptApp.deleteTrigger(t);
    });
    ScriptApp.newTrigger('onSheetChange').forSpreadsheet(ss).onChange().create();
    const n = snapshot_();
    ui.alert('Delete tracking is on',
      'Watching ' + n + ' lead(s).\n\n'
      + 'If a row is deleted from "' + LEADS_TAB + '" without using '
      + '"🚫 Reject selected lead(s)", it still gets logged on the Rejected tab '
      + '— dated, and marked as removed with no reason given.\n\n'
      + 'Use the menu item when you can: that is the one that records WHY.',
      ui.ButtonSet.OK);
    rebuildKpi_();
  } catch (err) {
    ui.alert('Could not turn on tracking', String(err && err.message || err), ui.ButtonSet.OK);
  }
}

/** Installable onChange trigger. Only structural edits matter here. */
function onSheetChange(e) {
  const type = e && e.changeType;
  if (type !== 'REMOVE_ROW' && type !== 'REMOVE_GRID' && type !== 'OTHER') return;
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(10000)) return;      // a later change will catch up
  try { reconcile_(); } finally { lock.releaseLock(); }
}

/**
 * Anything in the snapshot but no longer on Leads was removed by hand. Log it,
 * then re-snapshot. Runs after the fact, which is exactly why the snapshot has
 * to carry the whole row — the original is already gone.
 */
function reconcile_() {
  const snap = readSnapshot_();
  if (!snap.rows.length) { snapshot_(); return 0; }

  const live = {};
  readLeads_().rows.forEach(r => { const k = keyOf_(r['MLS #']); if (k) live[k] = true; });

  const gone = snap.rows.filter(r => { const k = keyOf_(r['MLS #']); return k && !live[k]; });
  if (gone.length) {
    gone.forEach(r => { r['Reason'] = 'removed from the sheet directly — no reason given'; });
    addRejected_(gone, '', 'Deleted by hand');
  }
  snapshot_();
  rebuildKpi_();
  return gone.length;
}

/** Mirror the current Leads tab into the hidden snapshot sheet. */
function snapshot_() {
  const { rows } = readLeads_();
  const sh = snapshotSheet_();
  sh.clear();
  const cols = Object.keys(CARRY);
  const out = [cols].concat(rows.map(carry_).map(r => cols.map(c => (r[c] == null ? '' : r[c]))));
  sh.getRange(1, 1, out.length, cols.length).setValues(out);
  return rows.length;
}

function readSnapshot_() {
  const sh = snapshotSheet_();
  const n = Math.max(0, sh.getLastRow() - 1);
  if (!n) return { rows: [] };
  const cols = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const vals = sh.getRange(2, 1, n, cols.length).getValues();
  return { rows: vals.map(v => { const o = {}; cols.forEach((c, i) => { o[c] = v[i]; }); return o; }) };
}

function snapshotSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SNAPSHOT_TAB);
  if (!sh) { sh = ss.insertSheet(SNAPSHOT_TAB); sh.hideSheet(); }
  return sh;
}

// ------------------------------------------------------------ Leads tab ----

/** Every data row on Leads, keyed by header name. */
function readLeads_() {
  const sh = leadsSheet_();
  const width = sh.getLastColumn();
  const n = Math.max(0, sh.getLastRow() - 1);
  if (!n || !width) return { sheet: sh, rows: [] };
  const head = sh.getRange(1, 1, 1, width).getValues()[0].map(c => String(c).trim());
  const vals = sh.getRange(2, 1, n, width).getValues();
  const rows = [];
  vals.forEach((v, i) => {
    const o = { _row: i + 2 };
    head.forEach((c, j) => { if (c) o[c] = v[j]; });
    // A blank MLS # is a spacer row, not a lead.
    if (String(o['MLS #'] || '').trim()) rows.push(o);
  });
  return { sheet: sh, rows: rows };
}

function leadsSheet_() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(LEADS_TAB);
  if (!sh) throw new Error('No "' + LEADS_TAB + '" tab in this spreadsheet. Run a scan from the app first.');
  return sh;
}

/** A Leads row rewritten with Rejected-tab column names, so everything
 *  downstream (snapshot, addRejected_) speaks one vocabulary. */
function carry_(leadRow) {
  const o = { _row: leadRow._row };
  Object.keys(CARRY).forEach(c => { o[c] = leadRow[CARRY[c]]; });
  return o;
}

/** The rows the reviewer currently has selected on the Leads tab. */
function selectedLeadRows_() {
  const sheet = leadsSheet_();
  if (SpreadsheetApp.getActiveSheet().getSheetId() !== sheet.getSheetId()) {
    throw new Error('Select the row(s) on the "' + LEADS_TAB + '" tab first.');
  }
  const byRow = {};
  readLeads_().rows.forEach(r => { byRow[r._row] = r; });

  const ranges = SpreadsheetApp.getActiveRangeList()
    ? SpreadsheetApp.getActiveRangeList().getRanges()
    : [SpreadsheetApp.getActiveRange()];
  const out = [], seen = {};
  ranges.forEach(rg => {
    for (let r = rg.getRow(); r < rg.getRow() + rg.getNumRows(); r++) {
      if (seen[r] || !byRow[r]) continue;
      seen[r] = true;
      out.push(carry_(byRow[r]));
    }
  });
  if (!out.length) throw new Error('No lead rows selected. Click a row (or drag over several) and try again.');
  return { sheet: sheet, rows: out.sort((a, b) => a._row - b._row) };
}

// --------------------------------------------------------- Rejected tab ----

function rejectedSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(REJECTED_TAB);
  if (!sh) sh = ss.insertSheet(REJECTED_TAB);
  if (String(sh.getRange(1, 1).getValue()).trim() !== REJECTED_HEADERS[0]) {
    if (sh.getMaxColumns() < REJECTED_HEADERS.length) {
      sh.insertColumnsAfter(sh.getMaxColumns(), REJECTED_HEADERS.length - sh.getMaxColumns());
    }
    sh.getRange(1, 1, 1, REJECTED_HEADERS.length).setValues([REJECTED_HEADERS])
      .setFontWeight('bold').setBackground('#7f1d1d').setFontColor('#ffffff').setWrap(true);
    sh.setRowHeight(1, 36);
    sh.setFrozenRows(1);
    const w = { 'Rejected On': 130, 'MLS #': 95, 'Address': 320,
      'Price': 100, '$/SqFt': 75, 'SqFt': 70, 'DOM': 55,
      'Reason': 340, 'Stage': 130, 'By': 170, 'MLS Link': 190 };
    REJECTED_HEADERS.forEach((c, i) => sh.setColumnWidth(i + 1, w[c] || 110));
    if (!sh.getFilter()) sh.getRange(1, 1, sh.getMaxRows(), REJECTED_HEADERS.length).createFilter();
  }
  return sh;
}

/** Append rejections, skipping MLS #s already logged. Returns how many landed. */
function addRejected_(items, who, stage) {
  const sh = rejectedSheet_();
  const idx = headerIdx_(sh, REJECTED_HEADERS);
  const width = Math.max(sh.getLastColumn(), REJECTED_HEADERS.length);
  const have = {};
  rejectedKeys_(sh, idx).forEach(m => { have[m] = true; });
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');

  const rows = [];
  items.forEach(it => {
    const key = keyOf_(it['MLS #']);
    if (key && have[key]) return;
    if (key) have[key] = true;
    const row = new Array(width).fill('');
    const put = (c, v) => { if (idx[c] != null && v !== undefined && v !== null) row[idx[c]] = v; };
    put('Rejected On', stamp);
    Object.keys(CARRY).forEach(c => put(c, it[c]));
    put('Reason', it['Reason'] || '(no reason recorded)');
    put('Stage', stage || 'Reviewer');
    put('By', who || '');
    rows.push(row);
  });

  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, width).setValues(rows);
  return rows.length;
}

function rejectedKeys_(sh, idx) {
  const n = Math.max(0, sh.getLastRow() - 1);
  if (!n) return [];
  return sh.getRange(2, idx['MLS #'] + 1, n, 1).getValues()
    .map(r => keyOf_(r[0])).filter(String);
}

// ------------------------------------------------------------------ utils ----

function headerIdx_(sh, fallback) {
  const width = Math.max(sh.getLastColumn(), fallback.length);
  const cells = sh.getRange(1, 1, 1, width).getValues()[0];
  const idx = {};
  cells.forEach((c, i) => { const s = String(c).trim(); if (s) idx[s] = i; });
  fallback.forEach((c, i) => { if (idx[c] == null) idx[c] = i; });
  return idx;
}

const keyOf_ = v => String(v == null ? '' : v).trim().toUpperCase();

/** The signed-in address is blank under some authorization modes — not an error. */
function safeUser_() {
  try { return Session.getActiveUser().getEmail() || ''; } catch (e) { return ''; }
}
