const Database = require('better-sqlite3');
const db = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
db.pragma('journal_mode = WAL');

const insertPrice = db.prepare('INSERT OR IGNORE INTO prices (ticker, date, open, high, low, close, volume, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

// Find non-DEX symbols with zero prices (DEX tokens don't have Yahoo data)
const gaps = db.prepare(`
  SELECT s.ticker, s.category FROM symbols s
  LEFT JOIN (SELECT DISTINCT ticker FROM prices) p ON s.ticker = p.ticker
  WHERE p.ticker IS NULL AND s.category NOT LIKE 'DEX%'
  ORDER BY CASE
    WHEN s.category IN ('US_LARGE_CAP','ETFS','COMMODITIES','FOREX_MAJORS') THEN 1
    WHEN s.category LIKE 'CRYPTO%' THEN 2
    WHEN s.category LIKE 'ASX%' THEN 3
    ELSE 4 END, s.ticker
  LIMIT 300
`).all();

console.log('Non-DEX symbols missing prices:', gaps.length);
const bycat = {};
for (const g of gaps) { bycat[g.category] = (bycat[g.category] || 0) + 1; }
for (const [c, n] of Object.entries(bycat).sort((a, b) => b[1] - a[1])) console.log('  ' + c.padEnd(22) + n);

async function fetchYahooChunked(ticker) {
  const all = [];
  const now = Math.floor(Date.now() / 1000);
  for (let year = 1990; year < new Date().getFullYear() + 1; year += 10) {
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
        if (q.close?.[i] > 0) all.push({
          date: new Date(result.timestamp[i] * 1000).toISOString().split('T')[0],
          o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume?.[i] || 0
        });
      }
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  return all;
}

// For crypto, try Binance first
async function fetchBinanceDaily(ticker) {
  const base = ticker.replace(/-USD$/, '').replace(/USD$/, '').toUpperCase();
  const sym = base + 'USDT';
  const all = [];
  let cursor = new Date('2017-01-01').getTime();
  const now = Date.now();
  while (cursor < now) {
    try {
      const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1d&startTime=${cursor}&limit=1000`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) break;
      const data = await r.json();
      if (!Array.isArray(data) || data.length === 0) break;
      for (const k of data) all.push({ date: new Date(k[0]).toISOString().split('T')[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
      cursor = data[data.length - 1][0] + 86400000;
      if (data.length < 1000) break;
    } catch { break; }
    await new Promise(r => setTimeout(r, 100));
  }
  return all;
}

async function main() {
  console.log('\nFilling gaps...\n');
  let ok = 0, fail = 0, totalBars = 0;
  for (let i = 0; i < gaps.length; i++) {
    const { ticker, category } = gaps[i];
    let bars;
    if (category?.includes('CRYPTO')) {
      bars = await fetchBinanceDaily(ticker);
      if (bars.length < 20) bars = await fetchYahooChunked(ticker.includes('-') ? ticker : ticker + '-USD');
    } else {
      bars = await fetchYahooChunked(ticker);
    }

    if (bars.length > 0) {
      const tx = db.transaction(() => { for (const b of bars) insertPrice.run(ticker, b.date, b.o, b.h, b.l, b.c, b.v, 'gap_fill'); });
      tx();
      ok++; totalBars += bars.length;
      if (bars.length > 1000 || i % 25 === 0) console.log(`  ${ticker.padEnd(14)} +${bars.length} bars (${category})`);
    } else { fail++; }

    if (i % 50 === 0 && i > 0) console.log(`  ... ${i}/${gaps.length} | OK:${ok} FAIL:${fail} | ${totalBars.toLocaleString()} bars`);
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`\nDone: ${ok} filled, ${fail} failed, ${totalBars.toLocaleString()} new bars`);
  db.close();
}
main().catch(console.error);
