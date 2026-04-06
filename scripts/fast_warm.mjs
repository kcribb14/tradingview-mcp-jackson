import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const HOME = homedir();
const UNIVERSE = JSON.parse(readFileSync(join(HOME, '.tradingview-mcp/universes/master.json'), 'utf8'));
const BASE = 'http://localhost:3000';

async function warm(sym) {
  try {
    const r = await fetch(BASE + '/api/fetch-and-cache/' + encodeURIComponent(sym) + '?tf=D', {signal: AbortSignal.timeout(10000)});
    const d = await r.json();
    return (d.fg != null || d.cached) ? 1 : 0;
  } catch { return -1; }
}

const allSyms = [...new Set(Object.values(UNIVERSE).flat())];
console.log('Universe:', allSyms.length, 'symbols');

// Get cached
let cached = new Set();
try {
  const r = await fetch(BASE + '/api/cached?limit=50000');
  const cd = await r.json();
  cached = new Set(cd.symbols?.map(s => s.s) || []);
  console.log('Already cached:', cached.size);
} catch { console.log('Could not check cache'); }

const missing = allSyms.filter(s => !cached.has(s));
console.log('Missing:', missing.length);

let done = 0, ok = 0, fail = 0;
const BATCH = 8, DELAY = 600;
const start = Date.now();

for (let i = 0; i < missing.length; i += BATCH) {
  const batch = missing.slice(i, i + BATCH);
  const results = await Promise.all(batch.map(warm));
  results.forEach(r => { done++; if (r > 0) ok++; else fail++; });

  if (done % 100 < BATCH || done >= missing.length) {
    const pct = (done / missing.length * 100).toFixed(1);
    const rate = Math.round(done / ((Date.now() - start) / 60000));
    const eta = Math.ceil((missing.length - done) / Math.max(rate, 1));
    console.log(pct + '% | ' + done + '/' + missing.length + ' | ok:' + ok + ' fail:' + fail + ' | ' + rate + '/min | ~' + eta + 'm left');
  }
  await new Promise(r => setTimeout(r, DELAY));
}
console.log('\nDone:', ok, 'warmed,', fail, 'failed in', ((Date.now()-start)/60000).toFixed(1), 'min');
