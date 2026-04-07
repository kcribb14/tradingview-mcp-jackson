const Database = require('better-sqlite3');
const DB_PATH = process.env.HOME + '/.tradingview-mcp/db/fg.db';
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const insertPrice = db.prepare('INSERT OR REPLACE INTO prices (ticker, date, open, high, low, close, volume, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const lastDateStmt = db.prepare('SELECT MAX(date) as last FROM prices WHERE ticker = ?');

async function fetchYahooForex(ticker, startYear) {
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
          o: q.open[i] || q.close[i], h: q.high[i] || q.close[i],
          l: q.low[i] || q.close[i], c: q.close[i], v: q.volume?.[i] || 0
        });
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return out;
}

async function fetchFrankfurter(base, quote) {
  try {
    const url = `https://api.frankfurter.app/1999-01-04..${new Date().toISOString().split('T')[0]}?from=${base}&to=${quote}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return [];
    const data = await r.json();
    return Object.entries(data.rates || {}).map(([date, rates]) => {
      const rate = rates[quote];
      return rate > 0 ? { date, o: rate, h: rate, l: rate, c: rate, v: 0 } : null;
    }).filter(Boolean);
  } catch { return []; }
}

async function backfillPair(ticker) {
  const lastRow = lastDateStmt.get(ticker);
  if (lastRow?.last) {
    const days = Math.floor((Date.now() - new Date(lastRow.last).getTime()) / 86400000);
    if (days < 1) return { ticker, status: 'fresh', inserted: 0 };
  }
  const startYear = lastRow?.last ? new Date(lastRow.last).getFullYear() : 1999;

  let bars = await fetchYahooForex(ticker, startYear);
  let source = 'yahoo';

  // Frankfurter fallback for EUR pairs
  if (bars.length < 50) {
    const clean = ticker.replace('=X', '');
    if (clean.length === 6) {
      const base = clean.slice(0, 3), quote = clean.slice(3, 6);
      if (base === 'EUR' || quote === 'EUR') {
        const fb = base === 'EUR' ? await fetchFrankfurter('EUR', quote) : await fetchFrankfurter(quote, 'EUR');
        if (fb.length > bars.length) {
          bars = base === 'EUR' ? fb : fb.map(b => ({ ...b, o: 1/b.o, h: 1/b.l, l: 1/b.h, c: 1/b.c }));
          source = 'frankfurter';
        }
      }
    }
  }

  if (bars.length === 0) return { ticker, status: 'no_data', inserted: 0 };

  const insertMany = db.transaction((rows) => {
    for (const b of rows) insertPrice.run(ticker, b.date, b.o, b.h, b.l, b.c, b.v, source);
  });
  insertMany(bars);
  return { ticker, inserted: bars.length, source };
}

async function main() {
  const tickers = db.prepare("SELECT ticker FROM symbols WHERE asset_class = 'forex' ORDER BY ticker").all().map(r => r.ticker);
  console.log('Forex backfill:', tickers.length, 'pairs');

  let ok = 0, fail = 0;
  const start = Date.now();
  for (let i = 0; i < tickers.length; i++) {
    try {
      const r = await backfillPair(tickers[i]);
      if (r.inserted > 0 || r.status === 'fresh') ok++; else fail++;
      process.stdout.write(`\r${i+1}/${tickers.length} ${tickers[i].padEnd(12)} ${(r.source||'').padEnd(12)} +${r.inserted||0} | OK:${ok} FAIL:${fail}`);
    } catch { fail++; }
  }

  console.log('\n');
  const summary = db.prepare(`
    SELECT COUNT(DISTINCT p.ticker) as pairs, COUNT(*) as bars, MIN(date) as oldest, MAX(date) as newest
    FROM prices p JOIN symbols s ON p.ticker = s.ticker WHERE s.asset_class = 'forex'
  `).get();
  console.log('Forex:', summary.pairs, 'pairs,', summary.bars, 'bars,', summary.oldest, '→', summary.newest);
  db.close();
}
main().catch(console.error);
