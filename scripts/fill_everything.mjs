#!/usr/bin/env node
// AGGRESSIVE DATA LOADER — fills ALL missing data
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const HOME = homedir();
const UNIVERSE = JSON.parse(readFileSync(join(HOME, '.tradingview-mcp/universes/master.json'), 'utf8'));
const CACHE_PATH = join(HOME, '.tradingview-mcp/cache/fg_scores.json');
const BASE = 'http://localhost:3000';
const CONCURRENT = 15;
const DELAY = 300;

async function warm(sym) {
  try {
    const r = await fetch(BASE + '/api/fetch-and-cache/' + encodeURIComponent(sym) + '?tf=D', { signal: AbortSignal.timeout(12000) });
    const d = await r.json();
    if (d.error) return 'error';
    if (d.fg != null || d.cached) return 'ok';
    return 'no_data';
  } catch { return 'timeout'; }
}

const allSyms = [...new Set(Object.values(UNIVERSE).flat())];
console.log('Universe:', allSyms.length, 'symbols');

// Find gaps
let cache;
try { cache = JSON.parse(readFileSync(CACHE_PATH, 'utf8')); } catch { cache = {}; }
const needsFetch = allSyms.filter(sym => {
  const e = cache[sym + ':D'];
  return !e || e.fgScore == null || !e.lastClose || e.lastClose === 0;
});

console.log('Already complete:', allSyms.length - needsFetch.length);
console.log('Need fetch:', needsFetch.length);
if (needsFetch.length === 0) { console.log('ALL COMPLETE!'); process.exit(0); }

const estMin = (Math.ceil(needsFetch.length / CONCURRENT) * DELAY / 60000).toFixed(1);
console.log('Estimated:', estMin, 'min at', CONCURRENT, 'concurrent\n');

let done = 0, ok = 0, fail = 0;
const t0 = Date.now();
const errors = {};

for (let i = 0; i < needsFetch.length; i += CONCURRENT) {
  const batch = needsFetch.slice(i, i + CONCURRENT);
  const results = await Promise.all(batch.map(warm));
  for (const r of results) { done++; if (r === 'ok') ok++; else { fail++; errors[r] = (errors[r] || 0) + 1; } }

  if (done % 100 < CONCURRENT || done >= needsFetch.length) {
    const pct = (done / needsFetch.length * 100).toFixed(1);
    const rate = Math.round(done / ((Date.now() - t0) / 60000));
    const eta = Math.ceil((needsFetch.length - done) / Math.max(rate, 1));
    console.log(pct + '% | ' + done + '/' + needsFetch.length + ' | ok:' + ok + ' fail:' + fail + ' | ' + rate + '/min | ~' + eta + 'min left');
  }
  await new Promise(r => setTimeout(r, DELAY));
}

console.log('\n═══════════════════════════════════');
console.log('COMPLETE:', ok, 'ok,', fail, 'failed in', ((Date.now() - t0) / 60000).toFixed(1), 'min');
console.log('Errors:', JSON.stringify(errors));

// Final count
try {
  const final = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  let complete = 0;
  for (const sym of allSyms) { const e = final[sym + ':D']; if (e?.fgScore != null && e?.lastClose > 0) complete++; }
  console.log('Coverage:', complete + '/' + allSyms.length, '(' + (complete / allSyms.length * 100).toFixed(1) + '%)');
} catch {}
