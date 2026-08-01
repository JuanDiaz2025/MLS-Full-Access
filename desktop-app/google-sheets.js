/**
 * Direct Google Sheets writer — no Apps Script, no Drive drop file.
 *
 * You sign in with your Google account inside the app, paste your spreadsheet
 * URL, and finished scans are written straight into the tab. That removes every
 * moving part that has caused trouble so far: no web app deployment, no
 * "Who has access" setting, no shared secret, no /exec URL, no waiting on a
 * 5-minute trigger.
 *
 * WHAT YOU HAVE TO SUPPLY ONCE — an OAuth client ID.
 * Google will not let an app request access to your spreadsheets unless the app
 * is registered against a Google Cloud project, and that project has to be
 * yours. It cannot be shipped inside the app or created on your behalf.
 *
 *   1. console.cloud.google.com -> create (or pick) a project
 *   2. APIs & Services -> Library -> enable "Google Sheets API"
 *   3. APIs & Services -> OAuth consent screen -> External -> add your own
 *      Google address under "Test users"
 *   4. Credentials -> Create credentials -> OAuth client ID -> **Desktop app**
 *   5. Copy the Client ID and Client secret into section 6 of the app
 *
 * The "client secret" of a desktop app is not really secret (Google says so
 * outright) — it identifies the app, it does not protect anything. Your account
 * is protected by the sign-in itself.
 *
 * Scope is limited to spreadsheets. The app cannot read your mail, your files,
 * or anything else.
 */
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

// `openid email` costs nothing extra and lets the app show WHICH Google account
// is connected — worth it, because signing in with the wrong account otherwise
// fails silently much later, at "you don't have permission to edit this sheet".
const SCOPE = 'openid email https://www.googleapis.com/auth/spreadsheets';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

const b64url = buf => buf.toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** PKCE pair — required for the desktop flow, and it means an intercepted
 *  redirect is useless without the verifier held in memory here. */
function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Pull the spreadsheet id out of whatever the user pasted — full URL or bare id. */
function parseSheetId(input) {
  const s = String(input || '').trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  return /^[a-zA-Z0-9-_]{20,}$/.test(s) ? s : '';
}

/**
 * Loopback OAuth. Google redirects to 127.0.0.1 on a port we open just for
 * this, so nothing is typed or copied by hand. `openUrl` is passed in (Electron
 * shell.openExternal) rather than imported, to keep this file testable.
 */
function signIn({ clientId, clientSecret, openUrl }) {
  return new Promise((resolve, reject) => {
    if (!clientId) return reject(new Error('No OAuth client ID — see the setup steps in google-sheets.js'));
    const { verifier, challenge } = pkce();
    const state = b64url(crypto.randomBytes(16));

    const server = http.createServer(async (req, res) => {
      try {
        const u = new URL(req.url, 'http://127.0.0.1');
        if (u.pathname !== '/oauth') { res.writeHead(404).end(); return; }
        if (u.searchParams.get('state') !== state) throw new Error('state mismatch — sign-in aborted');
        const err = u.searchParams.get('error');
        if (err) throw new Error('Google returned: ' + err);
        const code = u.searchParams.get('code');

        const port = server.address().port;
        const tok = await postForm(TOKEN_URL, {
          code, client_id: clientId, client_secret: clientSecret || '',
          redirect_uri: `http://127.0.0.1:${port}/oauth`,
          grant_type: 'authorization_code', code_verifier: verifier,
        });
        res.writeHead(200, { 'Content-Type': 'text/html' })
          .end('<h2>Signed in.</h2><p>You can close this tab and go back to FlipScout.</p>');
        server.close();
        if (!tok.access_token) throw new Error(tok.error_description || 'no access token returned');
        resolve({
          accessToken: tok.access_token,
          refreshToken: tok.refresh_token || '',
          expiresAt: Date.now() + (tok.expires_in || 3600) * 1000,
          email: emailFromIdToken(tok.id_token),
        });
      } catch (e) {
        try { res.writeHead(500).end('Sign-in failed: ' + e.message); } catch (_) {}
        server.close(); reject(e);
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const q = new URLSearchParams({
        client_id: clientId, redirect_uri: `http://127.0.0.1:${port}/oauth`,
        response_type: 'code', scope: SCOPE, state,
        code_challenge: challenge, code_challenge_method: 'S256',
        access_type: 'offline', prompt: 'consent',
      });
      openUrl(`${AUTH_URL}?${q}`);
    });
    server.on('error', reject);
    // Don't hang forever if the browser is closed without finishing. unref'd so
    // a completed sign-in doesn't hold the process open for the rest of the five
    // minutes (the reject itself is a no-op once the promise has settled).
    const t = setTimeout(() => {
      try { server.close(); } catch (_) {}
      reject(new Error('sign-in timed out after 5 minutes'));
    }, 300000);
    if (t.unref) t.unref();
  });
}

/** The email claim out of the id_token. Purely cosmetic — it names the account
 *  in the UI — so a malformed token means "unknown", never an error. */
function emailFromIdToken(jwt) {
  try {
    const body = String(jwt || '').split('.')[1];
    if (!body) return '';
    const json = Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json).email || '';
  } catch (_) { return ''; }
}

