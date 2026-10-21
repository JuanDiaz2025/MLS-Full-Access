// Send the agent-outreach text to a contact, filling the blanks from the
// contact's own record rather than from arguments:
//   [Agent Name]       <- the contact's Name (first name only)
//   [Property Address] <- the contact's Property Address (street + city; the
//                         zip and ", UNITED STATES" are dropped, they read as
//                         noise in an SMS)
//   [Name]             <- us, passed in as the sender
//
//   node outreach.js <contactId> "<From label>" "<sender>"
//
// Prints the captured fields and the exact message before sending, so a bad
// capture is visible rather than silently texted to a real agent.
const { chromium } = require("playwright");
const fs = require("fs");
const PROFILE = process.env.REI_PROFILE || __dirname + "/profile";
const ID = process.argv[2];
const FROM = process.argv[3] || "Realtor";
const SENDER = process.argv[4] || "Bryan";
const DRY = process.argv.includes("--dry");
// Every send is appended here as one JSON object per line. Nothing else
// records a Chat-tab send, so this file is the sent side of the KPI.
const SENTLOG = arg("--log", __dirname + "/sent.jsonl");

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

  // --- capture from the About panel ---
  // The About panel is a flat caption/value list. Walking up from the
  // "Contacts (N)" heading only finds it once that panel has been opened for
  // editing, so read the page text and start at that heading instead.
  const readPanel = () => pg.evaluate(() => {
    const t = (document.body.innerText || "");
    const i = t.search(/Contacts \(\d+\)/);
    return (i < 0 ? t : t.slice(i)).trim();
  });
  const valueOf = (block, cap) => {
    const lines = block.split("\n").map((x) => x.trim()).filter(Boolean);
    const i = lines.indexOf(cap);
    if (i < 0 || i + 1 >= lines.length) return "";
    const v = lines[i + 1];
    return v === "-" ? "" : v;
  };
  let panel = "";
  await until(async () => { panel = await readPanel(); return !!valueOf(panel, "Name"); }, 20000, 800);
  const fullName = valueOf(panel, "Name");
  const rawAddr = valueOf(panel, "Property Address");
  const toPhone = valueOf(panel, "Phone (Mobile)") || valueOf(panel, "Phone (Home)");
  out.capturedName = fullName || "(empty)";
  out.capturedAddress = rawAddr || "(empty)";
  out.capturedPhone = toPhone || "(empty)";
  if (!fullName || !rawAddr) {
    console.log(JSON.stringify({ ok: false, err: "could not capture name or property address", ...out }));
    await ctx.close(); return;
  }
  const first = fullName.split(/\s+/)[0];
  // "100 Palm Ave, San Carlos, CA, 94070, UNITED STATES" -> "100 Palm Ave, San Carlos"
  const parts = rawAddr.split(",").map(s => s.trim()).filter(Boolean)
    .filter(s => !/^united states$/i.test(s));
  const shortAddr = parts.slice(0, 2).join(", ");
  out.addressUsed = shortAddr;

  const MSG = `Hi ${first}, ${SENDER} with Twin Home Buyer. We're interested in ${shortAddr}. ` +
    `When are you reviewing offers? We have 120 Google reviews. We're also looking to build ` +
    `long-term relationships with local agents. Can I ask you a couple quick questions about the property?`;
  out.message = MSG;
  out.chars = MSG.length;
  if (DRY) { console.log(JSON.stringify({ ok: true, dryRun: true, ...out })); await ctx.close(); return; }

  // --- Chat tab ---
  const chat = await pg.evaluate(() => {
    const el = Array.from(document.querySelectorAll("*")).find(
      (e) => !e.children.length && (e.textContent || "").trim() === "Chat" && e.offsetParent !== null);
    if (!el) return null; const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!chat) { console.log(JSON.stringify({ ok: false, err: "no Chat tab", ...out })); await ctx.close(); return; }
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
  if (!fromRow) { console.log(JSON.stringify({ ok: false, err: "no From: row", ...out })); await ctx.close(); return; }
  out.fromWas = fromRow.was;
  await pg.mouse.click(fromRow.x, fromRow.y);
  await pg.waitForTimeout(1500);
  await pg.keyboard.type(FROM, { delay: 40 });
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

  // --- message (TinyMCE inside a srcdoc iframe, see README) ---
  const box = await pg.evaluate(() => {
    const f = Array.from(document.querySelectorAll("iframe"))
      .filter(x => x.getAttribute("srcdoc") !== null && x.getBoundingClientRect().height > 20)[0];
    if (!f) return null; const r = f.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!box) { console.log(JSON.stringify({ ok: false, err: "no reply editor iframe", ...out })); await ctx.close(); return; }
  await pg.mouse.click(box.x, box.y);
  await pg.waitForTimeout(600);
  await pg.keyboard.type(MSG, { delay: 8 });
  await pg.waitForTimeout(1500);
  await pg.screenshot({ path: __dirname + "/outreach-before-send.png" });
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
  await pg.waitForTimeout(12000);
  await pg.evaluate(() => { document.querySelectorAll("*").forEach(e => { if (e.scrollHeight > e.clientHeight + 50) e.scrollTop = e.scrollHeight; }); });
  await pg.waitForTimeout(2000);
  out.threadTail = await pg.evaluate((m) => {
    const t = (document.body.innerText || "").replace(/\n{2,}/g, "\n");
    const i = t.indexOf(m.slice(0, 40));
    return i < 0 ? "(not found in thread)" : t.slice(i, i + 220).trim();
  }, MSG);

  // The send is the only record of itself: REI's Outbox holds scheduled and
  // broadcast texts only, so a Chat-tab send appears nowhere we can query
  // later. Append it here, before anything else can fail.
  const sent = {
    at: new Date().toISOString(), kind: "text", dir: "out",
    contactId: ID, name: fullName, phone: toPhone, line: out.fromPicked || FROM,
    address: shortAddr, by: SENDER, body: MSG
  };
  try { fs.appendFileSync(SENTLOG, JSON.stringify(sent) + "\n"); out.loggedTo = SENTLOG; }
  catch (e) { out.logErr = String(e.message || e).slice(0, 120); }
  await pg.screenshot({ path: __dirname + "/outreach-proof.png" });
  console.log(JSON.stringify({ ok: true, ...out }));
  await ctx.close();
})();
