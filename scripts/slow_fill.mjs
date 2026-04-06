import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const HOME = homedir();
const UNIVERSE = JSON.parse(readFileSync(join(HOME, '.tradingview-mcp/universes/master.json'), 'utf8'));
const CACHE_PATH = join(HOME, '.tradingview-mcp/cache/fg_scores.json');
const BASE = 'http://localhost:3000';

async function warm(sym) {
  try {
    const r = await fetch(BASE + '/api/fetch-and-cache/' + encodeURIComponent(sym) + '?tf=D', { signal: AbortSignal.timeout(15000) });
    const d = await r.json();
    return d.error ? 'fail' : 'ok';
  } catch { return 'timeout'; }
}

let cache;
try { cache = JSON.parse(readFileSync(CACHE_PATH, 'utf8')); } catch { cache = {}; }

const allSyms = [...new Set(Object.values(UNIVERSE).flat())];
const needsFetch = allSyms.filter(sym => {
  const e = cache[sym + ':D'];
  return !e || e.fgScore == null || !e.lastClose || e.lastClose === 0;
});

console.log('Universe:', allSyms.length, '| Need:', needsFetch.length);

// Prioritize: US stocks first (Yahoo works well), then ASX, then crypto
const usStocks = needsFetch.filter(s => !s.includes('.') && !s.includes('=') && s !== s.toUpperCase());
const asxStocks = needsFetch.filter(s => s.endsWith('.AX'));
const intlStocks = needsFetch.filter(s => /\.(TO|L|HK|T|NS|DE|JO)$/.test(s));
const etfsComm = needsFetch.filter(s => s.includes('=') || ['SPY','QQQ','IWM','DIA','TLT','GLD','SLV'].includes(s));
const crypto = needsFetch.filter(s => !s.includes('.') && !s.includes('=') && s === s.toUpperCase() && s.length <= 10);
const rest = needsFetch.filter(s => ![...usStocks,...asxStocks,...intlStocks,...etfsComm,...crypto].includes(s));

const ordered = [...etfsComm, ...intlStocks, ...asxStocks, ...usStocks.slice(0, 1000), ...crypto.slice(0, 500), ...rest.slice(0, 200)];
console.log('Ordered batch:', ordered.length, '(ETF/Comm:', etfsComm.length, 'Intl:', intlStocks.length, 'ASX:', asxStocks.length, 'US:', Math.min(usStocks.length, 1000), 'Crypto:', Math.min(crypto.length, 500), ')');

const BATCH = 5, DELAY = 1500; // Slow and steady
let done = 0, ok = 0, fail = 0;
const t0 = Date.now();

for (let i = 0; i < ordered.length; i += BATCH) {
  const batch = ordered.slice(i, i + BATCH);
  const results = await Promise.all(batch.map(warm));
  for (const r of results) { done++; if (r === 'ok') ok++; else fail++; }

  if (done % 50 < BATCH) {
    const rate = Math.round(done / ((Date.now() - t0) / 60000));
    const eta = Math.ceil((ordered.length - done) / Math.max(rate, 1));
    console.log(Math.round(done/ordered.length*100) + '% | ' + done + '/' + ordered.length + ' | ok:' + ok + ' fail:' + fail + ' | ' + rate + '/min | ~' + eta + 'min');
  }
  await new Promise(r => setTimeout(r, DELAY));
}

console.log('\nDone:', ok, 'ok,', fail, 'fail in', ((Date.now()-t0)/60000).toFixed(1), 'min');
