// Binance klines — free, 1200 req/min, no key, since 2017
const Database = require('better-sqlite3');
const DB = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
DB.pragma('journal_mode = WAL');

const insert = DB.prepare('INSERT OR IGNORE INTO prices_1h (ticker, ts, open, high, low, close, volume, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

const PAIRS = {
  'BTC-USD':'BTCUSDT','ETH-USD':'ETHUSDT','SOL-USD':'SOLUSDT','BNB-USD':'BNBUSDT',
  'XRP-USD':'XRPUSDT','ADA-USD':'ADAUSDT','DOGE-USD':'DOGEUSDT','AVAX-USD':'AVAXUSDT',
  'DOT-USD':'DOTUSDT','LINK-USD':'LINKUSDT','LTC-USD':'LTCUSDT','NEAR-USD':'NEARUSDT',
  'UNI-USD':'UNIUSDT','ATOM-USD':'ATOMUSDT','ARB-USD':'ARBUSDT','OP-USD':'OPUSDT',
  'SUI-USD':'SUIUSDT','APT-USD':'APTUSDT','SHIB-USD':'SHIBUSDT','PEPE-USD':'PEPEUSDT',
  'INJ-USD':'INJUSDT','FIL-USD':'FILUSDT','AAVE-USD':'AAVEUSDT','MKR-USD':'MKRUSDT',
  'RNDR-USD':'RNDRUSDT','FET-USD':'FETUSDT','GRT-USD':'GRTUSDT','IMX-USD':'IMXUSDT',
  'BONK-USD':'BONKUSDT','WIF-USD':'WIFUSDT','SEI-USD':'SEIUSDT','TIA-USD':'TIAUSDT',
};

async function fetchAll(binSym, startMs) {
  const all = [];
  let cursor = startMs;
  const now = Date.now();
  while (cursor < now) {
    try {
      const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${binSym}&interval=1h&startTime=${cursor}&limit=1000`, { signal: AbortSignal.timeout(15000) });
      if (r.status === 429) { await new Promise(r => setTimeout(r, 5000)); continue; }
      if (!r.ok) break;
      const data = await r.json();
      if (!Array.isArray(data) || data.length === 0) break;
      for (const k of data) all.push({ ts: Math.floor(k[0] / 1000), o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
      cursor = data[data.length - 1][0] + 3600000;
      if (data.length < 1000) break;
      await new Promise(r => setTimeout(r, 80));
    } catch { break; }
  }
  return all;
}

async function main() {
  console.log('Binance 1h ETL — crypto since 2017\n');
  const startOf2017 = new Date('2017-01-01').getTime();
  let ok = 0, totalBars = 0;
  const entries = Object.entries(PAIRS);

  for (let i = 0; i < entries.length; i++) {
    const [ticker, binSym] = entries[i];
    const existing = DB.prepare('SELECT MIN(ts) as oldest, COUNT(*) as n FROM prices_1h WHERE ticker = ?').get(ticker);
    // Only fetch from before our earliest bar or from 2017
    const startMs = existing?.oldest ? Math.min(existing.oldest * 1000, startOf2017) : startOf2017;

    const bars = await fetchAll(binSym, startMs);
    if (bars.length > 0) {
      const tx = DB.transaction(() => { for (const b of bars) insert.run(ticker, b.ts, b.o, b.h, b.l, b.c, b.v, 'binance'); });
      tx();
      ok++; totalBars += bars.length;
    }
    process.stdout.write(`\r${i + 1}/${entries.length} ${ticker.padEnd(10)} +${bars.length.toLocaleString()} | total: ${totalBars.toLocaleString()}`);
  }

  console.log('\n');
  const stats = DB.prepare("SELECT COUNT(*) as n, COUNT(DISTINCT ticker) as t FROM prices_1h WHERE source='binance'").get();
  console.log('Binance 1h:', stats.n.toLocaleString(), 'bars,', stats.t, 'tickers');

  // Show BTC depth
  const btc = DB.prepare("SELECT COUNT(*) as n FROM prices_1h WHERE ticker='BTC-USD'").get();
  console.log('BTC-USD total 1h bars (all sources):', btc.n.toLocaleString());
  DB.close();
}
main().catch(console.error);
