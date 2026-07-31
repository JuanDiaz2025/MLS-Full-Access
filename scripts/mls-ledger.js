#!/usr/bin/env node
/**
 * Seen-ledger — never re-check a listing we have already checked.
 *
 * The hourly scan is incremental: each run should only spend time on MLS #s it
 * has never seen. This keeps a persistent record of every listing ever scanned
 * so the expensive stages (photo review, comps, scoring) never run twice on the
 * same property.
 *
 * The ledger lives at data/scanned-ledger.json and is TRACKED IN GIT on purpose
 * — the container is ephemeral, so an uncommitted ledger is lost and the next
 * run re-checks everything. Commit it at the end of every run.
 *
 * Usage:
 *   node scripts/mls-ledger.js filter <in.json> [out.json]   drop already-seen
 *   node scripts/mls-ledger.js record <in.json> [verdict]    mark as seen
 *   node scripts/mls-ledger.js stats                         summary
 *   node scripts/mls-ledger.js forget <MLS#[,MLS#...]>       re-open a listing
 *
 * Input JSON may be either an array of rows or the multi-scan shape
 * ({ city: { rows: [...] } }); rows just need an `mls` field.
 *
 * Env:
 *   LEDGER   override ledger path (default data/scanned-ledger.json)
 *   TODAY    override the stamped date (YYYY-MM-DD), for tests
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LEDGER = process.env.LEDGER || path.join(ROOT, 'data', 'scanned-ledger.json');

const today = () => process.env.TODAY || new Date().toISOString().slice(0, 10);

function load() {
  if (!fs.existsSync(LEDGER)) return { version: 1, entries: {} };
  try {
    const j = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
    return j && j.entries ? j : { version: 1, entries: {} };
  } catch (e) {
    // A corrupt ledger must never silently reset — that would re-check the world.
    throw new Error(`ledger unreadable at ${LEDGER}: ${e.message}\n` +
      'Fix or restore it from git before scanning (do NOT delete it).');
  }
}

function save(led) {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  const sorted = {};
  for (const k of Object.keys(led.entries).sort()) sorted[k] = led.entries[k];
  led.entries = sorted;
  led.updated = today();
  fs.writeFileSync(LEDGER, JSON.stringify(led, null, 1) + '\n');
}

// Accept an array of rows, or multi-scan's { city: { rows: [] } }.
function readRows(file) {
  const fp = [file, path.join(ROOT, '.mls-artifacts', file), path.join(ROOT, file)]
    .find(p => p && fs.existsSync(p));
  if (!fp) throw new Error('input not found: ' + file);
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
  if (Array.isArray(data)) return { rows: data, shape: 'array', data, fp };
  const rows = [];
  for (const k of Object.keys(data)) if (data[k] && Array.isArray(data[k].rows)) rows.push(...data[k].rows);
  return { rows, shape: 'byCity', data, fp };
}

const idOf = r => String(r && r.mls || '').trim();

function cmdFilter(inFile, outFile) {
  const led = load();
  const { rows, shape, data, fp } = readRows(inFile);
  const seen = led.entries;
  const isNew = r => { const id = idOf(r); return id && !seen[id]; };

  let out, kept, skipped;
  if (shape === 'array') {
    out = rows.filter(isNew);
    kept = out.length; skipped = rows.length - kept;
  } else {
    out = {};
    kept = 0; skipped = 0;
    for (const k of Object.keys(data)) {
      const src = (data[k] && data[k].rows) || [];
      const fresh = src.filter(isNew);
      kept += fresh.length; skipped += src.length - fresh.length;
      out[k] = { ...data[k], rows: fresh, count: String(fresh.length) };
    }
  }
  const dest = outFile || fp;
  fs.writeFileSync(dest, JSON.stringify(out, null, 1) + '\n');
  const noId = rows.filter(r => !idOf(r)).length;
  console.log(`LEDGER filter: ${rows.length} in -> ${kept} new, ${skipped} already checked (skipped)`);
  if (noId) console.log(`  warning: ${noId} row(s) had no MLS # — kept, but they cannot be de-duped`);
  console.log(`  ledger holds ${Object.keys(seen).length} listing(s); wrote ${dest}`);
}

function cmdRecord(inFile, verdict) {
  const led = load();
  const { rows } = readRows(inFile);
  const d = today();
  let added = 0, touched = 0;
  for (const r of rows) {
    const id = idOf(r);
    if (!id) continue;
    if (led.entries[id]) {
      led.entries[id].last_seen = d;
      if (verdict) led.entries[id].verdict = verdict;
      touched++;
    } else {
      led.entries[id] = {
        first_seen: d, last_seen: d, verdict: verdict || 'scanned',
        addr: r.addr || '', city: r.city || '',
      };
      added++;
    }
  }
  save(led);
  console.log(`LEDGER record: +${added} new, ${touched} updated -> ${Object.keys(led.entries).length} total`);
  console.log('  remember to commit ' + path.relative(ROOT, LEDGER));
}

function cmdStats() {
  const led = load();
  const ids = Object.keys(led.entries);
  const byVerdict = {}, byDay = {};
  for (const id of ids) {
    const e = led.entries[id];
    byVerdict[e.verdict || '?'] = (byVerdict[e.verdict || '?'] || 0) + 1;
    byDay[e.first_seen || '?'] = (byDay[e.first_seen || '?'] || 0) + 1;
  }
  console.log(`LEDGER ${path.relative(ROOT, LEDGER)}: ${ids.length} listing(s), updated ${led.updated || 'never'}`);
  console.log('  by verdict:', JSON.stringify(byVerdict));
  Object.keys(byDay).sort().reverse().slice(0, 10)
    .forEach(d => console.log(`  ${d}: ${byDay[d]} first seen`));
}

function cmdForget(list) {
  const led = load();
  let n = 0;
  for (const id of String(list || '').split(',').map(s => s.trim()).filter(Boolean)) {
    if (led.entries[id]) { delete led.entries[id]; n++; }
  }
  save(led);
  console.log(`LEDGER forget: removed ${n} -> ${Object.keys(led.entries).length} total`);
}

const [cmd, a, b] = process.argv.slice(2);
try {
  if (cmd === 'filter') cmdFilter(a, b);
  else if (cmd === 'record') cmdRecord(a, b);
  else if (cmd === 'stats') cmdStats();
  else if (cmd === 'forget') cmdForget(a);
  else {
    console.error('usage: mls-ledger.js filter <in.json> [out.json] | record <in.json> [verdict] | stats | forget <MLS#,...>');
    process.exit(2);
  }
} catch (e) {
  console.error('ERROR:', e.message);
  process.exit(1);
}
