// Alpaca Market Data — free tier, 200 req/min, US stocks since 2016
// Get free key: https://alpaca.markets (paper trading, no real $)
// export ALPACA_API_KEY="..." ALPACA_API_SECRET="..."
const Database = require('better-sqlite3');
const KEY = process.env.ALPACA_API_KEY;
const SECRET = process.env.ALPACA_API_SECRET;

if (!KEY || !SECRET) {
  console.log('ALPACA_API_KEY/SECRET not set. Get free at https://alpaca.markets');
  process.exit(0);
}

const DB = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
DB.pragma('journal_mode = WAL');
const insert = DB.prepare('INSERT OR IGNORE INTO prices_1h (ticker, ts, open, high, low, close, volume, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

async function fetchAlpaca(ticker, start) {
  try {
    const r = await fetch(`https://data.alpaca.markets/v2/stocks/${ticker}/bars?timeframe=1Hour&start=${start}&limit=10000&feed=iex`, {
      headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET },
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.bars || []).map(b => ({ ts: Math.floor(new Date(b.t).getTime() / 1000), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
  } catch { return []; }
}

async function main() {
  console.log('Alpaca 1h ETL — US stocks since 2016');
  const tickers = DB.prepare("SELECT ticker FROM symbols WHERE category IN ('US_LARGE_CAP','ETFS') AND ticker NOT LIKE '%.%' AND ticker NOT LIKE '%=%' ORDER BY ticker").all().map(r => r.ticker);
  console.log('Tickers:', tickers.length);
  let ok = 0, total = 0;
  for (let i = 0; i < tickers.length; i++) {
    const bars = await fetchAlpaca(tickers[i], '2016-01-01T00:00:00Z');
    if (bars.length > 0) {
      DB.transaction(() => { for (const b of bars) insert.run(tickers[i], b.ts, b.o, b.h, b.l, b.c, b.v, 'alpaca'); })();
      ok++; total += bars.length;
    }
    if (i % 25 === 0) process.stdout.write(`\r${i + 1}/${tickers.length} OK:${ok} total:${total}`);
    await new Promise(r => setTimeout(r, 350));
  }
  console.log(`\nDone: ${ok} tickers, ${total} bars`);
  DB.close();
}
main().catch(console.error);
