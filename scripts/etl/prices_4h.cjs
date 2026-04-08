// 4h resampler — aggregates 1h bars into 4h candles (00:00, 04:00, 08:00, 12:00, 16:00, 20:00 UTC)
const Database = require('better-sqlite3');
const DB = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
DB.pragma('journal_mode = WAL');

const insert = DB.prepare('INSERT OR IGNORE INTO prices_4h (ticker, ts, open, high, low, close, volume, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

function bucket(ts) { return Math.floor(ts / (4 * 3600)) * (4 * 3600); }

async function main() {
  const tickers = DB.prepare('SELECT DISTINCT ticker FROM prices_1h').all().map(r => r.ticker);
  console.log('Resampling 4h for', tickers.length, 'tickers');
  let total = 0;

  for (let i = 0; i < tickers.length; i++) {
    const t = tickers[i];
    const bars = DB.prepare('SELECT ts, open, high, low, close, volume FROM prices_1h WHERE ticker = ? ORDER BY ts').all(t);
    const buckets = new Map();
    for (const b of bars) {
      const k = bucket(b.ts);
      if (!buckets.has(k)) buckets.set(k, { ts: k, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume });
      else { const a = buckets.get(k); a.h = Math.max(a.h, b.high); a.l = Math.min(a.l, b.low); a.c = b.close; a.v += b.volume; }
    }
    const tx = DB.transaction(() => {
      for (const b of buckets.values()) { insert.run(t, b.ts, b.o, b.h, b.l, b.c, b.v, 'resampled_1h'); total++; }
    });
    tx();
    process.stdout.write(`\r${i + 1}/${tickers.length} ${t.padEnd(12)} ${buckets.size} 4h bars | total:${total}`);
  }
  console.log('\n');
  const stats = DB.prepare('SELECT COUNT(*) as n, COUNT(DISTINCT ticker) as t FROM prices_4h').get();
  console.log('4h DB:', stats.n.toLocaleString(), 'bars,', stats.t, 'tickers');
  DB.close();
}
main().catch(console.error);
