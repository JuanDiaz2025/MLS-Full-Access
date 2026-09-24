/**
 * FlipScout — agent outreach: email DRAFTS to listing agents, never sent by code.
 *
 * Lives in the prod sheet next to flip-scout-reject.gs and flipscout-alerts.gs
 * (it uses FS_PASSED, FS_CLOSED, fsDeadline_, fsPost_ and fsSafeEmail_ from the
 * alerts file, so that file must be in the same project). Prefix fso.
 *
 * WHO GETS A DRAFT
 *   "Draft emails for new A leads": Bucket A, MLS Status Active, a valid Agent
 *   Email, Notes not PASS/rejected and without "no outreach", offer deadline
 *   not already past, and never drafted before (the Outreach tab is the log —
 *   one draft per property, ever). At most FSO_DAILY_MAX per click, soonest
 *   offer deadline first, then highest score.
 *   "Draft emails for selected lead(s)": the rows you selected on Leads, any
 *   bucket, with the same safety skips (passed, closed, no email, drafted).
 *
 * WHOSE GMAIL
 *   Menu items run as the person who clicks them, so the drafts appear in
 *   THAT person's Gmail → Drafts. They fill in the offer amount (highlighted
 *   yellow) and click Send. Nothing is ever sent by this script.
 *
 * STATUS
 *   "Update status" looks at the threads of the drafts YOU made and moves each
 *   row Drafted → Sent → Replied (with dates). When it finds a new reply it
 *   posts "📬 AGENT REPLIED" to the team's Google Chat.
 *   fsoSetup (run once by the person who sends most) also turns this on hourly
 *   for their own drafts.
 *
 * SETUP (once)
 *   Paste this as a new file, save, run fsoSetup, approve the permissions,
 *   reload the sheet → "✉️ FlipScout Outreach" menu.
 */

const FSO_TAB = 'Outreach';
const FSO_DAILY_MAX = 20;
const FSO_HEAD = ['Drafted On', 'MLS #', 'Address', 'Agent', 'Agent Email', 'Status',
                  'Drafted By', 'Sent On', 'Replied On', 'Thread ID'];
const FSO_OFFER = '[OFFER — fill in]';
const FSO_SUBJECT = 'Offer on {address}';
const FSO_BODY = [
  'Hi {first},',
  '',
  'Would your seller entertain an offer of $' + FSO_OFFER + ' on {address}? We\'re a local cash buyer, ' +
    'no financing contingency, can close fast and work around your timeline.',
  '',
  'Let me know if that\'s something worth putting in front of them.',
  '',
  'Best,',
  'Twin Home Buyer team'
].join('\n');
const FSO_EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}$/i;

/* ---------------------------------------------------------------- setup -- */

function fsoSetup() {
  ScriptApp.getProjectTriggers()
    .filter(t => ['fsoOnOpen', 'fsoHourly'].indexOf(t.getHandlerFunction()) >= 0)
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('fsoOnOpen').forSpreadsheet(SpreadsheetApp.getActive()).onOpen().create();
  ScriptApp.newTrigger('fsoHourly').timeBased().everyHours(1).create();
  fsoTab_();
  GmailApp.getDrafts();            // asks for the Gmail permission now, not on first use
  Logger.log('Outreach is set up. Reload the sheet for the ✉️ FlipScout Outreach menu.');
}

function fsoOnOpen() {
  SpreadsheetApp.getUi().createMenu('✉️ FlipScout Outreach')
    .addItem('Preview — who would get a draft (creates nothing)', 'fsoPreview')
    .addItem('Draft ONE test email to myself', 'fsoTestDraft')
    .addSeparator()
    .addItem('Draft emails for new A leads (up to ' + FSO_DAILY_MAX + ')', 'fsoDraftNew')
    .addItem('Draft emails for selected lead(s) on Leads', 'fsoDraftSelected')
    .addSeparator()
    .addItem('Update status (sent / replied)', 'fsoUpdateNow')
    .addToUi();
}

/* ------------------------------------------------------------ the menu -- */

