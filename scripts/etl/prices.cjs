const Database = require('better-sqlite3');
const DB_PATH = process.env.HOME + '/.tradingview-mcp/db/fg.db';
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const insertPrice = db.prepare('INSERT OR REPLACE INTO prices (ticker, date, open, high, low, close, volume, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

async function fetchYahooChunked(ticker, startYear) {
  const out = [];
  const now = Math.floor(Date.now() / 1000);
  for (let year = startYear; year < new Date().getFullYear() + 1; year += 10) {
    const p1 = Math.floor(new Date(`${year}-01-01`).getTime() / 1000);
    const p2 = Math.min(Math.floor(new Date(`${year + 10}-01-01`).getTime() / 1000), now);
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${p1}&period2=${p2}&interval=1d`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000)
      });
      if (!r.ok) continue;
      const d = await r.json();
      const result = d?.chart?.result?.[0];
      if (!result?.timestamp) continue;
      const q = result.indicators.quote[0];
      for (let i = 0; i < result.timestamp.length; i++) {
        if (q.close?.[i] > 0) out.push({
          date: new Date(result.timestamp[i] * 1000).toISOString().split('T')[0],
          o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume?.[i] || 0
        });
      }
    } catch {}
    await new Promise(r => setTimeout(r, 400));
  }
  return out;
}

const batchInsert = db.transaction((ticker, bars) => {
  for (const b of bars) insertPrice.run(ticker, b.date, b.o, b.h, b.l, b.c, b.v, 'yahoo');
});

async function backfill(ticker) {
  const last = db.prepare('SELECT MAX(date) as d FROM prices WHERE ticker = ?').get(ticker);
  if (last?.d) {
    const daysSince = Math.floor((Date.now() - new Date(last.d).getTime()) / 86400000);
    if (daysSince < 1) return 'fresh';
  }
  const startYear = last?.d ? new Date(last.d).getFullYear() : 1985;
  const bars = await fetchYahooChunked(ticker, startYear);
  if (bars.length > 0) { batchInsert(ticker, bars); return bars.length; }
  return 0;
}

async function main() {
  const tickers = db.prepare('SELECT ticker FROM symbols ORDER BY ticker').all().map(r => r.ticker);
  console.log('Price ETL:', tickers.length, 'symbols');
  let ok = 0, fail = 0;
  for (let i = 0; i < tickers.length; i++) {
    try {
      const r = await backfill(tickers[i]);
      if (r === 'fresh' || r > 0) ok++; else fail++;
    } catch { fail++; }
    if (i % 50 === 0) {
      const c = db.prepare('SELECT COUNT(*) as n, COUNT(DISTINCT ticker) as t FROM prices').get();
      process.stdout.write(`\r${i+1}/${tickers.length} OK:${ok} FAIL:${fail} DB:${c.t} tickers ${c.n} bars`);
    }
  }
  console.log('\nDone:', ok, 'ok', fail, 'fail');
}
main().catch(console.error).finally(() => db.close());
