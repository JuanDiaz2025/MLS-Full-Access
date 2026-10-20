// REI answers an expired session with the login PAGE and a 200, so spotting it
// is the difference between re-authenticating and silently losing a push.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ReiSession } from "../src/rei/session.js";

const out = ReiSession.looksSignedOut;
const HTML = "text/html; charset=utf-8";
const JSON_ = "application/json";

test("401 and 403 are signed out whatever the body", () => {
  assert.equal(out(401, JSON_, "{}"), true);
  assert.equal(out(403, JSON_, "{}"), true);
});

test("a 200 that is really the login page is signed out", () => {
  assert.equal(out(200, HTML, '<form><input name="password" type="password"></form>'), true);
  assert.equal(out(200, HTML, '<a href="/services/account/login/">here</a>'), true);
  assert.equal(out(200, HTML, "<h1>Sign In</h1>"), true);
});

test("ordinary JSON is not signed out — even when it mentions a password", () => {
  assert.equal(out(200, JSON_, '{"ok":true}'), false);
  assert.equal(out(200, JSON_, '{"label":"password"}'), false,
    "a JSON body is never the login page, so it must not trip the check");
});

test("HTML that is simply a page is not signed out", () => {
  assert.equal(out(200, HTML, "<h1>Contacts</h1><table></table>"), false);
});

test("only the start of a long body is searched, so a stray word deep in a page is ignored", () => {
  const body = "<h1>Contacts</h1>" + "x".repeat(8000) + '<input name="password">';
  assert.equal(out(200, HTML, body), false);
});

test("cookies are absorbed from repeated Set-Cookie headers", async () => {
  const s = new ReiSession({ base: "https://x", statePath: "/tmp/none.json", log: {} });
  const res = { headers: { getSetCookie: () => ["a=1; Path=/; HttpOnly", "b=2; Secure"] } };
  assert.equal(s.absorb(res), true);
  assert.equal(s.cookieHeader(), "a=1; b=2");
});

test("absorbing the same cookies twice reports no change, so the session is not re-saved", () => {
  const s = new ReiSession({ base: "https://x", statePath: "/tmp/none.json", log: {} });
  const res = { headers: { getSetCookie: () => ["a=1; Path=/"] } };
  assert.equal(s.absorb(res), true);
  assert.equal(s.absorb(res), false);
});

test("a changed value replaces the old cookie", () => {
  const s = new ReiSession({ base: "https://x", statePath: "/tmp/none.json", log: {} });
  s.absorb({ headers: { getSetCookie: () => ["sid=old"] } });
  assert.equal(s.absorb({ headers: { getSetCookie: () => ["sid=new"] } }), true);
  assert.equal(s.cookieHeader(), "sid=new");
});

test("a trailing slash on the base never doubles up in a url", () => {
  const s = new ReiSession({ base: "https://x/", statePath: "/tmp/none.json", log: {} });
  assert.equal(s.base, "https://x");
});

test("with no re-login strategy, a lapsed session fails loudly rather than hanging", async () => {
  const s = new ReiSession({ base: "https://x", statePath: "/tmp/none.json", log: {} });
  await assert.rejects(() => s.ensureLogin(true), /no re-login strategy/);
});
