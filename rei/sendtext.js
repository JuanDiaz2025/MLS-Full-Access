// Send an SMS from a REI BlackBook contact's Chat tab, through a named ProfitDial number.
//   node sendtext.js <contactId> "<from number label>" "<message>"
// Picks the From: number first, types the message, then presses Send Text.
const { chromium } = require("playwright");
const PROFILE = process.env.REI_PROFILE || __dirname + "/profile";
const ID = process.argv[2];
const FROM = process.argv[3];
const MSG = process.argv[4];
const until = async (fn, ms, step) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise(r => setTimeout(r, step)); }
  return false;
};
(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: true, executablePath: "/opt/pw-browsers/chromium",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1600, height: 1200 }
  });
  const pg = ctx.pages()[0] || (await ctx.newPage());
  const out = {};
  await pg.goto("https://my.reiblackbook.com/contacts/" + ID, { waitUntil: "domcontentloaded", timeout: 60000 });
  await pg.waitForTimeout(13000);

  const chat = await pg.evaluate(() => {
    const el = Array.from(document.querySelectorAll("*")).find(
      (e) => !e.children.length && (e.textContent || "").trim() === "Chat" && e.offsetParent !== null);
    if (!el) return null; const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!chat) { console.log(JSON.stringify({ ok: false, err: "no Chat tab" })); await ctx.close(); return; }
  await pg.mouse.click(chat.x, chat.y);
  await pg.waitForTimeout(8000);

  // --- From: number ---
  const fromRow = await pg.evaluate(() => {
    const el = Array.from(document.querySelectorAll("*")).find(
      (e) => !e.children.length && /^From:/.test((e.textContent || "").trim()) && e.offsetParent !== null);
    if (!el) return null;
    const p = el.parentElement, r = p.getBoundingClientRect();
    return { was: (p.textContent || "").trim().slice(0, 90), x: r.x + r.width - 14, y: r.y + r.height / 2 };
  });
  if (!fromRow) { console.log(JSON.stringify({ ok: false, err: "no From: row" })); await ctx.close(); return; }
  out.fromWas = fromRow.was;
  await pg.mouse.click(fromRow.x, fromRow.y);
  await pg.waitForTimeout(1500);
  await pg.keyboard.type(FROM, { delay: 40 });
  // Wait for the option itself to render, not merely for the list container.
  const listed = await until(async () => pg.evaluate((t) =>
    Array.from(document.querySelectorAll('[id^="react-select"][id*="option"],[role="option"]'))
      .filter(e => e.offsetParent !== null)
      .some(e => (e.textContent || "").trim().toLowerCase().startsWith(t.toLowerCase())), FROM), 9000, 250);
  if (!listed) { console.log(JSON.stringify({ ok: false, err: "From option never appeared", ...out })); await ctx.close(); return; }
  const pick = await pg.evaluate((t) => {
    const e = Array.from(document.querySelectorAll('[id^="react-select"][id*="option"],[role="option"]'))
      .filter(x => x.offsetParent !== null)
      .find(x => (x.textContent || "").trim().toLowerCase().startsWith(t.toLowerCase()));
    if (!e) return null; const r = e.getBoundingClientRect();
    return { t: (e.textContent || "").trim(), x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, FROM);
  out.fromPicked = pick && pick.t;
  await pg.mouse.click(pick.x, pick.y);
  await pg.waitForTimeout(2500);
  out.fromNow = await pg.evaluate(() => {
    const el = Array.from(document.querySelectorAll("*")).find(
      (e) => !e.children.length && /^From:/.test((e.textContent || "").trim()) && e.offsetParent !== null);
    return el ? (el.parentElement.textContent || "").trim().slice(0, 90) : "";
  });

  // --- message ---
  // The reply editor is TinyMCE inside a srcdoc iframe, so the placeholder is
  // invisible to the page document. Click the iframe's box and type into it.
  const box = await pg.evaluate(() => {
    const f = Array.from(document.querySelectorAll("iframe"))
      .filter(x => x.getAttribute("srcdoc") !== null && x.getBoundingClientRect().height > 20)[0];
    if (!f) return null; const r = f.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!box) { console.log(JSON.stringify({ ok: false, err: "no reply editor iframe", ...out })); await ctx.close(); return; }
  await pg.mouse.click(box.x, box.y);
  await pg.waitForTimeout(600);
  await pg.keyboard.type(MSG, { delay: 12 });
  await pg.waitForTimeout(1500);
  await pg.screenshot({ path: __dirname + "/sms-before-send.png" });
  const ed = pg.frames().find(f => f.url() === "about:srcdoc");
  out.typed = ed ? await ed.evaluate(() => (document.body.innerText || "").trim()) : "";

  // --- send ---
  const send = await pg.evaluate(() => {
    const b = Array.from(document.querySelectorAll("button,[role=button]"))
      .filter(x => x.offsetParent !== null)
      .find(x => (x.getAttribute("aria-label") || "") === "Send Text");
    if (!b) return null; const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!send) { console.log(JSON.stringify({ ok: false, err: "no Send Text button", ...out })); await ctx.close(); return; }
  await pg.mouse.click(send.x, send.y);
  await pg.waitForTimeout(9000);

  // the sent bubble should now be the last one in the thread
  out.lastBubble = await pg.evaluate((m) => {
    const hit = Array.from(document.querySelectorAll("div,p,span"))
      .filter(e => e.offsetParent !== null && (e.textContent || "").trim() === m);
    return hit.length ? "found in thread" : "not found";
  }, MSG);
  await pg.screenshot({ path: __dirname + "/sms-after-send.png" });
  console.log(JSON.stringify({ ok: true, ...out }));
  await ctx.close();
})();
