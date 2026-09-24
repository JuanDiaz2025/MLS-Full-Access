/**
 * FlipScout — automatic listing-agent emails through Instantly.
 *
 * Lives in the prod sheet next to flip-scout-reject.gs and flipscout-alerts.gs,
 * and uses FS_LEADS, FS_PASSED, FS_CLOSED, fsPost_ and fsSafeEmail_ from the
 * alerts file (same project, one namespace). Prefix fsi.
 *
 * The pair: Instantly SENDS (3-step campaign, stop on reply). This script
 * decides WHO and brings the results back.
 *
 *  Every hour (fsiHourly)
 *    1. Stop leads that should not get more emails: listing pending / sold /
 *       withdrawn, passed in Notes (Board passes land there), "no emails" in
 *       Notes, or gone from Leads (rejected). Stopping = removing the lead
 *       from the campaign (Instantly's API has no pause for one lead).
 *    2. If automatic adding is ON: add new A leads — Active on the MLS, a
 *       valid agent email, not passed, offer deadline not past, never added
 *       before — up to FSI_DAILY_MAX a day, soonest deadline first.
 *  Every 15 minutes (fsiReplies)
 *    3. Read new replies from Instantly. Mark the lead Replied, keep the
 *       reply, read an offer deadline out of it by rules, and post it to
 *       Google Chat (🚨 NEEDS JUAN when it asks for a call, talks price, etc.).
 *    4. The agent's deadline goes into Offer Due on Leads when Offer Due is
 *       blank or TBD — and goes back in if the app's Refresh blanks it, since
 *       Refresh rewrites Offer Due from the MLS remarks.
 *
 *  The Board's "✉ Email agent" button adds one lead on demand (fsiWebEmail_,
 *  reached through doGet in flipscout-alerts.gs).
 *
 *  Everything is logged on the "Agent Emails" tab (one row per property).
 *
 * SETUP (once)
 *   Script Properties: INSTANTLY_API_KEY = <key>   (never in git or chat)
 *   Paste this file, save, run fsiSetup, approve, reload the sheet.
 *   Automatic adding starts OFF. Test with "Add TEST lead", then turn it on
 *   from the menu.
 */

const FSI_CAMPAIGN = '98ab8360-fe96-4bf5-812a-d8903f8bd5a8';
const FSI_API = 'https://api.instantly.ai/api/v2';
const FSI_TAB = 'Agent Emails';
const FSI_DAILY_MAX = 10;
const FSI_TEST = { mls: 'TEST0001', email: 'bryan@twinhomebuyer.com', first: 'Bryan', addr: '123 Test Street, San Francisco, CA 94112' };
const FSI_HEAD = ['Added On', 'MLS #', 'Address', 'Agent', 'Agent Email', 'Status', 'Replied On',
                  'Agent Offer Due', 'Needs Juan', 'Reply', 'Stopped On', 'Stop Reason', 'Instantly Lead ID', 'Added By'];
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
  const c = fsiApi_('get', '/campaigns/' + FSI_CAMPAIGN);   // throws if the key or campaign is wrong
  Logger.log('Connected to "' + c.name + '". Automatic adding is ' + (fsiAuto_() ? 'ON' : 'OFF') +
             '. Reload the sheet for the ✉️ FlipScout Emails menu.');
}

function fsiOnOpen() {
  const on = fsiAuto_();
  SpreadsheetApp.getUi().createMenu('✉️ FlipScout Emails')
    .addItem('Check Instantly connection', 'fsiCheck')
    .addItem('Preview — who would be added next (adds nothing)', 'fsiPreview')
    .addSeparator()
    .addItem('Add TEST lead (' + FSI_TEST.email + ')', 'fsiAddTest')
    .addItem('Check replies now', 'fsiRepliesNow')
    .addItem('Stop emails for the selected row(s)', 'fsiStopSelected')
    .addSeparator()
    .addItem(on ? 'Automatic adding is ON — turn OFF' : 'Automatic adding is OFF — turn ON', 'fsiToggleAuto')
    .addItem('Add new leads now (up to ' + FSI_DAILY_MAX + ' a day)', 'fsiAddNow')
    .addToUi();
}

/* -------------------------------------------------------------- menu ---- */

