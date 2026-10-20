// Getting a fresh REI BlackBook session when the old one lapses.
//
// This is the fragile part of the whole service, and it is fragile for a
// reason outside our control: REI has no API login. The only way in is the web
// form, and REI emails a verification code whenever it does not recognise the
// machine. A server's login will usually not be recognised.
//
// So re-login drives a real browser and reads the code out of a mailbox.
// Playwright is an OPTIONAL dependency: without it the service still runs and
// still pushes contacts on a session restored from disk — it simply cannot
// recover on its own when that session dies, and says so plainly.
//
// NOT YET VERIFIED END TO END. The login form was driven by hand from a
// developer machine; this code has not completed a cold login on a server with
// a code email. Expect to watch the first one.

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

const CODE = /\b(\d{6})\b/;

/** Most recent REI verification code to arrive, or "" if none is waiting. */
export async function readCode(mail, { since, log = console }) {
  if (!mail.enabled) return "";
  const client = new ImapFlow({
    host: mail.host, port: mail.port, secure: true,
    auth: { user: mail.user, pass: mail.pass }, logger: false
  });
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const found = [];
      for await (const msg of client.fetch({ since }, { source: true, envelope: true })) {
        const from = (msg.envelope?.from || []).map((a) => a.address || "").join(",");
        const subject = msg.envelope?.subject || "";
        if (!/reiblackbook/i.test(from) && !/verification|security code|confirm/i.test(subject)) continue;
        const parsed = await simpleParser(msg.source);
        const text = (parsed.text || "") + " " + (parsed.subject || "");
        const m = CODE.exec(text);
        if (m) found.push({ at: msg.envelope?.date || new Date(0), code: m[1] });
      }
      found.sort((a, b) => new Date(b.at) - new Date(a.at));
      if (found.length) log.info?.("rei: verification code found in mail");
      return found.length ? found[0].code : "";
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Returns a function the session calls when it needs new cookies, or null when
 * this box cannot log in by itself (no browser installed). Returning null is
 * deliberate: a clear "no re-login configured" beats a confusing timeout.
 */
export function makeRelogin(config, log = console) {
  return async function relogin() {
    let chromium;
    try {
      ({ chromium } = await import("playwright"));
    } catch {
      const e = new Error(
        "REI's session has expired and this server cannot log in again: Playwright is not installed. " +
        "Install it (npm i playwright && npx playwright install chromium) or refresh " + config.rei.statePath + " by hand."
      );
      e.code = "no_browser";
      throw e;
    }

    const startedAt = new Date();
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext();
    const pg = await ctx.newPage();
    try {
      log.info?.("rei: logging in as " + config.rei.user);
      await pg.goto(config.rei.base + "/services/account/login/", { waitUntil: "domcontentloaded", timeout: 60000 });
      await pg.fill('input[type="email"], input[name="email"], input[name="username"]', config.rei.user);
      await pg.fill('input[type="password"], input[name="password"]', config.rei.pass);
      await pg.click('button[type="submit"], input[type="submit"]');
      await pg.waitForTimeout(6000);

      // REI may now ask for the emailed code.
      const codeBox = pg.locator('input[name*="code" i], input[placeholder*="code" i]').first();
      if (await codeBox.count()) {
        if (!config.mail.enabled) {
          const e = new Error("REI asked for an emailed verification code and no mailbox is configured (MAIL_HOST…)");
          e.code = "needs_code";
          throw e;
        }
        let code = "";
        for (let i = 0; i < 10 && !code; i++) {
          await pg.waitForTimeout(6000);
          code = await readCode(config.mail, { since: startedAt, log }).catch(() => "");
        }
        if (!code) { const e = new Error("no REI verification code arrived within a minute"); e.code = "no_code"; throw e; }
        await codeBox.fill(code);
        await pg.click('button[type="submit"], input[type="submit"]');
        await pg.waitForTimeout(6000);
      }

      if (/login|sign-?in/i.test(pg.url())) {
        const e = new Error("still on the login page after signing in — check REI_USER / REI_PASS");
        e.code = "login_failed";
        throw e;
      }
      const jar = {};
      for (const c of await ctx.cookies()) {
        if (/reiblackbook/.test(c.domain)) jar[c.name] = c.value;
      }
      if (!Object.keys(jar).length) { const e = new Error("signed in but no cookies came back"); e.code = "no_cookies"; throw e; }
      return jar;
    } finally {
      await browser.close().catch(() => {});
    }
  };
}
