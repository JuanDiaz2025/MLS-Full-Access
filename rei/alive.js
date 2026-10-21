// READ ONLY — is the REI session still signed in, and what does the contact page show?
const { chromium } = require("playwright");
const PROFILE = __dirname + "/profile";
const ID = process.argv[2] || "20683934";
(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: true, executablePath: "/opt/pw-browsers/chromium",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1500, height: 1200 }
  });
  const pg = ctx.pages()[0] || (await ctx.newPage());
  await pg.goto("https://my.reiblackbook.com/contacts/" + ID, { waitUntil: "domcontentloaded", timeout: 60000 });
  await pg.waitForTimeout(12000);
  console.log("url:", pg.url());
  console.log("title:", await pg.title().catch(() => "?"));
  const t = await pg.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").trim().slice(0, 500));
  console.log("body starts:", t);
  await pg.screenshot({ path: __dirname + "/alive.png" }).catch(() => {});
  await ctx.close();
})();
