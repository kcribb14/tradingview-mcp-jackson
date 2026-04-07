/**
 * Financial Datasets backfill — fills US stocks that Yahoo rate-limited.
 * Triggers fetch-and-cache on the server which now uses FD as fallback.
 */
import fs from 'fs';

const BASE = 'http://localhost:3000';
const API_KEY = process.env.FINANCIAL_DATASETS_API_KEY;

if (!API_KEY) {
  console.error('FINANCIAL_DATASETS_API_KEY not set. Get a key at https://financialdatasets.ai');
  process.exit(1);
}

async function main() {
  const u = JSON.parse(fs.readFileSync(process.env.HOME + '/.tradingview-mcp/universes/master.json'));
  const c = JSON.parse(fs.readFileSync(process.env.HOME + '/.tradingview-mcp/cache/fg_scores.json'));

  const usStocks = [...(u.US_LARGE_CAP || []), ...(u.US_MID_SMALL || [])];
  const missing = usStocks.filter(s => {
    const e = c[s + ':D'];
    if (!e) return true;
    if (e.fgScore == null && e.fg == null) return true;
    if (!(e.lastClose > 0 || e.p > 0)) return true;
    return false;
  });

  console.log(`US stocks needing backfill: ${missing.length}`);
  if (missing.length === 0) { console.log('All filled!'); return; }

  let ok = 0, fail = 0;
  for (let i = 0; i < missing.length; i++) {
    const sym = missing[i];
    try {
      const r = await fetch(`${BASE}/api/fetch-and-cache/${sym}?tf=D`, { signal: AbortSignal.timeout(20000) });
      const d = await r.json();
      if (d.fg != null || d.fgScore != null) ok++;
      else fail++;
    } catch { fail++; }

    if ((i + 1) % 50 === 0 || i === missing.length - 1) {
      console.log(`${i + 1}/${missing.length} | OK:${ok} FAIL:${fail}`);
    }
    await new Promise(r => setTimeout(r, 250));
  }

  console.log(`\nDone: ${ok} filled, ${fail} failed out of ${missing.length}`);
}

main().catch(console.error);
