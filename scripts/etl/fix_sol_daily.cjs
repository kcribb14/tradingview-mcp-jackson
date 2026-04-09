const Database = require('better-sqlite3');
const DB = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
const insert = DB.prepare('INSERT OR IGNORE INTO prices (ticker, date, open, high, low, close, volume, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

async function main() {
  let cursor = new Date('2020-04-01').getTime();
  const now = Date.now();
  let total = 0;
  while (cursor < now) {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=1d&startTime=${cursor}&limit=1000`);
    if (!r.ok) break;
    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) break;
    const tx = DB.transaction(() => {
      for (const k of data) {
        const date = new Date(k[0]).toISOString().split('T')[0];
        insert.run('SOL', date, +k[1], +k[2], +k[3], +k[4], +k[5], 'binance_fix');
        insert.run('SOL-USD', date, +k[1], +k[2], +k[3], +k[4], +k[5], 'binance_fix');
        total += 2;
      }
    });
    tx();
    cursor = data[data.length - 1][0] + 86400000;
    if (data.length < 1000) break;
    await new Promise(r => setTimeout(r, 200));
  }
  console.log('SOL daily bars:', total);
  DB.close();
}
main().catch(console.error);
