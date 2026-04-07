/**
 * Deep history backfill — fetches 30+ years of daily OHLCV per symbol
 * using Yahoo Finance paginated chunks. Completely free.
 *
 * Saves to ~/.tradingview-mcp/cache/history/{SYMBOL}.json
 * Then triggers F&G time series computation via the server.
 */
import fs from 'fs';
import { getDeepHistory } from '../src/data/yahoo_deep.js';

const HIST_DIR = process.env.HOME + '/.tradingview-mcp/cache/history';
const UNIVERSE_PATH = process.env.HOME + '/.tradingview-mcp/universes/master.json';
const BASE = 'http://localhost:3000';

fs.mkdirSync(HIST_DIR, { recursive: true });

async function main() {
  const u = JSON.parse(fs.readFileSync(UNIVERSE_PATH));

  // Priority: large caps + ETFs + commodities first, then mid/small
  const targets = [
    ...(u.US_LARGE_CAP || []),
    ...(u.ETFS || []),
    ...(u.COMMODITIES || []),
    ...(u.ASX_TOP50 || []).map(s => s), // Yahoo handles .AX
    ...(u.ASX_MINING_MID || []),
    ...(u.US_MID_SMALL || []).slice(0, 500),
  ];

  // Skip already-fetched symbols
  const existing = new Set();
  try {
    for (const f of fs.readdirSync(HIST_DIR)) {
      if (f.endsWith('.json')) existing.add(f.replace('.json', ''));
    }
  } catch {}

  const todo = targets.filter(s => !existing.has(s));
  console.log(`Deep history backfill: ${todo.length} symbols (${existing.size} already done)`);
  console.log('Source: Yahoo Finance paginated (free, 30-40 years per stock)\n');

  let ok = 0, fail = 0;
  const startTime = Date.now();

  for (let i = 0; i < todo.length; i++) {
    const sym = todo[i];
    // For crypto, yahoo uses -USD suffix
    let ticker = sym;
    if (!sym.includes('.') && !sym.includes('=') && !sym.includes('-')) {
      // Check if it's a crypto symbol by looking at the universe
      const isCrypto = (u.CRYPTO_MAJOR || []).includes(sym) || (u.CRYPTO_MID || []).includes(sym);
      if (isCrypto) ticker = sym + '-USD';
    }

    const bars = await getDeepHistory(ticker, 1985);

    if (bars.length > 200) {
      const first = new Date(bars[0].time * 1000).toISOString().split('T')[0];
      const last = new Date(bars[bars.length - 1].time * 1000).toISOString().split('T')[0];

      fs.writeFileSync(`${HIST_DIR}/${sym}.json`, JSON.stringify({
        symbol: sym, source: 'yahoo-deep', bars: bars.length,
        firstDate: first, lastDate: last, ohlcv: bars
      }));

      ok++;
      const years = (bars.length / 252).toFixed(1);
      if ((i + 1) % 10 === 0 || bars.length > 5000) {
        console.log(`  ${sym.padEnd(12)} ${bars.length} bars (${years} yr) ${first} → ${last}`);
      }
    } else {
      fail++;
    }

    const pct = ((i + 1) / todo.length * 100).toFixed(1);
    const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
    process.stdout.write(`\r${pct}% | ${i + 1}/${todo.length} | OK:${ok} FAIL:${fail} | ${elapsed}m`);

    // Polite delay — Yahoo is generous but don't hammer
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n\n═══ DEEP HISTORY BACKFILL COMPLETE ═══');
  console.log(`Success: ${ok}, Failed: ${fail}`);

  // Show depth distribution
  const stats = { '30+': 0, '20-30': 0, '10-20': 0, '5-10': 0, '<5': 0 };
  for (const f of fs.readdirSync(HIST_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(fs.readFileSync(`${HIST_DIR}/${f}`));
      const yr = d.bars / 252;
      if (yr > 30) stats['30+']++;
      else if (yr > 20) stats['20-30']++;
      else if (yr > 10) stats['10-20']++;
      else if (yr > 5) stats['5-10']++;
      else stats['<5']++;
    } catch {}
  }
  console.log('\nHistory depth:');
  for (const [r, c] of Object.entries(stats)) console.log(`  ${r} years: ${c}`);
  console.log(`\nSaved to: ${HIST_DIR}`);
}

main().catch(console.error);