function fsoPreview() {
  const pick = fsoPickNew_();
  const ui = SpreadsheetApp.getUi();
  ui.alert('Outreach preview (nothing created)',
    pick.list.length
      ? pick.list.length + ' draft(s) would be created in YOUR Gmail:\n\n' +
        pick.list.map(l => '• ' + fsoShortAddr_(l.addr) + ' → ' + (l.agent || 'agent') + ' <' + l.email + '>').join('\n') +
        (pick.more ? '\n\n+' + pick.more + ' more eligible — the next click takes them.' : '')
      : 'No A lead needs a draft right now.' + fsoSkipText_(pick.skipped),
    ui.ButtonSet.OK);
}

// A draft addressed to yourself, from the first eligible lead, to check the wording.
// Not logged, so it never uses up that lead.
function fsoTestDraft() {
  const me = fsSafeEmail_();
  if (!me) throw new Error('Could not read your email address.');
  const l = fsoPickNew_().list[0] || fsoLeads_().find(x => x.email) ;
  if (!l) throw new Error('No lead with an agent email to use as the example.');
  const m = fsoMessage_(l);
  GmailApp.createDraft(me, '[TEST] ' + m.subject, m.text, { htmlBody: m.html });
  SpreadsheetApp.getActive().toast('Test draft for ' + fsoShortAddr_(l.addr) + ' is in your Gmail Drafts, addressed to you.', 'FlipScout Outreach', 8);
}

function fsoDraftNew() {
  const ui = SpreadsheetApp.getUi();
  const pick = fsoPickNew_();
  if (!pick.list.length) { ui.alert('Nothing to draft', 'No A lead needs a draft right now.' + fsoSkipText_(pick.skipped), ui.ButtonSet.OK); return; }
  const ok = ui.alert('Create ' + pick.list.length + ' draft(s)?',
    'They go to YOUR Gmail → Drafts. Nothing is sent.\n\nFill in the offer amount (highlighted yellow) in each one before you send it.',
    ui.ButtonSet.OK_CANCEL);
  if (ok !== ui.Button.OK) return;
  fsoCreate_(pick.list);
}

function fsoDraftSelected() {
  const ui = SpreadsheetApp.getUi();
  const sh = SpreadsheetApp.getActiveSheet();
  if (sh.getName() !== FS_LEADS) { ui.alert('Select rows on the Leads tab first.'); return; }
  const rows = {};
  (sh.getActiveRangeList() ? sh.getActiveRangeList().getRanges() : []).forEach(r => {
    for (let i = r.getRow(); i < r.getRow() + r.getNumRows(); i++) if (i > 1) rows[i] = true;
  });
  const done = fsoDrafted_();
  const list = [], skipped = [];
  fsoLeads_().filter(l => rows[l.row]).forEach(l => {
    const why = fsoBlock_(l, done);
    if (why) skipped.push(fsoShortAddr_(l.addr) + ' — ' + why); else list.push(l);
  });
  if (!list.length) { ui.alert('Nothing to draft', skipped.length ? skipped.join('\n') : 'No lead rows selected.', ui.ButtonSet.OK); return; }
  const ok = ui.alert('Create ' + list.length + ' draft(s)?',
    'They go to YOUR Gmail → Drafts. Nothing is sent.' + (skipped.length ? '\n\nSkipped:\n' + skipped.join('\n') : ''),
    ui.ButtonSet.OK_CANCEL);
  if (ok !== ui.Button.OK) return;
  fsoCreate_(list);
}

function fsoUpdateNow() {
  const r = fsoUpdate_();
  SpreadsheetApp.getActive().toast(r.checked ? r.checked + ' of your drafts checked · ' + r.sent + ' newly sent · ' + r.replied + ' new repl' + (r.replied === 1 ? 'y' : 'ies')
                                             : 'You have no open drafts on the Outreach tab.', 'FlipScout Outreach', 8);
}

function fsoHourly() { fsoUpdate_(); }

/* --------------------------------------------------------------- drafts -- */