function fsiCheck() {
  const ui = SpreadsheetApp.getUi();
  let c;
  try { c = fsiApi_('get', '/campaigns/' + FSI_CAMPAIGN); }
  catch (e) { ui.alert('Instantly connection failed', String(e.message || e), ui.ButtonSet.OK); return; }
  const status = { 0: 'Draft (not launched)', 1: 'Active', 2: 'Paused', 3: 'Completed', 4: 'Running subsequences',
                   '-1': 'Accounts unhealthy', '-2': 'Bounce protect', '-99': 'Account suspended' }[c.status] || String(c.status);
  const steps = ((c.sequences || [])[0] || {}).steps || [];
  const bodies = steps.map(s => ((s.variants || [])[0] || {}).body || '').join(' ') +
                 steps.map(s => ((s.variants || [])[0] || {}).subject || '').join(' ');
  const warn = [];
  if (!c.stop_on_reply) warn.push('• "Stop sending emails on reply" is OFF — turn it on.');
  if (steps.length !== 3) warn.push('• The campaign has ' + steps.length + ' email step(s); we planned 3.');
  if (!/\{\{\s*address\s*\}\}/.test(bodies)) warn.push('• No {{address}} found in the emails.');
  if (!/\{\{\s*firstName\s*\}\}/.test(bodies)) warn.push('• No {{firstName}} found in the emails.');
  const t = fsiTab_().getDataRange().getValues().slice(1);
  const count = s => t.filter(r => String(r[5]).indexOf(s) === 0).length;
  ui.alert('Instantly: connected ✓',
    'Campaign: ' + c.name + '\nStatus: ' + status +
    '\nSending from: ' + ((c.email_list || []).join(', ') || '(no inbox attached)') +
    '\nEmail steps: ' + steps.length + ' · Stop on reply: ' + (c.stop_on_reply ? 'on' : 'OFF') +
    '\n\nAutomatic adding: ' + (fsiAuto_() ? 'ON' : 'OFF') +
    '\nOn the Agent Emails tab: ' + count('Emailing') + ' emailing · ' + count('Replied') + ' replied · ' + count('Stopped') + ' stopped' +
    (warn.length ? '\n\nTo fix:\n' + warn.join('\n') : '') +
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

function fsiAddTest() {
  const ui = SpreadsheetApp.getUi();
  // a finished test (replied / completed) is cleared so Instantly takes it again
  fsiRows_().filter(r => r.mls === FSI_TEST.mls && r.status !== 'Stopped').forEach(r => fsiStop_(r, 'Replaced by a new test'));
  fsiAddOne_({ mls: FSI_TEST.mls, addr: FSI_TEST.addr, agent: FSI_TEST.first + ' Test', email: FSI_TEST.email }, fsSafeEmail_() || 'menu');
  ui.alert('TEST lead added',
    FSI_TEST.email + ' is in the campaign as "' + fsiShort_(FSI_TEST.addr) + '".\n\n' +
    '1. In Instantly, click Launch (it only has this one lead).\n' +
    '2. The first email reaches ' + FSI_TEST.email + ' within the sending hours.\n' +
    '3. Reply to it, e.g. "Offers due Monday at 5pm, call me".\n' +
    '4. Within 15 minutes (or use "Check replies now") the Agent Emails tab says Replied and Google Chat gets the message.',
    ui.ButtonSet.OK);
}

function fsiRepliesNow() {
  const n = fsiReplies();
  SpreadsheetApp.getActive().toast(n ? n + ' new repl' + (n === 1 ? 'y' : 'ies') + ' — see the Agent Emails tab and Google Chat.'
                                     : 'No new replies.', 'FlipScout Emails', 8);
}

function fsiToggleAuto() {
  const on = !fsiAuto_();
  PropertiesService.getScriptProperties().setProperty('FSI_AUTO', on ? 'on' : 'off');
  SpreadsheetApp.getActive().toast('Automatic adding is ' + (on ? 'ON — new A leads go to Instantly every hour.' : 'OFF.') +
                                   ' Reload the sheet to refresh the menu.', 'FlipScout Emails', 8);
}

function fsiAddNow() {
  const n = fsiAddNew_(new Date());
  SpreadsheetApp.getActive().toast(n ? n + ' lead(s) added to Instantly.' : 'Nothing to add (see Preview for why).', 'FlipScout Emails', 8);
}

// Rows selected on the Agent Emails tab, or lead rows selected on Leads.
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
  const rows = fsiRows_().filter(r => want[r.mls] && r.status === 'Emailing');
  if (!rows.length) { ui.alert('None of the selected leads are being emailed right now.'); return; }
  rows.forEach(r => fsiStop_(r, 'Stopped by ' + who));
  ui.alert('Stopped ' + rows.length + ' lead(s). Instantly will send them nothing more.');
}

/* ------------------------------------------------------ the timed jobs -- */

function fsiHourly() {
  fsiLocked_(() => {
    const now = new Date();
    fsiStops_(now);
    if (fsiAuto_()) fsiAddNew_(now);
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

/* -------------------------------------------------------------- adding -- */

function fsiPick_(now) {
  const rows = fsiRows_(), have = {}, busy = {};
  rows.forEach(r => { have[r.mls] = true; if (r.status === 'Emailing') busy[r.email] = r.addr; });
  const today = Utilities.formatDate(now, FSI_TZ, 'yyyy-MM-dd');
  const addedToday = rows.filter(r => r.mls !== FSI_TEST.mls && r.added && Utilities.formatDate(new Date(r.added), FSI_TZ, 'yyyy-MM-dd') === today).length;
  const room = Math.max(0, FSI_DAILY_MAX - addedToday);
  const ok = [], skipped = {};
  const skip = why => { skipped[why] = (skipped[why] || 0) + 1; };
  fsiLeads_().forEach(l => {
    if (!/^A/i.test(l.bucket)) return;
    if (have[l.mls]) return skip('already emailed');
    if (FS_PASSED.test(l.notes)) return skip('passed in Notes');
    if (FSI_NO_EMAIL_NOTE.test(l.notes)) return skip('"no emails" in Notes');
    if (!/^active$/i.test(l.mstat)) return skip(l.mstat ? 'not Active on the MLS' : 'no MLS status');
    if (!l.email) return skip('no agent email');
    const d = fsiDeadline_(l.due);
    if (d && d < now) return skip('offer deadline passed');
    if (busy[l.email]) return skip('agent already being emailed about another house');
    ok.push(l);
  });
  const t = l => { const d = fsiDeadline_(l.due); return d ? d.getTime() : Infinity; };
  ok.sort((a, b) => t(a) - t(b) || (+b.score || 0) - (+a.score || 0));
  // one house per agent at a time: Instantly keeps one lead per email per campaign
  const seen = {}, list = [];
  ok.forEach(l => { if (!seen[l.email] && list.length < room) { seen[l.email] = true; list.push(l); } });
  return { list, room, eligible: ok.length, skipped };
}

function fsiAddNew_(now) {
  const p = fsiPick_(now);
  let n = 0;
  p.list.forEach(l => { try { fsiAddOne_(l); n++; } catch (e) { fsiErr_('adding ' + l.mls + ': ' + e.message); } });
  return n;
}

function fsiAddOne_(l, by) {
  const first = fsiFirst_(l.agent);
  const res = fsiApi_('post', '/leads', {
    campaign: FSI_CAMPAIGN, email: l.email, first_name: first,
    last_name: String(l.agent || '').split(/\s+/).slice(1).join(' '),
    custom_variables: { address: fsiShort_(l.addr), full_address: l.addr, mls: l.mls },
    skip_if_in_campaign: true
  });
  if (!res || !res.id) throw new Error('Instantly did not add ' + l.email + ' (already in the campaign?)');
  fsiTab_().appendRow([new Date(), l.mls, l.addr, l.agent, l.email, 'Emailing', '', '', '', '', '', '', res.id, by || 'Automatic']);
}

/* ----------------------------------------- the Board's Email button -- */

// doGet (flipscout-alerts.gs) sends action=email here. A person chose this
// lead, so any bucket is fine; the safety checks still apply.
function fsiWebEmail_(mls, by) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return fsPage_('Busy', 'FlipScout is updating right now. Close this tab and click the button again in a minute.');
  try {
    let l;
    if (mls === FSI_TEST.mls) {
      // the test lead: clear the previous test so Instantly takes it again
      fsiRows_().filter(r => r.mls === FSI_TEST.mls && r.status !== 'Stopped').forEach(r => fsiStop_(r, 'Replaced by a new test'));
      l = { mls, addr: FSI_TEST.addr, agent: FSI_TEST.first + ' Test', email: FSI_TEST.email, notes: '', mstat: 'Active' };
    } else {
      l = fsiLeads_().find(x => x.mls === mls);
      if (!l) return fsPage_('Lead not on the sheet', mls + ' is not on the Leads tab (it may have been rejected). Nothing was sent.');
      const done = fsiRows_().filter(r => r.mls === mls).pop();
      if (done) return fsPage_('Already emailed', fsiShort_(l.addr) + ' was handed to Instantly on ' +
        Utilities.formatDate(new Date(done.added), FSI_TZ, 'MMM d') + ' (' + done.status.toLowerCase() + '). See the Agent Emails tab.');
      if (!l.email) return fsPage_('No agent email', 'The sheet has no agent email for ' + fsiShort_(l.addr) + '. Nothing was sent.');
      if (FS_PASSED.test(l.notes)) return fsPage_('Passed', fsiShort_(l.addr) + ' is marked PASS in Notes. Nothing was sent.');
      if (FS_CLOSED.test(l.mstat) || FSI_PENDING.test(l.mstat)) return fsPage_('Not active', fsiShort_(l.addr) + ' is ' + l.mstat.toLowerCase() + ' on the MLS. Nothing was sent.');
      const busy = fsiRows_().find(r => r.email === l.email && r.status === 'Emailing');
      if (busy) return fsPage_('Agent already in the campaign', (l.agent || l.email) + ' is already being emailed about ' + fsiShort_(busy.addr) +
        '. Instantly holds one email per agent at a time, so this one waits until that finishes.');
    }
    fsiAddOne_(l, by);
    return fsPage_('✓ Sent to Instantly', fsiShort_(l.addr) + ' → ' + (l.agent || 'the agent') + ' <' + l.email + '>. ' +
      'Instantly sends the first email within the campaign\'s sending hours, then the follow-ups; it stops when the agent replies. You can close this tab.');
  } catch (e) {
    fsiErr_('Board email ' + mls + ': ' + e.message);
    return fsPage_('Not sent', 'Instantly refused it: ' + e.message);
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------ stopping -- */

function fsiStops_(now) {
  const leads = {};
  fsiLeads_().forEach(l => { leads[l.mls] = l; });
  fsiRows_().filter(r => r.status === 'Emailing' && r.mls !== FSI_TEST.mls).forEach(r => {
    const l = leads[r.mls];
    const why = !l ? 'Lead is no longer on the Leads tab'
      : FS_CLOSED.test(l.mstat) ? 'Listing ' + l.mstat.toLowerCase()
      : FSI_PENDING.test(l.mstat) ? 'Listing ' + l.mstat.toLowerCase()
      : FS_PASSED.test(l.notes) ? 'Passed in Notes'
      : FSI_NO_EMAIL_NOTE.test(l.notes) ? '"no emails" in Notes' : '';
    if (why) { try { fsiStop_(r, why); } catch (e) { fsiErr_('stopping ' + r.mls + ': ' + e.message); } }
  });
}

function fsiStop_(r, why) {
  if (r.id) {
    try { fsiApi_('delete', '/leads/' + r.id); }
    catch (e) { if (!/\b404\b/.test(e.message)) throw e; }    // already gone is fine
  }
  const sh = fsiTab_();
  sh.getRange(r.row, 6).setValue('Stopped');
  sh.getRange(r.row, 11, 1, 2).setValues([[new Date(), why]]);
}

/* ------------------------------------------------------------- replies -- */

function fsiReadReplies_() {
  const props = PropertiesService.getScriptProperties();
  const since = props.getProperty('FSI_REPLY_SINCE') || '';
  let seen = [];
  try { seen = JSON.parse(props.getProperty('FSI_REPLY_SEEN') || '[]'); } catch (e) {}
  const res = fsiApi_('get', '/emails?campaign_id=' + FSI_CAMPAIGN + '&email_type=received&sort_order=desc&limit=100');
  const items = (res && res.items || []).filter(m => (!since || String(m.timestamp_email || m.timestamp_created) >= since) && seen.indexOf(m.id) < 0);
  if (!items.length) return 0;

  const rows = fsiRows_(), sh = fsiTab_(), news = [];
  items.slice().reverse().forEach(m => {                       // oldest first
    const from = String(m.lead || m.from_address_email || '').toLowerCase();
    const r = rows.filter(x => x.email === from && x.status !== 'Stopped').pop() || rows.filter(x => x.email === from).pop();
    if (!r) return;                                            // not one of ours
    const when = new Date(m.timestamp_email || m.timestamp_created || Date.now());
    const text = fsiStripQuote_((m.body && (m.body.text || fsiHtmlText_(m.body.html))) || m.content_preview || '');
    const due = fsiReplyDue_(text, when);
    const juan = fsiNeedsJuan_(text, due, when);
    sh.getRange(r.row, 6, 1, 5).setValues([['Replied', when, due || r.agentDue || '', juan || '', text.slice(0, 1500)]]);
    r.status = 'Replied'; r.agentDue = due || r.agentDue;
    news.push({ r, text, due, juan });
  });
  const newest = items.map(m => String(m.timestamp_email || m.timestamp_created || '')).sort().pop();
  props.setProperty('FSI_REPLY_SINCE', newest || since);
  props.setProperty('FSI_REPLY_SEEN', JSON.stringify(seen.concat(items.map(m => m.id)).slice(-300)));
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
    const r = n.r, test = r.mls === FSI_TEST.mls;
    return [
      (test ? '🧪 TEST — ' : '') + '*' + r.addr + '*',
      (r.agent || 'Agent') + ' <' + r.email + '>',
      '“' + (n.text.length > 220 ? n.text.slice(0, 217).trim() + '…' : n.text) + '”',
      n.due ? '⏰ Offers due: *' + n.due + '* (read from the reply — confirm)' : '',
      n.juan ? '🚨 ' + n.juan : '',
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
    email: String(r[4]).trim().toLowerCase(), status: String(r[5]), agentDue: String(r[7] || ''), id: String(r[12] || '')
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

function fsiAuto_() { return fsiProp_('FSI_AUTO') === 'on'; }
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
