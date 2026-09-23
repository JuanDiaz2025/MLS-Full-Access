/**
 * Profile-verify: for each MLS# in MLS_LIST, open "Client Full - All Photos"
 * and capture ZIP + public/agent remarks + condition, and keyword-flag
 * tenant-occupied / fire / probate / multi-unit / fixer language.
 *
 * Writes .mls-artifacts/profiles-out.json: [{mls, zip, pub, agent, cond, flags}].
 * The zip feeds mls-comps.js; the flags support SOP step 5 (drop tenant/fire/multi-unit).
 *
 * Usage: MLS_LIST="EB41140898,ML82051677" node scripts/mls-profile.js
 */
const fs = require('fs');
const path = require('path');
const { launchBrowser, STATE, OUT } = require('./mls-lib');

const TARGETS = (process.env.MLS_LIST || '').split(',').map(s => s.trim()).filter(Boolean);

async function one(p, mls) {
  await p.goto('https://search.mlslistings.com/Matrix/Search/Residential/ResidentialSearch', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForTimeout(1300);
  await p.fill('#Fm9_Ctrl75_TextBox', mls); await p.locator('#Fm9_Ctrl75_TextBox').blur(); await p.waitForTimeout(1500);
  await Promise.all([p.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {}), p.locator('a:has-text("Results")').first().click().catch(() => {})]);
  await p.waitForSelector('tr.DisplayRegRow, tr.DisplayAltRow', { timeout: 20000 }).catch(() => {});
  await p.waitForTimeout(700);
  await p.locator('tr.DisplayRegRow input[type=checkbox], tr.DisplayAltRow input[type=checkbox]').first().check().catch(() => {});
  await p.waitForTimeout(400);
  const sel = await p.evaluate(() => { const s = [...document.querySelectorAll('select')].find(se => [...se.options].some(o => /Client Full - All Photos/i.test(o.text))); return s ? s.id : null; });
  if (sel) { await Promise.all([p.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {}), p.selectOption('#' + sel, { label: 'Client Full - All Photos' }).catch(() => {})]); await p.waitForTimeout(2600); }
  const info = await p.evaluate(() => {
    const t = document.body.innerText.replace(/\r/g, '');
    const zip = (t.match(/\b(94[0-9]{3}|95[0-9]{3})\b/) || [])[1] || '';
    const grab = re => { const m = t.match(re); return m ? m[1].replace(/\s+/g, ' ').trim() : ''; };
    const pub = grab(/(?:Public Remarks?|Marketing Remarks?|Remarks?):?\s*([\s\S]{0,600}?)(?:Agent|Directions|Showing|Compensation|Listing Office|©|Presented|$)/i);
    const agent = grab(/(?:Agent Remarks?|Confidential Remarks?|Private Remarks?):?\s*([\s\S]{0,500}?)(?:Directions|Showing|Compensation|Listing Office|©|Presented|$)/i);
    const cond = grab(/Prop(?:erty)? Condition:?\s*([^\n]{0,60})/i);
    return { zip, pub, agent, cond };
  });
  const hay = ((info.pub || '') + ' ' + (info.agent || '') + ' ' + (info.cond || '')).toLowerCase();
  const flags = [];
  if (/tenant|renter|occupied by|leased|lease |rented|do not disturb occupant|month-to-month|section 8/.test(hay)) flags.push('TENANT?');
  if (/fire[- ]?damag|fire damage|gutted by fire|burned|fire-damaged/.test(hay)) flags.push('FIRE');
  if (/probate|estate|trust sale|conservator/.test(hay)) flags.push('probate/estate');
  if (/duplex|two units|2 units|in-law|second unit|adu|multi-?unit|triplex/.test(hay)) flags.push('MULTIUNIT?');
  if (/as-is|as is|fixer|tlc|contractor|handyman|needs work|deferred/.test(hay)) flags.push('fixer-lang');
  return { mls, ...info, flags };
}

(async () => {
  if (!TARGETS.length) { console.error('Set MLS_LIST="mls1,mls2,..."'); process.exit(1); }
  const b = await launchBrowser();
  const ctx = await b.newContext({ viewport: { width: 1400, height: 1100 }, storageState: STATE });
  const p = await ctx.newPage(); const res = [];
  try {
    for (const m of TARGETS) {
      try { const r = await one(p, m); res.push(r); console.log(`${m} | zip=${r.zip} | flags=[${r.flags.join(',')}] | ${(r.pub || '').slice(0, 110)}`); }
      catch (e) { console.log(m, 'ERR', e.message.split('\n')[0]); res.push({ mls: m, err: 1 }); }
    }
    fs.writeFileSync(path.join(OUT, 'profiles-out.json'), JSON.stringify(res, null, 1));
    console.log('DONE');
  } finally { await b.close(); }
})();
