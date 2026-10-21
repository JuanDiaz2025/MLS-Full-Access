// Detect inbound text replies.
//
//   node replies.js [--line "Realtor"] [--since "2026-10-21T00:00:00Z"] [--state <file>]
//
// Reads ProfitDial > Inbox > Texts, which is one page for the whole account and
// carries the PD line each reply came in on — so agent-outreach replies on the
// Realtor line separate from PPC/TV/postcard traffic without opening a single
// contact.
//
// With --state, the newest Received timestamp is stored and only rows newer
// than it are reported next run. Do NOT key this off the unread badge
// (/profitdial/indicators/get): that count drops as soon as a human opens the
// inbox in a browser, so it misses replies. The high-water mark does not.
//
// REI shows no delivery receipt, so this measures REPLIED, never DELIVERED.
const { chromium } = require("playwright");
const fs = require("fs");
const PROFILE = process.env.REI_PROFILE || __dirname + "/profile";
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const LINE = arg("--line", "");
const STATE = arg("--state", "");
let since = arg("--since", "");
if (!since && STATE && fs.existsSync(STATE)) {
  try { since = JSON.parse(fs.readFileSync(STATE, "utf8")).lastSeen || ""; } catch (e) {}
}

// "Oct 21, 8:19 AM" -> Date. The table omits the year; a date more than a day
// ahead of now is last year's.
const parseWhen = (s) => {
  const m = String(s).trim().match(/^([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
    .indexOf(m[1].slice(0,1).toUpperCase() + m[1].slice(1,3).toLowerCase());
  if (mon < 0) return null;
  let h = +m[3] % 12; if (/pm/i.test(m[5])) h += 12;
  const now = new Date();
  let d = new Date(Date.UTC(now.getUTCFullYear(), mon, +m[2], h, +m[4]));
  if (d.getTime() - now.getTime() > 86400000) d = new Date(Date.UTC(now.getUTCFullYear() - 1, mon, +m[2], h, +m[4]));
  return d;
};

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: true, executablePath: "/opt/pw-browsers/chromium",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1600, height: 1200 }
  });
  const pg = ctx.pages()[0] || (await ctx.newPage());
  await pg.goto("https://my.reiblackbook.com/profitdial/inbox/texts", { waitUntil: "domcontentloaded", timeout: 60000 });
  await pg.waitForTimeout(16000);
  if (/\/login/.test(pg.url())) {
    // An empty REI_PROFILE lands here too, and that is not a sign-out.
    console.log(JSON.stringify({ ok: false, err: "login page — check REI_PROFILE points at the signed-in profile", url: pg.url() }));
    await ctx.close(); return;
  }
  // The row starts with an empty checkbox cell, so anchor on whichever cell
  // holds the date rather than assuming column 0.
  const rows = await pg.evaluate(() => Array.from(document.querySelectorAll("tr"))
    .map(tr => Array.from(tr.querySelectorAll("td")).map(td => (td.innerText || "").trim()))
    .map(c => { const i = c.findIndex(x => /^[A-Z][a-z]{2}\s+\d{1,2},\s+\d{1,2}:\d{2}\s*(AM|PM)$/i.test(x));
                return i < 0 ? null : c.slice(i); })
    .filter(c => c && c.length >= 5));
  const all = rows.map(c => ({
    when: c[0], name: c[1], from: c[2], line: c[3].replace(/\s+/g, " ").trim(), body: c[4]
  })).map(r => ({ ...r, at: (parseWhen(r.when) || new Date(0)).toISOString() }));

  let hits = all;
  if (LINE) hits = hits.filter(r => r.line.toLowerCase().includes(LINE.toLowerCase()));
  if (since) hits = hits.filter(r => r.at > since);
  hits.sort((a, b) => (a.at < b.at ? 1 : -1));

  const newest = all.reduce((m, r) => (r.at > m ? r.at : m), "");
  if (STATE && newest) fs.writeFileSync(STATE, JSON.stringify({ lastSeen: newest }, null, 2));

  console.log(JSON.stringify({
    ok: true, scanned: all.length, line: LINE || "(all)", since: since || "(none)",
    newNow: hits.length, newest, replies: hits
  }, null, 2));
  await ctx.close();
})();
