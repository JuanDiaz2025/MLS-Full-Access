// READ ONLY — search the contacts list for a term and report the rows found.
const { chromium } = require("playwright");
const PROFILE = process.env.REI_PROFILE || __dirname + "/profile";
const TERM = process.argv[2] || "";
(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: true, executablePath: "/opt/pw-browsers/chromium",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1500, height: 1200 }
  });
  const pg = ctx.pages()[0] || (await ctx.newPage());
  const until = async (fn, ms, every) => { const end = Date.now() + (ms || 25000);
    while (Date.now() < end) { try { if (await fn()) return true; } catch (e) {} await pg.waitForTimeout(every || 400); } return false; };
  await pg.goto("https://my.reiblackbook.com/contacts", { waitUntil: "domcontentloaded", timeout: 60000 });
  await until(async () => (await pg.locator('input[placeholder*="Search By Name"]').count()) > 0, 40000);
  const box = pg.locator('input[placeholder*="Search By Name"]').first();
  await box.click(); await box.fill(TERM);
  await pg.waitForTimeout(6000);
  const rows = await pg.evaluate(() => Array.from(document.querySelectorAll("table tbody tr")).map((tr) => {
    const a = tr.querySelector('a[href*="/contacts/"]');
    return { id: a ? (/\/contacts\/(\d+)/.exec(a.getAttribute("href") || "") || [])[1] : null,
             text: (tr.innerText || "").replace(/\s+/g, " ").trim().slice(0, 110) };
  }).slice(0, 8));
  console.log("search " + JSON.stringify(TERM) + " ->");
  console.log(JSON.stringify(rows, null, 1));
  await ctx.close();
})();
