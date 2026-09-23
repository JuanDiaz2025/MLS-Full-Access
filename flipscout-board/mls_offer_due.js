#!/usr/bin/env node
/*
 * Read offer deadlines out of MLSListings for the leads on the board.
 *
 *   node mls_offer_due.js login            sign in once, save the session
 *   node mls_offer_due.js recon [url]      dump a page's fields so the
 *                                          offer-due field can be located
 *   node mls_offer_due.js fetch ML8206...  print {"<MLS #>": "YYYY-MM-DD"}
 *
 * CREDENTIALS COME FROM THE ENVIRONMENT, NEVER FROM A FILE OR AN ARGUMENT:
 *
 *   MLS_USERNAME   the MLSListings sign-in name
 *   MLS_PASSWORD   its password
 *
 * Nothing here prints, logs, or writes either one. Set them as environment
 * variables on the Claude Code environment so the scheduled refresh inherits
 * them without them ever passing through a conversation or this repository.
 *
 * `login` writes mls-session.json — the signed-in browser session. That file
 * is credential-equivalent: it is gitignored, and anyone holding it can act
 * as the account until it expires. It exists so the daily run does not have
 * to sign in every morning.
 *
 * Sign-in is Azure AD B2C. If the account has multi-factor enabled, an
 * unattended run CANNOT complete it — the script says so and stops rather
 * than hanging. See the README for what to do in that case.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const SESSION = path.join(__dirname, "mls-session.json");
const CHROME = process.env.MLS_CHROME ||
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const LOGIN_URL =
  "https://mlslpro.b2clogin.com/mlslpro.onmicrosoft.com/oauth2/v2.0/authorize" +
  "?p=B2C_1_SocialLocalSignInNewPro" +
  "&client_id=c43dcffb-386e-4173-9221-d468e386b2d8&nonce=defaultNonce" +
  "&redirect_uri=https%3A%2F%2Fconnect.mlslistings.com%2Fazureadloginresponder.ashx" +
  "&scope=openid&response_type=id_token&prompt=login&response_mode=query";

// B2C policies name these fields differently depending on how the policy was
// authored, so try the known spellings rather than betting on one.
const USER_FIELDS = ["#signInName", "#email", "#logonIdentifier",
                     'input[name="signInName"]', 'input[type="email"]'];
const PASS_FIELDS = ["#password", 'input[name="password"]',
                     'input[type="password"]'];
const SUBMIT = ["#next", "#continue", 'button[type="submit"]',
                'input[type="submit"]'];

const MFA_HINTS = /verification code|multi-factor|two-step|authenticator|send code|one-time/i;

function credentials() {
  const user = process.env.MLS_USERNAME;
  const pass = process.env.MLS_PASSWORD;
  if (!user || !pass) {
    console.error(
      "MLS_USERNAME and MLS_PASSWORD are not set in this environment.\n" +
      "Set them on the Claude Code environment (Settings -> Environments ->\n" +
      "environment variables). Do not put them in a file, an argument, or a\n" +
      "chat message."
    );
    process.exit(2);
  }
  return { user, pass };
}

async function firstVisible(page, selectors, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const el = page.locator(sel).first();
      if (await el.count() && await el.isVisible().catch(() => false)) return el;
    }
    await page.waitForTimeout(250);
  }
  return null;
}

async function browser() {
  return chromium.launch({ executablePath: CHROME });
}

async function context(b, { fresh = false } = {}) {
  const opts = {
    viewport: { width: 1440, height: 1000 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  };
  if (!fresh && fs.existsSync(SESSION)) opts.storageState = SESSION;
  return b.newContext(opts);
}

async function login() {
  const { user, pass } = credentials();
  const b = await browser();
  const ctx = await context(b, { fresh: true });
  const page = await ctx.newPage();
  try {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

    const userField = await firstVisible(page, USER_FIELDS);
    if (!userField) throw new Error(
      "No sign-in field on the login page. The B2C policy may have changed — " +
      "run `recon` against the login URL and compare the field names.");
    await userField.fill(user);

    // some policies ask for the name first, then reveal the password
    let passField = await firstVisible(page, PASS_FIELDS, 2000);
    if (!passField) {
      const next = await firstVisible(page, SUBMIT, 4000);
      if (next) await next.click();
      passField = await firstVisible(page, PASS_FIELDS, 12000);
    }
    if (!passField) throw new Error("No password field appeared after the sign-in name.");
    await passField.fill(pass);

    const submit = await firstVisible(page, SUBMIT, 6000);
    if (!submit) throw new Error("No submit button on the sign-in form.");
    await Promise.all([
      page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {}),
      submit.click(),
    ]);
    await page.waitForTimeout(4000);

    const body = await page.evaluate(() => document.body.innerText).catch(() => "");
    if (MFA_HINTS.test(body)) {
      console.error(
        "Sign-in reached a multi-factor prompt, which an unattended run cannot " +
        "answer.\nThis account cannot be automated from a scheduled job while " +
        "MFA is on every sign-in.\nSee flipscout-board/README.md for the options."
      );
      process.exit(3);
    }
    if (/incorrect|invalid|try again/i.test(body) && /password|sign.?in/i.test(body)) {
      console.error("Sign-in was rejected. Check MLS_USERNAME / MLS_PASSWORD.");
      process.exit(4);
    }

    await ctx.storageState({ path: SESSION });
    console.log("Signed in. Landed on: " + page.url());
    console.log("Session saved to " + SESSION + " (gitignored, treat as a credential).");
  } finally {
    await b.close();
  }
}

// Dump a page's structure so the offer-due field can actually be located,
// instead of guessing selectors against a page nobody has seen.
async function recon(url) {
  const b = await browser();
  const ctx = await context(b);
  const page = await ctx.newPage();
  try {
    await page.goto(url || "https://prodashboard.mlslistings.com/",
                    { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000);

    const out = {
      url: page.url(),
      title: await page.title(),
      signedIn: !/b2clogin|login/i.test(page.url()),
      frames: page.frames().map(f => f.url()).filter(u => u && u !== "about:blank"),
      // anything that looks like a labelled field, plus any text mentioning offers
      pairs: await page.evaluate(() => {
        const seen = [];
        document.querySelectorAll("td,th,div,span,label,dt,dd").forEach(el => {
          if (el.children.length) return;
          const t = (el.innerText || "").trim();
          if (t && t.length < 120) seen.push(t);
        });
        return seen.slice(0, 1200);
      }),
    };
    out.offerMentions = out.pairs.filter(t => /offer|due|deadline|present/i.test(t));

    const file = path.join(__dirname, "recon.json");
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    await page.screenshot({ path: path.join(__dirname, "recon.png"), fullPage: true });
    console.log("url:        " + out.url);
    console.log("signed in:  " + out.signedIn);
    console.log("offer-ish text found: " + out.offerMentions.length);
    out.offerMentions.slice(0, 20).forEach(t => console.log("   " + t));
    console.log("full dump -> " + file + " and recon.png");
  } finally {
    await b.close();
  }
}

/*
 * Fetch offer deadlines for the given MLS numbers.
 *
 * Deliberately unimplemented: the selector for the offer-due field has to come
 * from a real signed-in listing page, and nobody has seen one yet. Guessing it
 * would produce a script that silently returns nothing, or worse, returns the
 * wrong date and sends the team chasing a deadline that does not exist.
 * Run `login` then `recon <a listing url>` first; the dump names the field,
 * and this function gets written against it.
 */
async function fetch_(mlsNumbers) {
  if (!fs.existsSync(SESSION)) {
    console.error("No saved session. Run `node mls_offer_due.js login` first.");
    process.exit(2);
  }
  console.error(
    "fetch is not wired up yet: the offer-due field has not been located on a\n" +
    "real listing page. Run `recon <listing url>` while signed in and the dump\n" +
    "will name it. Asked for: " + mlsNumbers.join(", ")
  );
  process.exit(5);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "login") return login();
  if (cmd === "recon") return recon(rest[0]);
  if (cmd === "fetch") {
    if (!rest.length) { console.error("fetch needs at least one MLS number."); process.exit(1); }
    return fetch_(rest);
  }
  console.error(require("fs").readFileSync(__filename, "utf8").split("*/")[0]);
  process.exit(1);
}

main().catch(err => { console.error(String(err && err.message || err)); process.exit(1); });