function fsoCreate_(list) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    const done = fsoDrafted_();             // re-read under the lock: two people clicking at once
    const tab = fsoTab_(), me = fsSafeEmail_(), now = new Date();
    let made = 0;
    list.forEach(l => {
      if (done[l.mls]) return;
      const m = fsoMessage_(l);
      const d = GmailApp.createDraft(l.email, m.subject, m.text, { htmlBody: m.html });
      tab.appendRow([now, l.mls, l.addr, l.agent, l.email, 'Drafted', me, '', '', d.getMessage().getThread().getId()]);
      done[l.mls] = true;
      made++;
    });
    SpreadsheetApp.getActive().toast(made + ' draft(s) in your Gmail → Drafts. Fill in the offer amount, then send.', 'FlipScout Outreach', 10);
  } finally {
    lock.releaseLock();
  }
}

function fsoMessage_(l) {
  const fill = s => s.replace(/\{first\}/g, fsoFirstName_(l.agent) || 'there')
                     .replace(/\{address\}/g, fsoShortAddr_(l.addr));
  const text = fill(FSO_BODY);
  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = esc(text).split('\n').join('<br>')
    .replace(esc(FSO_OFFER), '<span style="background:#ffeb3b;font-weight:bold">' + esc(FSO_OFFER) + '</span>');
  return { subject: fill(FSO_SUBJECT), text, html };
}

// The new-A-leads list, in work order, capped at FSO_DAILY_MAX.
function fsoPickNew_() {
  const done = fsoDrafted_(), skipped = {}, ok = [];
  fsoLeads_().forEach(l => {
    if (!/^A/i.test(l.bucket)) return;
    const why = fsoBlock_(l, done);
    if (why) { skipped[why] = (skipped[why] || 0) + 1; return; }
    ok.push(l);
  });
  const t = l => { const d = fsDeadline_(l.due); return d ? d.when.getTime() : Infinity; };
  ok.sort((a, b) => t(a) - t(b) || (+b.score || 0) - (+a.score || 0));
  return { list: ok.slice(0, FSO_DAILY_MAX), more: Math.max(0, ok.length - FSO_DAILY_MAX), skipped };
}

// Why this lead must not get a draft, or '' when it may.
function fsoBlock_(l, done) {
  if (done[l.mls]) return 'already drafted';
  if (FS_PASSED.test(l.notes)) return 'passed in Notes';
  if (/no outreach/i.test(l.notes)) return '"no outreach" in Notes';
  if (FS_CLOSED.test(l.mstat)) return 'closed on the MLS';
  if (l.mstat && !/^active$/i.test(l.mstat)) return l.mstat.toLowerCase() + ' on the MLS';
  if (!l.email) return 'no agent email';
  const dl = fsDeadline_(l.due);
  if (dl && dl.when < new Date()) return 'offer deadline passed';
  return '';
}

function fsoSkipText_(skipped) {
  const k = Object.keys(skipped);
  return k.length ? '\n\nA leads skipped:\n' + k.map(w => '• ' + skipped[w] + ' ' + w).join('\n') : '';
}

/* --------------------------------------------------------------- status -- */

// Checks only the rows the running person drafted — their Gmail is the only one it can see.
function fsoUpdate_() {
  const me = (fsSafeEmail_() || '').toLowerCase();
  const tab = fsoTab_(), v = tab.getDataRange().getValues();
  const h = v[0], c = n => h.indexOf(n);
  const out = { checked: 0, sent: 0, replied: 0 }, news = [];
  for (let r = 1; r < v.length; r++) {
    const row = v[r];
    if (String(row[c('Drafted By')]).toLowerCase() !== me || row[c('Status')] === 'Replied') continue;
    let th = null;
    try { th = GmailApp.getThreadById(String(row[c('Thread ID')])); } catch (e) {}
    if (!th) continue;
    out.checked++;
    const msgs = th.getMessages().filter(m => !m.isDraft());
    const mine = msgs.filter(m => m.getFrom().toLowerCase().indexOf(me) >= 0);
    const theirs = msgs.filter(m => m.getFrom().toLowerCase().indexOf(me) < 0);
    if (mine.length && !row[c('Sent On')]) {
      tab.getRange(r + 1, c('Sent On') + 1).setValue(mine[0].getDate());
      tab.getRange(r + 1, c('Status') + 1).setValue('Sent');
      out.sent++;
      if (mine[0].getPlainBody().indexOf(FSO_OFFER) >= 0) tab.getRange(r + 1, c('Status') + 1).setValue('Sent — offer amount left blank!');
    }
    if (theirs.length) {
      tab.getRange(r + 1, c('Replied On') + 1).setValue(theirs[0].getDate());
      tab.getRange(r + 1, c('Status') + 1).setValue('Replied');
      out.replied++;
      news.push({ addr: row[c('Address')], agent: row[c('Agent')], mls: row[c('MLS #')], text: theirs[0].getPlainBody() });
    }
  }
  if (news.length) {
    try {
      fsPost_('📬 *FLIPSCOUT — AGENT REPLIED* (' + news.length + ')\n\n' + news.map(n =>
        '*' + n.addr + '*\n' + (n.agent || 'Agent') + ': “' + fsoFirstLines_(n.text) + '”\nMLS: https://www.mlslistings.com/Property/' + n.mls
      ).join('\n\n') + '\n\nReplies are in ' + me + '’s Gmail.');
    } catch (e) { Logger.log('Chat post failed: ' + e); }
  }
  return out;
}

