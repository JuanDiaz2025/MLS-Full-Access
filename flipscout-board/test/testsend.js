// Send ONE test text from Seth's Google Voice, (510) 214-3561, to Bryan's,
// (510) 394-5339 — run on SETH's machine, for the FlipScout Board Test's
// TEST LEAD only (Seth, 24 Oct: "You send, Bryan receives").
//
// A copy of rei/gvsend.js (branch claude/laughing-lamport-cmllyv), which sends
// from Bryan's Voice on his machine, with one change: it texts Bryan's number
// and nobody else. The Test board is a copy of the real board with real agents
// on it, so a reply queued there to anyone but the test agent must never go
// out; this refuses it here, whatever the queue says.
//
// It never handles a password, a code or a cookie: it ATTACHES to a Chrome
// Seth has already started and signed in to voice.google.com himself.
//
// ONE-TIME SETUP, on Seth's machine:
//   1. Quit Chrome completely.
//   2. Start it with the debugging port open:
//        macOS   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222
//        Windows "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
//   3. Sign in to voice.google.com in that window, by hand, as (510) 214-3561.
//   4. npm i playwright   (once, in this folder)
//
// THEN:
//   node testsend.js --text "..."          # shows what it would do
//   node testsend.js --text "..." --go     # actually sends
//
// The port is localhost-only and dies when Chrome closes. Nothing is stored.
// One text at a time, on purpose: Google bans bulk messaging on Voice.
const { chromium } = require("playwright");

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const GO = process.argv.includes("--go");
const PORT = arg("--port", "9222");
// Bryan's Google Voice — the test agent, and the only number this copy texts
const ONLY = "5103945339";
const to = String(arg("--to", ONLY)).replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
const text = arg("--text", "");

if (to !== ONLY) { console.error("This copy only texts Bryan's (510) 394-5339, the Test board's test agent — not " + (to || "an empty number") + "."); process.exit(1); }
if (!text.trim()) { console.error("--text is empty — nothing to send"); process.exit(1); }
if (text.length > 300) { console.error("--text is " + text.length + " chars; keep it under 300"); process.exit(1); }

const until = async (fn, ms, step) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch (e) {} await new Promise((r) => setTimeout(r, step)); }
  return false;
};

(async () => {
  const out = { to, chars: text.length, mode: GO ? "SEND" : "dry run" };
  let browser;
  try {
    // Attach, never launch. A launched browser would be signed out, which is
    // the whole problem this script exists to avoid.
    browser = await chromium.connectOverCDP("http://localhost:" + PORT);
  } catch (e) {
    console.error("Could not reach Chrome on port " + PORT + ".\n" +
      "Chrome has to be started with --remote-debugging-port=" + PORT + " and signed in to voice.google.com.\n" +
      "See the setup notes at the top of this file.\n" + String(e.message || e).slice(0, 200));
    process.exit(1);
  }
  const ctx = browser.contexts()[0];
  if (!ctx) { console.error("Chrome is open but has no window — open a tab and try again."); process.exit(1); }
  const pg = await ctx.newPage();
  try {
    // Voice's own deep link for "start a conversation with this number".
    await pg.goto("https://voice.google.com/u/0/messages?itemId=t.%2B1" + to,
      { waitUntil: "domcontentloaded", timeout: 60000 });
    await pg.waitForTimeout(6000);

    // The marketing page means this Chrome is NOT signed in to Voice. Say so
    // plainly instead of failing somewhere further down looking like a bug.
    if (/workspace\.google\.com/.test(pg.url())) {
      throw new Error("This Chrome is not signed in to Google Voice — it was redirected to the Voice sales page. " +
        "Sign in by hand in that window, then re-run.");
    }
    out.landedOn = pg.url();

    const box = pg.locator('textarea[placeholder*="message" i], textarea[aria-label*="message" i], div[contenteditable="true"][aria-label*="message" i]').first();
    if (!await until(async () => await box.isVisible(), 20000, 500)) {
      // The deep link only opens a thread that already exists. For a number
      // never texted it leaves a blank pane (seen 23 Oct), so start one the
      // way a person does: + Send new message, type the number, pick the
      // "Send to (xxx) xxx-xxxx" suggestion.
      const pretty = "(" + to.slice(0, 3) + ") " + to.slice(3, 6) + "-" + to.slice(6);
      await pg.getByText("Send new message", { exact: true }).first().click();
      const rcpt = pg.locator('input[placeholder*="name or phone" i], input[aria-label*="recipient" i], gv-recipient-picker input').first();
      if (!await until(async () => await rcpt.isVisible(), 15000, 400)) {
        throw new Error("No message box, and + Send new message did not open a recipient box. Voice may have changed its markup.");
      }
      await rcpt.fill(to);
      const opt = pg.getByText(pretty, { exact: false }).first();
      if (!await until(async () => await opt.isVisible(), 10000, 400)) throw new Error("Voice did not offer " + pretty + " as a recipient.");
      await opt.click();
      if (!await until(async () => await box.isVisible(), 15000, 500)) {
        throw new Error("Picked " + pretty + " but no message box appeared.");
      }
      out.opened = "new message";
    }
    out.messageBox = "found";

    if (!GO) {
      out.wouldSend = text;
      out.note = "Dry run — nothing typed, nothing sent. Add --go to send it for real.";
      console.log(JSON.stringify(out, null, 2));
      await pg.close(); await browser.close(); return;
    }

    await box.click();
    await box.fill("");
    await box.type(text, { delay: 18 });
    await pg.waitForTimeout(700);

    const send = pg.locator('button[aria-label*="send" i]:not([disabled])').first();
    if (!await until(async () => await send.isEnabled(), 10000, 400)) {
      throw new Error("The Send button never became active — the text may not have landed in the box.");
    }
    await send.click();

    // Proof, not assumption: the box empties and the words appear in the
    // thread. Reporting a send off a click alone is how a system starts lying.
    const cleared = await until(async () => ((await box.innerText().catch(() => "")) || "").trim() === "", 15000, 500);
    const landed = await until(async () => await pg.locator('text="' + text.slice(0, 60).replace(/"/g, '') + '"').count() > 0, 15000, 500);
    out.boxCleared = cleared;
    out.appearsInThread = landed;
    out.sent = cleared && landed;
    if (!out.sent) out.warn = "Could not confirm it went out. Check the Voice window before re-running — do not assume it failed.";
    out.sentAt = new Date().toISOString();
    console.log(JSON.stringify(out, null, 2));
    await pg.close();
  } catch (e) {
    out.err = String(e.message || e).slice(0, 400);
    console.log(JSON.stringify(out, null, 2));
    try { await pg.close(); } catch (x) {}
    process.exitCode = 1;
  }
  try { await browser.close(); } catch (x) {}
})();
