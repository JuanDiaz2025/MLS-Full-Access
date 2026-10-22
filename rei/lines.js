// List the ProfitDial lines a text can be sent FROM.
//
//   node lines.js [contactId]
//
// Read-only: it opens a contact's Chat tab, opens the From picker, reads
// every option and closes. Nothing is typed into the message box and nothing
// is sent.
//
// Why this exists: blast.js spreads a batch across several lines, and the
// line NAMES have to match what REI calls them exactly — sendtext.js picks by
// typing the label into a react-select. Guessing a name sends from the wrong
// number, or silently leaves the previous one selected, which is worse.
// Better to read the real list and choose from it.
const { chromium } = require("playwright");
const ID = process.argv[2] || "20585230";   // the TEST lead, harmless to open

const until = async (fn, ms, step) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, step)); }
  return false;
};

(async () => {
  const out = { contactOpened: ID };
  const ctx = await chromium.launchPersistentContext(process.env.REI_PROFILE || __dirname + "/profile", {
    headless: true, executablePath: "/opt/pw-browsers/chromium",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1600, height: 1200 }
  });
  const pg = ctx.pages()[0] || (await ctx.newPage());
  try {
    await pg.goto("https://my.reiblackbook.com/contacts/" + ID, { waitUntil: "domcontentloaded", timeout: 60000 });
    await pg.waitForTimeout(13000);

    const chat = await pg.evaluate(() => {
      const el = Array.from(document.querySelectorAll("*")).find(
        (e) => !e.children.length && (e.textContent || "").trim() === "Chat" && e.offsetParent !== null);
      if (!el) return null; const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (!chat) throw new Error("no Chat tab — is this profile signed in?");
    await pg.mouse.click(chat.x, chat.y);
    await pg.waitForTimeout(8000);

    const fromRow = await pg.evaluate(() => {
      const el = Array.from(document.querySelectorAll("*")).find(
        (e) => !e.children.length && /^From:/.test((e.textContent || "").trim()) && e.offsetParent !== null);
      if (!el) return null;
      const p = el.parentElement, r = p.getBoundingClientRect();
      return { was: (p.textContent || "").trim().slice(0, 90), x: r.x + r.width - 14, y: r.y + r.height / 2 };
    });
    if (!fromRow) throw new Error("no From: row on the Chat tab");
    out.currentlySelected = fromRow.was;

    await pg.mouse.click(fromRow.x, fromRow.y);
    // The list is virtualised, so give it a moment and read whatever rendered.
    await until(async () => pg.evaluate(() =>
      document.querySelectorAll('[id^="react-select"][id*="option"],[role="option"]').length > 0), 9000, 250);
    await pg.waitForTimeout(1200);

    out.lines = await pg.evaluate(() =>
      Array.from(document.querySelectorAll('[id^="react-select"][id*="option"],[role="option"]'))
        .filter((e) => e.offsetParent !== null)
        .map((e) => (e.textContent || "").trim())
        .filter(Boolean));
    out.shown = out.lines.length;
    // A long list renders only what fits, so say so rather than letting the
    // count read as the whole account.
    out.note = "Only the options the picker had rendered are listed. If the account has many more lines, scroll the picker or search it by name.";
    await pg.keyboard.press("Escape");
  } catch (e) {
    out.err = String(e.message || e).slice(0, 300);
  }
  console.log(JSON.stringify(out, null, 2));
  await ctx.close();
})();