// The reply itself, without the quoted email underneath, kept short for Chat.
function fsoFirstLines_(body) {
  const s = String(body || '').split(/\n\s*On .{5,200}wrote:|\n>|\n-{2,}\s*\n/)[0].replace(/\s+/g, ' ').trim();
  return s.length > 200 ? s.slice(0, 197).trim() + '…' : s;
}

/* -------------------------------------------------------------- helpers -- */

function fsoLeads_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(FS_LEADS);
  const v = sh.getDataRange().getDisplayValues();
  const head = v[0].map(x => String(x).trim());
  const get = (row, n) => { const i = head.indexOf(n); return i < 0 ? '' : String(row[i] || '').trim(); };
  return v.slice(1).map((r, i) => ({
    row: i + 2, mls: get(r, 'MLS #').toUpperCase(), addr: get(r, 'Address'), notes: get(r, 'Notes'),
    bucket: get(r, 'Bucket'), score: get(r, 'Opportunity Score'), due: get(r, 'Offer Due'),
    mstat: get(r, 'MLS Status'), agent: get(r, 'Listing Agent').split(',')[0].trim(),
    email: fsoEmail_(get(r, 'Agent Email'))
  })).filter(l => l.mls);
}

function fsoEmail_(s) {
  const e = String(s || '').split(/[\s,;]+/).find(x => FSO_EMAIL.test(x));
  return e ? e.toLowerCase() : '';
}

// "Julia Murtagh" → "Julia"; "J. Robert Smith" → "Robert"; "" → ""
function fsoFirstName_(name) {
  const w = String(name || '').replace(/\(.*?\)/g, ' ').split(/\s+/).filter(x => x && !/^[A-Z]\.?$/i.test(x));
  if (!w.length) return '';
  const f = w[0];
  return f === f.toUpperCase() ? f.charAt(0) + f.slice(1).toLowerCase() : f;
}

// "1908 Pennsylvania Ave, Richmond, CA 94801" → "1908 Pennsylvania Ave, Richmond"
function fsoShortAddr_(a) {
  const p = String(a || '').split(',').map(x => x.trim()).filter(Boolean);
  return p.length >= 3 ? p[0] + ', ' + p[1] : p.join(', ').replace(/\s+\d{5}(?:-\d{4})?$/, '');
}

function fsoDrafted_() {
  const v = fsoTab_().getDataRange().getValues(), i = v[0].indexOf('MLS #'), done = {};
  v.slice(1).forEach(r => { if (r[i]) done[String(r[i]).trim().toUpperCase()] = true; });
  return done;
}

function fsoTab_() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(FSO_TAB) || ss.insertSheet(FSO_TAB);
  const cur = sh.getRange(1, 1, 1, FSO_HEAD.length).getValues()[0];
  if (cur.join('|') !== FSO_HEAD.join('|')) {
    sh.getRange(1, 1, 1, FSO_HEAD.length).setValues([FSO_HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
