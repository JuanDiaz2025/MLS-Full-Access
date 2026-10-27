// Leaving the "Groups to track" screen with nothing tracked, and coming back to it.
// Uses the page e2e-addmany.js writes, so run that first.
const { chromium } = require('playwright');
process.chdir(__dirname);
const fails = [];
const check = (label, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${got !== undefined ? ' | ' + got : ''}`); if (!ok) fails.push(label); };
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1360, height: 900 } });
  const errs = [];
  p.on('pageerror', e => errs.push(String(e))); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  const url = 'file://' + process.cwd() + '/shots/e2e-addmany.html';
  await p.goto(url + '?mode=laptop'); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(1500);
  const setupShown = () => p.$eval('#v-setup', e => !e.hidden);
  check('nothing tracked: setup shows', await setupShown());
  check('Back to dashboard button', await p.isVisible('[data-action="leave-setup"]'));
  await p.click('[data-action="leave-setup"]'); await p.waitForTimeout(300);
  check('left setup', !(await setupShown()), await p.textContent('#v-title'));
  check('dashboard visible', await p.$eval('#v-dashboard', e => !e.hidden));
  check('Groups and names in sidebar', await p.isVisible('#change-group'));
  await p.screenshot({ path: 'shots/leave-dashboard.png' });
  // a background refresh doesn't throw you back in
  await p.waitForTimeout(1500);
  check('stays on the dashboard', !(await setupShown()));
  await p.click('#change-group'); await p.waitForTimeout(800);
  check('Groups and names opens setup', await setupShown());
  const first = await p.$eval('input[name="pick-group"]', x => x.value);
  await p.check(`input[name="pick-group"][value="${first}"]`);
  await p.click('#pick-next'); await p.waitForTimeout(1200);
  check('in the add flow', await p.isVisible('.addflow'));
  await p.click('[data-action="leave-setup"]'); await p.waitForTimeout(300);
  check('left from the add flow', !(await setupShown()));
  await p.click('#change-group'); await p.waitForTimeout(800);
  check('picks cleared after leaving', await p.$eval('#pick-count', e => e.textContent.trim()), );
  check('nothing tracked', await p.evaluate(() => !(JSON.parse(localStorage.getItem('mockdb') || '{}')['settings/tracking'] || { groups: [] }).groups.length));
  check('no page errors', !errs.length, errs.join(' || '));
  console.log(fails.length ? `${fails.length} FAILED` : 'all checks passed');
  await b.close(); process.exit(fails.length ? 1 : 0);
})();
