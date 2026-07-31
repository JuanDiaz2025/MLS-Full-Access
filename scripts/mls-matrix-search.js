#!/usr/bin/env node
/**
 * Run a CoreLogic Matrix Residential search and screenshot criteria + results.
 * Requires a saved session (run scripts/mls-login.js first).
 *
 * Env (all optional):
 *   COUNTY         default "San Francisco"  (Matrix county; SF = whole city)
 *   CITY           if set, selects a City instead of / in addition to county
 *   STATUS         default "Active"
 *   PROPERTY_TYPE  e.g. "Single Family Home" (default: all types)
 *   MAX_PRICE_K    default 1500  (thousands; the "(000s)" box is checked)
 *   MIN_PRICE_K    default 0
 *   DAYS           default 45    (List Date within the last N days)
 *   MLS_STATE / MLS_OUT  session + screenshot paths
 *
 * Field IDs are documented in CLAUDE.md; re-introspect if a <select> is empty.
 */
const fs = require('fs');
const { launchBrowser, STATE, OUT } = require('./mls-lib');

const COUNTY = process.env.COUNTY || 'San Francisco';
const CITY = process.env.CITY || '';
const STATUS = process.env.STATUS || 'Active';
const PTYPE = process.env.PROPERTY_TYPE || '';
const MINK = process.env.MIN_PRICE_K || '0';
const MAXK = process.env.MAX_PRICE_K || '1500';
const DAYS = parseInt(process.env.DAYS || '45', 10);

const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(STATE)) {
    console.error('No session at', STATE, '— run scripts/mls-login.js first.');
    process.exit(2);
  }

  const from = new Date(Date.now() - DAYS * 86400000);
  const to = new Date();
  const dateRange = `${fmt(from)}-${fmt(to)}`;

  const browser = await launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState: STATE });
  const page = await ctx.newPage();
  try {
    await page.goto('https://search.mlslistings.com/Matrix/Search/Residential/ResidentialSearch', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2500);

    if (STATUS) { await page.selectOption('#Fm9_Ctrl1161_LB', { label: STATUS }); await page.waitForTimeout(600); }
    if (PTYPE) { await page.selectOption('#Fm9_Ctrl65_LB', { label: PTYPE }).catch(() => {}); await page.waitForTimeout(600); }
    if (COUNTY) { await page.selectOption('#Fm9_Ctrl1738_LB', { label: COUNTY }).catch(() => {}); await page.waitForTimeout(1200); }
    if (CITY) { await page.selectOption('#Fm9_Ctrl1739_LB', { label: CITY }).catch(() => {}); await page.waitForTimeout(1200); }

    await page.fill('#Fm9_Ctrl63_TB', `${MINK}-${MAXK}`);
    await page.locator('#Fm9_Ctrl63_TB').blur();
    await page.waitForTimeout(600);
    await page.fill('#Fm9_Ctrl1162_TB', dateRange);
    await page.locator('#Fm9_Ctrl1162_TB').blur();
    await page.waitForTimeout(2000);

    const count = await page.evaluate(() => {
      const m = document.body.innerText.match(/([\d,]+\+?)\s*match/i);
      return m ? m[1] : '(count not found)';
    });
    console.log(`criteria: ${STATUS} ${COUNTY || CITY} $${MINK}-${MAXK}k listed ${dateRange}`);
    console.log('MATCHES:', count);
    await page.screenshot({ path: OUT + '/search-criteria.png' });

    const results = page.locator('a:has-text("Results"), input[value="Results" i]').first();
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {}),
      results.click().catch(async () => { await page.getByText('Results', { exact: true }).last().click(); }),
    ]);
    await page.waitForTimeout(5000);
    await page.screenshot({ path: OUT + '/search-results.png' });
    await ctx.storageState({ path: STATE });
    console.log('screenshots:', OUT + '/search-criteria.png,', OUT + '/search-results.png');
  } catch (e) {
    console.error('ERR', e.message.split('\n')[0]);
    try { await page.screenshot({ path: OUT + '/search-results.png' }); } catch (_) {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
