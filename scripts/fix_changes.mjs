import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const HOME = homedir();
const CACHE_PATH = join(HOME, '.tradingview-mcp/cache/fg_scores.json');
const BASE = 'http://localhost:3000';
const CONCURRENT = 8;
const DELAY = 500;
const MAX_MIN = 55;

async function fetchOne(sym) {
  try {
    const r = await fetch(BASE + '/api/fetch-and-cache/' + encodeURIComponent(sym) + '?tf=D', { signal: AbortSignal.timeout(12000) });
    const d = await r.json();
    return d.error ? 'fail' : 'ok';
  } catch { return 'timeout'; }
}

const cache = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
const needsFix = [];
for (const [k, v] of Object.entries(cache)) {
  if (!k.endsWith(':D')) continue;
  if (v.fgScore != null && (v.priceChg === 0 || v.priceChg === undefined || !v.lastClose || v.lastClose === 0)) {
    needsFix.push(k.replace(':D', ''));
  }
}
console.log('Need fix (priceChg=0 or no price):', needsFix.length);
console.log('Max runtime:', MAX_MIN, 'min | Batch:', CONCURRENT, '| Delay:', DELAY + 'ms');

let done = 0, ok = 0, fail = 0;
const t0 = Date.now();

for (let i = 0; i < needsFix.length; i += CONCURRENT) {
  if (Date.now() - t0 > MAX_MIN * 60000) { console.log('\nTime limit'); break; }
  const batch = needsFix.slice(i, i + CONCURRENT);
  const results = await Promise.all(batch.map(fetchOne));
  for (const r of results) { done++; if (r === 'ok') ok++; else fail++; }
  if (done % 100 < CONCURRENT) {
    const rate = Math.round(done / ((Date.now() - t0) / 60000));
    console.log(Math.round(done/needsFix.length*100) + '% | ' + done + '/' + needsFix.length + ' | ok:' + ok + ' fail:' + fail + ' | ' + rate + '/min');
  }
  await new Promise(r => setTimeout(r, DELAY));
}
console.log('\nDone:', ok, 'fixed,', fail, 'failed in', ((Date.now()-t0)/60000).toFixed(1), 'min');