async function postForm(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  return r.json();
}

/** Access tokens last an hour; swap the refresh token for a fresh one. */
async function refresh({ clientId, clientSecret, refreshToken }) {
  const tok = await postForm(TOKEN_URL, {
    client_id: clientId, client_secret: clientSecret || '',
    refresh_token: refreshToken, grant_type: 'refresh_token',
  });
  if (!tok.access_token) throw new Error(tok.error_description || 'could not refresh the Google session — sign in again');
  return { accessToken: tok.access_token, expiresAt: Date.now() + (tok.expires_in || 3600) * 1000 };
}

async function api(token, path, opts) {
  const r = await fetch(SHEETS + path, Object.assign({
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  }, opts || {}));
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || `Sheets API ${r.status}`);
  return j;
}

const listTabs = (token, id) =>
  api(token, `/${id}?fields=properties.title,sheets.properties.title`)
    .then(j => ({ title: j.properties.title, tabs: j.sheets.map(s => s.properties.title) }));

const readCol = (token, id, tab, range) =>
  api(token, `/${id}/values/${encodeURIComponent(tab + '!' + range)}`)
    .then(j => (j.values || []).map(r => r[0]));

const appendRows = (token, id, tab, rows) =>
  api(token, `/${id}/values/${encodeURIComponent(tab + '!A1')}:append`
    + '?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS',
    { method: 'POST', body: JSON.stringify({ values: rows }) });

const writeRow = (token, id, tab, rowNum, values) =>
  api(token, `/${id}/values/${encodeURIComponent(tab + '!A' + rowNum)}`
    + '?valueInputOption=USER_ENTERED',
    { method: 'PUT', body: JSON.stringify({ values: [values] }) });

/** Create the tab and header row if they are not there yet. */
async function ensureTab(token, id, tab, headers) {
  const info = await listTabs(token, id);
  if (info.tabs.indexOf(tab) < 0) {
    await api(token, `/${id}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab } } }] }),
    });
  }
  const first = await readCol(token, id, tab, 'A1:A1');
  if (!first.length || String(first[0]).trim() !== headers[0]) {
    await writeRow(token, id, tab, 1, headers);
  }
  return info.title;
}

/** A1 column letter for a 0-based index — two-letter columns included, because
 *  the KPI tab is already 22 columns wide and A+index breaks past Z. */
function colName(i) {
  let s = '';
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s;
  return s;
}

/**
 * Append new rows and BACKFILL existing ones, keyed on a column (MLS #).
 * Same contract as the Apps Script version: never overwrite a cell that
 * already holds a value, so anything edited by hand on the sheet survives.
 *
 * `opts.overwrite` lists headers exempt from that rule — the app's own KPI
 * counters, which legitimately change through the day and must be replaced
 * rather than preserved. Everything not listed stays protected, which is how
 * the reviewer's columns survive an app push.
 */
async function syncRows(token, id, tab, headers, keyHeader, records, opts) {
  await ensureTab(token, id, tab, headers);
  const over = new Set((opts && opts.overwrite) || []);
  const keyCol = headers.indexOf(keyHeader);
  if (keyCol < 0) throw new Error(`key column "${keyHeader}" is not in the header row`);
  const colLetter = colName(keyCol);
  const existing = await readCol(token, id, tab, `${colLetter}2:${colLetter}`);
  const rowOf = {};
  existing.forEach((v, i) => { const k = String(v || '').trim().toUpperCase(); if (k) rowOf[k] = i + 2; });

  const toAppend = [], toPatch = [];
  for (const rec of records) {
    const key = String(rec[keyHeader] || '').trim().toUpperCase();
    const row = headers.map(h => (rec[h] == null ? '' : rec[h]));
    if (key && rowOf[key]) toPatch.push({ row: rowOf[key], values: row });
    else toAppend.push(row);
  }

  let filled = 0;
  for (const p of toPatch) {
    const cur = await api(token, `/${id}/values/${encodeURIComponent(tab + '!A' + p.row + ':' + p.row)}`)
      .then(j => (j.values && j.values[0]) || []);
    const merged = p.values.map((v, i) => {
      const had = cur[i];
      const mine = over.has(headers[i]);
      if (!mine && had !== undefined && String(had).trim() !== '') return had;  // keep what's there
      if (mine && (v === '' || v == null)) return had === undefined ? '' : had; // don't blank on a gap
      if (v !== '' && v != null) filled++;
      return v;
    });
    await writeRow(token, id, tab, p.row, merged);
  }
  if (toAppend.length) await appendRows(token, id, tab, toAppend);
  return { added: toAppend.length, updated: toPatch.length, filled };
}

module.exports = { parseSheetId, signIn, refresh, listTabs, readCol, ensureTab, syncRows, colName, SCOPE };
