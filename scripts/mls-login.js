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
    await btn.click();

    // The post-login flow redirects B2C -> azureadloginresponder -> /auth/PreTFA
    // (an AUTO device-trust callback, /Auth/PreTfaCallback) -> PostLogin -> dashboard.
    // PreTFA usually auto-resolves; do NOT bail on it — wait the whole chain out until
    // the dashboard title appears. Only a real code-entry field means manual 2FA.
    const safeTitle = async () => { try { return await page.title(); } catch (_) { return ''; } };
    let title = '';
    for (let i = 0; i < 45; i++) {
      await page.waitForTimeout(2000);
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      title = await safeTitle();
      if (/MLSListings Pro Dashboard/i.test(title)) break;
      // Session Limit page: the account allows only 5 concurrent sessions. End
      // the oldest inactive one (our own stale headless logins) and continue.
      if (/Session Limit/i.test(title) || await page.$('text=Session Limit Reached').catch(() => null)) {
        console.log('Session Limit page — ending oldest inactive session.');
        await page.locator('button:has-text("End Oldest Inactive Session"), input[value*="End Oldest" i]').first()
          .click().catch(async () => { await page.getByText('End Oldest Inactive Session', { exact: false }).first().click().catch(() => {}); });
        await page.waitForTimeout(3000);
        continue;
      }
      // Detect a manual 2FA code-entry prompt (not the auto-callback).
      const codeInput = await page.$('input[type=tel], input[name*=code i], input[id*=code i]').catch(() => null);
      if (codeInput && /PreTFA|TFA|verif|code/i.test(page.url() + title)) {
        console.log('MANUAL 2FA REQUIRED — a code was sent to the account owner. Re-run with the code.');
        break;
      }
    }
    await page.screenshot({ path: OUT + '/dashboard.png' }).catch(() => {});

    if (/MLSListings Pro Dashboard/i.test(title)) {
      await ctx.storageState({ path: STATE });
      console.log('LOGIN OK — session saved to', STATE, '| title:', title);
    } else {
      console.log('WARNING: dashboard not reached; final title:', title, '| check', OUT + '/dashboard.png');
      process.exitCode = 1;
    }
  } catch (e) {
    console.error('ERR', e.message.split('\n')[0]);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
