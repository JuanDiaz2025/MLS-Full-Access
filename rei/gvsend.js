// Send a text FROM Bryan's Google Voice number — run on HIS machine.
//
// Why it lives here and not on the watch loop: Google Voice has no API and no
// connector (checked the registry 23 Oct — Drive, Calendar, Docs, Sheets, and
// nothing for Voice). The only way in is a signed-in browser, and the only
// signed-in browser that may be used is Bryan's own. So this script never
// handles a password, a code or a cookie. It ATTACHES to a Chrome he has
// already started and already signed into, the same way a devtools window
// does, and drives the page he could drive by hand.
//
// ONE-TIME SETUP, on his machine:
//   1. Quit Chrome completely.
//   2. Start it with the debugging port open:
//        macOS   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222
//        Windows "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
//   3. Sign in to voice.google.com in that window, as normal, by hand.
//   4. npm i playwright   (once, in this folder)
//
// THEN:
//   node gvsend.js --to 5105551234 --text "..."        # shows what it would do
//   node gvsend.js --to 5105551234 --text "..." --go   # actually sends
//
// The port is localhost-only: nothing outside his machine can reach it, and it
// dies when he closes Chrome. Nothing is stored.
//
// THE LIMIT, stated here so it is not discovered the hard way: Google bans
// bulk messaging on Voice and takes the number for it. This sends ONE text at
// a time, on purpose. The 50-a-day agent blast stays on the REI lines, which
// are built for it. Use this for a reply or a one-off — not a campaign.
const { chromium } = require("playwright");

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const GO = process.argv.includes("--go");
const PORT = arg("--port", "9222");
const to = String(arg("--to", "")).replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
const text = arg("--text", "");

if (to.length !== 10) { console.error("--to must be a 10-digit US number"); process.exit(1); }
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

    const box = pg.locator('textarea[aria-label*="message" i], div[contenteditable="true"][aria-label*="message" i]').first();
    if (!await until(async () => await box.isVisible(), 20000, 500)) {
      throw new Error("No message box on the page. Either the thread did not open, or Voice has changed its markup.");
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
