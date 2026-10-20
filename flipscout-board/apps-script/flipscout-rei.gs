/**
 * FlipScout → REI BlackBook bridge.
 *
 * Google hosts this, on Twin Home Buyer's own account, for nothing. That is the
 * whole point: the Lead Board cannot call REI BlackBook itself (a published
 * page may only call the viewer's connectors), and buying a server to do one
 * HTTP POST is silly. This is the same shape as the two bridges the board
 * already uses — flipscout-pass.gs and the Instantly one — a real link the
 * button opens, which does the work server-side and reports back.
 *
 * SETUP, once.
 *   1. Paste this into a new Apps Script project (script.google.com).
 *   2. Deploy ▸ New deployment ▸ Web app
 *        Execute as:  Me
 *        Who has access:  Anyone within Twin Home Buyer
 *      Copy the /exec URL.
 *   3. Run reiSetSession() below, having pasted a fresh cookie into it.
 *   4. Give Claude the /exec URL; it points the board's button here.
 *
 * THE SESSION COOKIE is the one weak link. REI has no API key: it authenticates
 * with a browser session, and refuses a login it does not recognise until a
 * code emailed to Bryan is entered. Apps Script cannot drive a browser, so it
 * cannot do that dance. It therefore carries a cookie, and when that cookie
 * dies the bridge says so loudly rather than failing quietly — see reiHealth().
 * Refreshing it is a one-minute job, documented at the bottom.
 */

var REI_BASE = 'https://my.reiblackbook.com';
var REI_PROFILE = '5289';      // the contact profile the Add Contact form saves into
var PHONE_TYPE = 'Mobile';     // Bryan's standing rule: every pushed agent is Mobile

/* ------------------------------------------------------------------ *
 *  The session
 * ------------------------------------------------------------------ */

/**
 * Paste a fresh cookie between the quotes and press Run. Get it from a browser
 * already signed in to REI: DevTools ▸ Application ▸ Cookies ▸ my.reiblackbook.com,
 * or the Network tab's "Cookie:" request header, copied whole.
 * Nothing is stored in this file — it goes into Script Properties.
 */
function reiSetSession() {
  var cookie = '';   // <-- paste here, then Run, then clear it again
  if (!cookie) throw new Error('Paste the cookie into reiSetSession() first.');
  PropertiesService.getScriptProperties().setProperty('REI_COOKIE', cookie.trim());
  Logger.log('Saved. Now run reiHealth() to check it works.');
}

function reiCookie_() {
  var c = PropertiesService.getScriptProperties().getProperty('REI_COOKIE');
  if (!c) throw new Error('No REI session stored — run reiSetSession() first.');
  return c;
}

/** Is the stored session still good? Run this any time; it changes nothing. */
function reiHealth() {
  try {
    var r = reiPost_('/services/account/getAccountInfo', '', 'form');
    Logger.log(r.signedOut ? 'SIGNED OUT — refresh the cookie with reiSetSession().'
                           : 'OK — the session works. ' + String(r.body).slice(0, 120));
    return !r.signedOut;
  } catch (e) {
    Logger.log('ERROR ' + e.message);
    return false;
  }
}

/**
 * One call to REI as the signed-in user.
 * kind: 'json' | 'form' | 'multipart' (payload is an object of flat keys).
 */
