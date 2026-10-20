// Scroll a listing's whole photo gallery and lay every picture out on one
// sheet, so the condition of the house can actually be judged instead of
// guessed from the remarks.
//
//   node photocheck.js <redfin-url> <out.png> [label]
//
// Redfin loads photos lazily, so the page is scrolled to the bottom and back
// before the images are collected — otherwise only the first few exist.
const { chromium } = require("playwright");

const URL_IN = process.argv[2];
const OUT = process.argv[3] || "photos.png";
const LABEL = process.argv[4] || "";

(async () => {
  const b = await chromium.launch({ headless: true, executablePath: "/opt/pw-browsers/chromium" });
  const pg = await b.newPage({
    viewport: { width: 1400, height: 1000 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  });
  try {
    await pg.goto(URL_IN, { waitUntil: "domcontentloaded", timeout: 60000 });
    await pg.waitForTimeout(5000);

    // walk the page so the lazy images all mount
    for (let i = 0; i < 12; i++) {
      await pg.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9));
      await pg.waitForTimeout(600);
    }
    await pg.evaluate(() => window.scrollTo(0, 0));
    await pg.waitForTimeout(1500);

    // The page itself shows only a handful. Open the gallery and page through
    // it — that is where the rest of the house actually is.
    try {
      const opener = pg.locator('button:has-text("photo"), [data-rf-test-name="photoPreview"], img[alt*="of "]').first();
      if (await opener.count()) {
        await opener.click({ timeout: 8000 });
        await pg.waitForTimeout(2500);
        for (let i = 0; i < 45; i++) {
          await pg.keyboard.press("ArrowRight");
          await pg.waitForTimeout(260);
        }
      }
    } catch (e) { /* no gallery: the page images are all there is */ }
    await pg.waitForTimeout(1200);

    const shots = await pg.evaluate(() => {
      const out = new Set();
      // every <img> Redfin has mounted
      document.querySelectorAll("img").forEach((im) => {
        const s = im.currentSrc || im.src || "";
        if (/cdn-redfin\.com\/photo\//.test(s) && !/\/sm\//.test(s)) out.add(s);
      });
      // and the ones still only in the page's own data
      const html = document.documentElement.innerHTML;
      const re = /https:\\?\/\\?\/ssl\.cdn-redfin\.com\/photo\/[^"'\\\s]+?\.jpg/g;
      let m;
      while ((m = re.exec(html))) out.add(m[0].replace(/\\\//g, "/"));
      // Use the URLs exactly as Redfin gave them. Rewriting the filename to
      // reach for a bigger variant produced 404s — a photo you cannot see is
      // worse than a small one you can.
      return [...out];
    });

    // one per photo id, in page order
    const seen = new Set(), urls = [];
    for (const u of shots) {
      const id = (/photo\/\d+\/([^/]+)/.exec(u) || [, u])[1];
      if (seen.has(id)) continue;
      seen.add(id);
      urls.push(u);
    }
    console.log("photos found: " + urls.length);
    if (!urls.length) { console.log("none — the page may not have loaded"); await b.close(); return; }

    const title = await pg.title();
    const sheet = await b.newPage({ viewport: { width: 1320, height: 900 } });
    await sheet.setContent(
      '<style>body{margin:0;background:#101820;font:13px system-ui;color:#dfe8f2}' +
      'h2{margin:14px 16px 4px;font-size:15px}p{margin:0 16px 12px;color:#93a6ba;font-size:12px}' +
      '.g{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:0 10px 12px}' +
      '.c{position:relative;aspect-ratio:4/3;overflow:hidden;border-radius:4px;background:#1b2531}' +
      '.c img{width:100%;height:100%;object-fit:cover;display:block}' +
      '.n{position:absolute;left:4px;top:4px;background:rgba(0,0,0,.65);padding:1px 6px;border-radius:3px;font-size:11px}' +
      '</style><h2>' + (LABEL || title).replace(/[<>]/g, "") + "</h2><p>" + urls.length +
      " photos · " + URL_IN.replace(/[<>]/g, "") + '</p><div class="g">' +
      urls.map((u, i) => '<div class="c"><img src="' + u + '" loading="eager"><span class="n">' + (i + 1) + "</span></div>").join("") +
      "</div>"
    );
    await sheet.waitForTimeout(Math.min(4000 + urls.length * 180, 25000));
    await sheet.screenshot({ path: OUT, fullPage: true });
    console.log("sheet -> " + OUT);
  } catch (e) {
    console.log("error: " + String(e.message).slice(0, 160));
  }
  await b.close();
})();
