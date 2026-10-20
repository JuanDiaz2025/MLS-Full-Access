#!/usr/bin/env node
/**
 * Open an MLSListings Pro Dashboard URL in headless Chromium (through the
 * Claude Code on the web egress proxy) and save a screenshot.
 *
 * Usage:
 *   node scripts/open-dashboard.js [url] [outfile]
 *
 * Defaults:
 *   url     = https://prodashboard.mlslistings.com/
 *   outfile = ./prodashboard.png
 *
 * Prereqs (see docs/browser-access.md):
 *   - `npm install` (installs the `playwright` package; browser binaries are
 *     pre-installed at /opt/pw-browsers in the web environment).
 *   - The proxy CA must be trusted and Chromium's post-quantum / ECH TLS
 *     features disabled. `scripts/setup-browser.sh` does both.
 */
const { chromium } = require('playwright');

const CHROME =
  process.env.CHROMIUM_PATH ||
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PROXY = (process.env.HTTPS_PROXY || '').replace(/^https?:\/\//, '');

const url = process.argv[2] || 'https://prodashboard.mlslistings.com/';
const outfile = process.argv[3] || 'prodashboard.png';

(async () => {
  const launchArgs = ['--no-sandbox'];
  if (PROXY) launchArgs.push('--proxy-server=' + PROXY);

  const browser = await chromium.launch({
    headless: true,
    executablePath: CHROME,
    args: launchArgs,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2000);
    console.log('status :', resp && resp.status());
    console.log('landed :', page.url());
    console.log('title  :', await page.title());
    await page.screenshot({ path: outfile, fullPage: false });
    console.log('saved  :', outfile);
  } catch (e) {
    console.error('ERROR  :', e.message.split('\n')[0]);
    try {
      await page.screenshot({ path: outfile });
      console.error('saved partial screenshot:', outfile);
    } catch (_) {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
