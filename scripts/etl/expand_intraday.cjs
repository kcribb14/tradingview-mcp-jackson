const Database = require('better-sqlite3');
const db = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
db.pragma('journal_mode = WAL');

// Find tickers with daily data but no 1h, prioritized
const candidates = db.prepare(`
  SELECT p.ticker, COUNT(*) as daily_bars, s.category FROM prices p
  JOIN symbols s ON p.ticker = s.ticker
  LEFT JOIN (SELECT DISTINCT ticker FROM prices_1h) h ON p.ticker = h.ticker
  WHERE h.ticker IS NULL
  GROUP BY p.ticker HAVING daily_bars > 500
  ORDER BY CASE WHEN s.category IN ('US_LARGE_CAP','ETFS','COMMODITIES') THEN 1
    WHEN s.category LIKE 'CRYPTO%' THEN 2
    WHEN s.category LIKE 'ASX%' THEN 3 ELSE 4 END, daily_bars DESC
  LIMIT 100
`).all();

console.log('Candidates for 1h expansion:', candidates.length);

const insert = db.prepare('INSERT OR IGNORE INTO prices_1h (ticker, ts, open, high, low, close, volume, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

async function fetch1h(ticker) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - 730 * 86400;
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${start}&period2=${now}&interval=1h`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) return [];
    const d = await r.json();
    const result = d?.chart?.result?.[0];
    if (!result?.timestamp) return [];
    const q = result.indicators.quote[0];
    return result.timestamp.map((t, i) => q.close?.[i] > 0 ? { ts: t, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume?.[i] || 0 } : null).filter(Boolean);
  } catch { return []; }
}

async function main() {
  let ok = 0, totalBars = 0;
  for (let i = 0; i < candidates.length; i++) {
    const { ticker, category } = candidates[i];
    const bars = await fetch1h(ticker);
    if (bars.length > 100) {
      const tx = db.transaction(() => { for (const b of bars) insert.run(ticker, b.ts, b.o, b.h, b.l, b.c, b.v, 'yahoo'); });
      tx();
      ok++; totalBars += bars.length;
      console.log(`  ${ticker.padEnd(14)} +${bars.length} 1h bars (${category})`);
    }
    await new Promise(r => setTimeout(r, 600));
  }
  console.log(`\nDone: ${ok} tickers, ${totalBars.toLocaleString()} new 1h bars`);
  const total = db.prepare('SELECT COUNT(DISTINCT ticker) as t FROM prices_1h').get();
  console.log('Total 1h tickers now:', total.t);
  db.close();
}
main().catch(console.error);