function reiPost_(path, payload, kind) {
  var opts = {
    method: 'post',
    headers: {
      'Cookie': reiCookie_(),
      'Accept': 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      // the app sends an empty Bearer beside the cookie; mirrored so the
      // request looks exactly like one REI already accepts
      'Authorization': 'Bearer '
    },
    muteHttpExceptions: true,
    followRedirects: false
  };
  if (kind === 'json') { opts.contentType = 'application/json'; opts.payload = JSON.stringify(payload || {}); }
  else if (kind === 'multipart') { opts.payload = payload; }        // Apps Script builds the multipart body
  else { opts.payload = payload || ''; }

  var res = UrlFetchApp.fetch(REI_BASE + path, opts);
  var code = res.getResponseCode();
  var body = res.getContentText();
  var ctype = (res.getHeaders()['Content-Type'] || res.getHeaders()['content-type'] || '');

  // REI answers a dead session with the LOGIN PAGE and a 200, so the status
  // code alone never tells you.
  var signedOut = code === 401 || code === 403 ||
    (ctype.indexOf('text/html') !== -1 &&
     /name=["']?password|services\/account\/login|sign\s*in<\//i.test(body.slice(0, 4000)));

  return { code: code, body: body, signedOut: signedOut, json: parseJson_(body) };
}

function parseJson_(s) { try { return JSON.parse(s); } catch (e) { return null; } }

/* ------------------------------------------------------------------ *
 *  Creating a contact
 * ------------------------------------------------------------------ */

/**
 * REI's save does not take {firstName, email}. It echoes back the WHOLE field
 * descriptor for every field on the form — type, key, label, icon, field_id,
 * display_type — with typed values nested under [value], as multipart. So the
 * shape is not invented here: getNewContact is asked for a blank contact and
 * the blanks are filled in. That survives REI renaming a field or moving an id.
 */
function reiCreateContact(c) {
  var blank = reiPost_('/profitdial/contacts/getNewContact', {}, 'json');
  if (blank.signedOut) return { ok: false, code: 'signed_out' };
  var fields = reiFields_(blank.json);
  if (!fields.length) return { ok: false, code: 'no_fields', detail: String(blank.body).slice(0, 200) };

  var payload = { removePending: 'true' };
  var filled = [];
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    var name = f.field_key || ((f.type && f.key) ? f.type + '_' + f.key : f.key);
    if (!name) continue;
    var key = String(f.key || '').toLowerCase();
    var want = reiValueFor_(key, c);
    if (want) filled.push(key);

    for (var k in f) {
      if (k === 'value') continue;
      var v = f[k];
      if (v === null || v === undefined) { payload[name + '[' + k + ']'] = ''; continue; }
      if (typeof v === 'object') continue;
      payload[name + '[' + k + ']'] = String(v);
    }
    var val = f.value;
    if (val && typeof val === 'object') {
      for (var sk in val) {
        var out = val[sk] === null || val[sk] === undefined ? '' : String(val[sk]);
        if (want && Object.prototype.hasOwnProperty.call(want, sk)) out = String(want[sk]);
        payload[name + '[value][' + sk + ']'] = out;
      }
    } else if (val !== undefined) {
      payload[name + '[value]'] = want && want.value !== undefined ? String(want.value) : (val === null ? '' : String(val));
    }
  }

  var save = reiPost_('/profitdial/profiles/saveProfileFieldValues/' + REI_PROFILE, payload, 'multipart');
  if (save.signedOut) return { ok: false, code: 'signed_out' };
  if (save.code >= 400) return { ok: false, code: 'http_' + save.code, detail: String(save.body).slice(0, 200) };
  return { ok: true, filled: filled, id: reiIdOf_(save.json) };
}

/** Values for the fields we know, matched on REI's own `key`. */
function reiValueFor_(key, c) {
  if (key === 'name') {
    return { honorific: '', first_name: c.first || '', middle_initial: c.middle || '', last_name: c.last || '' };
  }
  if (key === 'email' && c.email) {
    return { value: c.email, email: c.email, address: c.email };
  }
  if (key === 'phone' && c.phone) {
    // REI refuses to save a phone with no type, and Bryan's rule is Mobile.
    return { value: c.phone, number: c.phone, phone: c.phone,
             type: PHONE_TYPE, phone_type: PHONE_TYPE, label: PHONE_TYPE };
  }
  if (key === 'address' && (c.street || c.city || c.zip)) {
    return { address: c.street || '', address_1: c.street || '', street: c.street || '', address_2: '',
             city: c.city || '', state: c.state || '', zip: c.zip || '', zip_code: c.zip || '',
             country: c.country || 'United States', save_as_property: '', role: '' };
  }
  return null;
}

function reiFields_(payload) {
  if (!payload) return [];
  if (Object.prototype.toString.call(payload) === '[object Array]') return payload;
  var keys = ['fields', 'rows', 'data', 'items', 'results', 'profileFields'];
  for (var i = 0; i < keys.length; i++) {
    var v = payload[keys[i]];
    if (Object.prototype.toString.call(v) === '[object Array]') return v;
    if (v && typeof v === 'object') {
      for (var j = 0; j < keys.length; j++) {
        if (Object.prototype.toString.call(v[keys[j]]) === '[object Array]') return v[keys[j]];
      }
    }
  }
  var out = [];
  for (var k in payload) {
    var x = payload[k];
    if (x && typeof x === 'object' && (x.field_id || x.field_key)) out.push(x);
  }
  return out;
}

function reiIdOf_(j) {
  if (!j || typeof j !== 'object') return '';
  var direct = ['contact_id', 'contactId', 'id'];
  for (var i = 0; i < direct.length; i++) if (j[direct[i]]) return String(j[direct[i]]);
  var nest = ['data', 'contact', 'result'];
  for (var n = 0; n < nest.length; n++) {
    if (j[nest[n]] && typeof j[nest[n]] === 'object') { var v = reiIdOf_(j[nest[n]]); if (v) return v; }
  }
  return '';
}

/** REI's own duplicate checks — the same two the Add Contact form runs. */
function reiDuplicate_(c) {
  var hit = false;
  if (c.email) {
    var e = reiPost_('/profitdial/contacts/queryDuplicateEmails', { q: c.email, contact_id: '' }, 'json');
    hit = hit || reiAny_(e.json);
  }
  if (!hit && c.phone) {
    var d = String(c.phone).replace(/\D/g, '');
    var e164 = d.length === 10 ? '+1' + d : (d.length === 11 && d.charAt(0) === '1' ? '+' + d : '+' + d);
    var p = reiPost_('/profitdial/contacts/queryDuplicatePhones', { q: e164, contact_id: '' }, 'json');
    hit = hit || reiAny_(p.json);
  }
  return hit;
}

function reiAny_(j) {
  if (!j) return false;
  if (Object.prototype.toString.call(j) === '[object Array]') return j.length > 0;
  return !!(j.total || j.count || (j.rows && j.rows.length) || (j.data && j.data.length));
}

/* ------------------------------------------------------------------ *
 *  The web app the board's button opens
 * ------------------------------------------------------------------ */

function doGet(e) {
  var p = (e && e.parameter) || {};
  var c = {
    first: p.first || '', last: p.last || '', middle: p.middle || '',
    email: p.email || '', phone: p.phone || '',
    street: p.street || '', city: p.city || '', state: p.state || 'CA', zip: p.zip || ''
  };
  if (!c.first && !c.last) return page_('Nothing to create', 'That link carried no name.', false);

  var who = (c.first + ' ' + c.last).replace(/\s+/g, ' ').trim();
  try {
    if (p.force !== '1' && reiDuplicate_(c)) {
      return page_('Already in REI BlackBook',
        who + ' matches a contact that is already there, so nothing was created. ' +
        'Open REI and check before adding a second one.', true);
    }
    var r = reiCreateContact(c);
    if (r.ok) {
      return page_('✓ Created in REI BlackBook',
        who + ' is now a contact' + (r.id ? ' (#' + r.id + ')' : '') + '. You can close this tab.', true);
    }
    if (r.code === 'signed_out') {
      return page_('REI needs a new session',
        'The bridge\'s saved REI session has expired, so nothing was created. ' +
        'Refresh it with reiSetSession() in the Apps Script project — about a minute.', false);
    }
    return page_('Could not create it',
      who + ' was not created (' + r.code + '). ' + (r.detail || '') , false);
  } catch (err) {
    return page_('Could not create it', String(err.message || err), false);
  }
}

function page_(title, detail, ok) {
  var bg = ok ? '#D5F2E6' : '#FBDCE3', fg = ok ? '#146B4C' : '#8B1A36';
  var html =
    '<!doctype html><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
    'background:#EDF2F8;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#14202E}' +
    '.c{max-width:460px;background:#fff;border:1px solid #D3DEEB;border-radius:14px;padding:26px 28px;' +
    'box-shadow:0 10px 30px -18px rgba(18,40,70,.4)}' +
    'h1{font-size:19px;margin:0 0 8px;color:' + fg + '}' +
    '.p{display:inline-block;background:' + bg + ';color:' + fg + ';border-radius:999px;' +
    'padding:3px 11px;font-size:12px;font-weight:700;margin-bottom:12px}' +
    'p{margin:0;color:#57687C}</style>' +
    '<div class="c"><div class="p">FlipScout → REI BlackBook</div>' +
    '<h1>' + esc_(title) + '</h1><p>' + esc_(detail) + '</p></div>';
  return HtmlService.createHtmlOutput(html).setTitle('FlipScout → REI');
}

function esc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}

/* ------------------------------------------------------------------ *
 *  When the session dies
 * ------------------------------------------------------------------ *
 *
 * REI will eventually stop recognising the stored cookie. The bridge then
 * answers every push with "REI needs a new session" rather than failing
 * quietly, and reiHealth() returns false.
 *
 * To fix, about a minute:
 *   1. Sign in to REI BlackBook in a browser as normal.
 *   2. DevTools ▸ Application ▸ Cookies ▸ my.reiblackbook.com — or the
 *      Network tab's "Cookie:" request header — and copy the whole value.
 *   3. Paste it into reiSetSession() here, Run, then clear it from the file.
 *   4. reiHealth() should log OK.
 *
 * Making this self-healing needs a login that Apps Script can perform, and
 * REI's login is a browser form guarded by an emailed code. That is why the
 * server in flipscout-server/ exists: it drives a real browser and reads the
 * code out of Gmail. This bridge is the version that needs no machine at all,
 * at the cost of that minute every so often.
 */
