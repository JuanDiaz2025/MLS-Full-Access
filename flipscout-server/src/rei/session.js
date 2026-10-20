// A logged-in REI BlackBook session, kept alive across restarts.
//
// REI authenticates with a session cookie. There is no API key and no public
// API: every call below is one the web app itself makes, observed once from a
// real browser session. Two consequences shape this file.
//
//   1. The cookie is the credential. It is written to disk so a restart does
//      not trigger a fresh login, and a fresh login means REI emails a code.
//   2. Sessions expire. When they do, REI answers a normal-looking call with
//      a login page instead of JSON. That is the signal to re-authenticate —
//      not an HTTP error, so every call has to look at what came back.
//
// Re-login is deliberately a pluggable strategy rather than code here: the
// login form was never captured as an HTTP exchange, only driven in a browser.
// See relogin.js.

import fs from "node:fs/promises";
import path from "node:path";

export class ReiSession {
  constructor({ base, statePath, relogin = null, log = console }) {
    this.base = base.replace(/\/+$/, "");
    this.statePath = statePath;
    this.relogin = relogin;
    this.log = log;
    this.cookies = new Map();   // name -> value
    this.loading = null;
  }

  async load() {
    try {
      const raw = JSON.parse(await fs.readFile(this.statePath, "utf8"));
      for (const [k, v] of Object.entries(raw.cookies || {})) this.cookies.set(k, v);
      this.log.info?.("rei: restored " + this.cookies.size + " cookies from " + this.statePath);
    } catch {
      this.log.info?.("rei: no saved session at " + this.statePath);
    }
  }

  async save() {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    const body = { cookies: Object.fromEntries(this.cookies), savedAt: new Date().toISOString() };
    await fs.writeFile(this.statePath, JSON.stringify(body, null, 2), { mode: 0o600 });
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => k + "=" + v).join("; ");
  }

  absorb(res) {
    // Node exposes repeated Set-Cookie headers through getSetCookie()
    const list = typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
    let changed = false;
    for (const line of list) {
      const first = String(line).split(";")[0];
      const eq = first.indexOf("=");
      if (eq < 1) continue;
      const name = first.slice(0, eq).trim(), value = first.slice(eq + 1).trim();
      if (!name) continue;
      if (this.cookies.get(name) !== value) { this.cookies.set(name, value); changed = true; }
    }
    return changed;
  }

  // A reply that is really "your session has gone". REI answers with the login
  // page and a 200, so the status code alone never tells you.
  static looksSignedOut(status, contentType, text) {
    if (status === 401 || status === 403) return true;
    const html = (contentType || "").includes("text/html");
    return html && /name=["']?password|services\/account\/login|sign\s*in<\//i.test(text.slice(0, 4000));
  }

  /**
   * One call to REI as the signed-in user. `form` may be a FormData (multipart,
   * as the save calls use), a plain object (sent as JSON), or a string.
   * Retries once through the re-login strategy if the session has lapsed.
   */
  async call(pathname, { form = null, json = null, body = null, method = "POST", retry = true } = {}) {
    const url = pathname.startsWith("http") ? pathname : this.base + pathname;
    const headers = {
      "Cookie": this.cookieHeader(),
      "Accept": "application/json, text/plain, */*",
      "X-Requested-With": "XMLHttpRequest",
      // The app sends an empty Bearer alongside the cookie; mirrored so the
      // request looks exactly like the ones REI already accepts.
      "Authorization": "Bearer "
    };
    let payload = body;
    if (form) payload = form;                       // fetch sets the multipart boundary
    else if (json !== null) { payload = JSON.stringify(json); headers["Content-Type"] = "application/json"; }

    const res = await fetch(url, { method, headers, body: payload, redirect: "manual" });
    if (this.absorb(res)) await this.save();

    const ctype = res.headers.get("content-type") || "";
    const text = await res.text();

    if (ReiSession.looksSignedOut(res.status, ctype, text)) {
      if (!retry || !this.relogin) {
        const e = new Error("REI BlackBook signed us out and no re-login is configured");
        e.code = "signed_out";
        throw e;
      }
      this.log.warn?.("rei: session lapsed, re-authenticating");
      await this.ensureLogin(true);
      return this.call(pathname, { form, json, body, method, retry: false });
    }
    if (res.status >= 400) {
      const e = new Error("REI " + res.status + " on " + pathname + ": " + text.slice(0, 200));
      e.code = "http_" + res.status;
      throw e;
    }
    if (ctype.includes("application/json")) {
      try { return JSON.parse(text); } catch { return text; }
    }
    return text;
  }

  // Serialised: several queued pushes must never start separate logins, which
  // would send several verification emails and invalidate each other.
  async ensureLogin(force = false) {
    if (!this.relogin) {
      if (force) { const e = new Error("no re-login strategy configured"); e.code = "no_relogin"; throw e; }
      return;
    }
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const cookies = await this.relogin();
        this.cookies = new Map(Object.entries(cookies));
        await this.save();
        this.log.info?.("rei: signed in, session saved");
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  // Cheap signed-in check: an endpoint the app itself calls on every page load.
  async whoami() {
    return this.call("/services/account/getAccountInfo", { body: "" });
  }
}
