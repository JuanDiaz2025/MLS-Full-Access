#!/usr/bin/env node
/**
 * Log into MLSListings Pro and save the session for reuse.
 *
 * Env:
 *   MLS_USER, MLS_PASS   (required) — credentials; never hardcode/commit these.
 *   MLS_STATE            (optional) — session file path (default .mls-state.json)
 *   MLS_OUT              (optional) — screenshot dir  (default .mls-artifacts)
 *
 * Usage: MLS_USER=... MLS_PASS=... node scripts/mls-login.js
 */
const fs = require('fs');
const { launchBrowser, STATE, OUT } = require('./mls-lib');

const USER = process.env.MLS_USER;
const PASS = process.env.MLS_PASS;

(async () => {
  if (!USER || !PASS) {
    console.error('Set MLS_USER and MLS_PASS env vars.');
    process.exit(2);
  }
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  try {
    await page.goto('https://prodashboard.mlslistings.com/', { waitUntil: 'networkidle', timeout: 60000 });

    const userSel = 'input[type="text"], #signInName, input[name*="signInName" i], #username';
    const passSel = 'input[type="password"], #password';
    await page.waitForSelector(userSel, { timeout: 30000 });
    await page.fill(userSel, USER);
    await page.fill(passSel, PASS);

    const btn = page.locator('button:has-text("Sign in"), input[type="submit"], #next, button#continue').first();
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {}),
      btn.click(),
    ]);
    await page.waitForTimeout(4000);

    // Confirm we reached the dashboard, then save session.
    await page.goto('https://prodashboard.mlslistings.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(4000);
    const title = await page.title();
    console.log('title:', title);
    await page.screenshot({ path: OUT + '/dashboard.png' });
    await ctx.storageState({ path: STATE });

    if (/Dashboard/i.test(title)) {
      console.log('LOGIN OK — session saved to', STATE);
    } else {
      console.log('WARNING: dashboard title not detected; check', OUT + '/dashboard.png');
      process.exitCode = 1;
    }
  } catch (e) {
    console.error('ERR', e.message.split('\n')[0]);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
