const fs = require('fs');
const UNIVERSE = JSON.parse(fs.readFileSync(process.env.HOME + '/.tradingview-mcp/universes/master.json'));
const BASE = 'http://localhost:3000';

async function warm(sym) {
  try {
    const r = await fetch(BASE + '/api/fetch-and-cache/' + encodeURIComponent(sym) + '?tf=D', {signal: AbortSignal.timeout(10000)});
    const d = await r.json();
    return (d.fg != null || d.ohlcv?.length > 0) ? 1 : 0;
  } catch { return -1; }
}

async function main() {
  const allSyms = [...new Set(Object.values(UNIVERSE).flat())];

  // Get cached symbols
  let cached = new Set();
  try {
    const r = await fetch(BASE + '/api/health');
    const h = await r.json();
    console.log('Server has', h.symbols, 'symbols');
    // Get actual cached keys
    const cr = await fetch(BASE + '/api/cached?limit=50000');
    const cd = await cr.json();
    cached = new Set(cd.symbols?.map(s => s.s) || []);
  } catch {}

  const missing = allSyms.filter(s => !cached.has(s));
  console.log('Universe:', allSyms.length, '| Cached:', cached.size, '| Missing:', missing.length);

  let done = 0, ok = 0, fail = 0;
  const BATCH = 10, DELAY = 500;
  const start = Date.now();

  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(warm));
    results.forEach(r => { done++; if (r > 0) ok++; else fail++; });

    if (done % 100 === 0 || done === missing.length) {
      const pct = (done / missing.length * 100).toFixed(1);
      const rate = Math.round(done / ((Date.now() - start) / 60000));
      const eta = Math.ceil((missing.length - done) / Math.max(rate, 1));
      console.log(pct + '% | ' + done + '/' + missing.length + ' | ' + ok + ' ok ' + fail + ' fail | ' + rate + '/min | ~' + eta + 'm left');
    }

    await new Promise(r => setTimeout(r, DELAY));
  }
  console.log('\nDone:', ok, 'warmed,', fail, 'failed in', ((Date.now()-start)/60000).toFixed(1), 'min');
}
main();
