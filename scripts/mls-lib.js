// Shared helpers for driving MLSListings headlessly through the egress proxy.
const { chromium } = require('playwright');

const CHROME =
  process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PROXY = (process.env.HTTPS_PROXY || '').replace(/^https?:\/\//, '');

const STATE = process.env.MLS_STATE || '.mls-state.json';
const OUT = process.env.MLS_OUT || '.mls-artifacts';

async function launchBrowser() {
  const args = ['--no-sandbox'];
  if (PROXY) args.push('--proxy-server=' + PROXY);
  return chromium.launch({ headless: true, executablePath: CHROME, args });
}

module.exports = { launchBrowser, STATE, OUT };
