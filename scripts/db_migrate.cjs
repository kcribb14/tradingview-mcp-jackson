const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const DB_PATH = path.join(process.env.HOME, '.tradingview-mcp', 'db', 'fg.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = normal');

// Prepared statements for bulk inserts
const insertSym = db.prepare('INSERT OR REPLACE INTO symbols (ticker, category) VALUES (?, ?)');
const insertPrice = db.prepare('INSERT OR REPLACE INTO prices (ticker, date, open, high, low, close, volume, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const insertFG = db.prepare('INSERT OR REPLACE INTO fg_history (ticker, date, fg_score, zone) VALUES (?, ?, ?, ?)');

// 1. Load universe
const u = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.tradingview-mcp', 'universes', 'master.json')));
const insertSyms = db.transaction(() => {
  let count = 0;
  for (const [cat, tickers] of Object.entries(u)) {
    for (const t of tickers) { insertSym.run(t, cat); count++; }
  }
  return count;
});
console.log('Symbols:', insertSyms());

// 2. Migrate history cache files (30+ year OHLCV)
const histDir = path.join(process.env.HOME, '.tradingview-mcp', 'cache', 'history');
if (fs.existsSync(histDir)) {
  const files = fs.readdirSync(histDir).filter(f => f.endsWith('.json'));
  let totalBars = 0;

  const batchInsert = db.transaction((ticker, bars, source) => {
    for (const bar of bars) {
      const date = new Date(bar.time ? bar.time * 1000 : bar.t * 1000).toISOString().split('T')[0];
      const o = bar.open ?? bar.o, h = bar.high ?? bar.h, l = bar.low ?? bar.l;
      const c = bar.close ?? bar.c, v = bar.volume ?? bar.v ?? 0;
      if (c > 0) { insertPrice.run(ticker, date, o, h, l, c, v, source); totalBars++; }
    }
  });

  for (let i = 0; i < files.length; i++) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(histDir, files[i])));
      const ticker = data.symbol || files[i].replace('.json', '');
      batchInsert(ticker, data.ohlcv || [], data.source || 'yahoo-deep');
    } catch {}
    if (i % 100 === 0) process.stdout.write(`\rHistory: ${i}/${files.length} files, ${totalBars} bars`);
  }
  console.log(`\nPrices migrated: ${totalBars}`);
}

// 3. Migrate fg_scores cache (fgHistory arrays)
const cachePath = path.join(process.env.HOME, '.tradingview-mcp', 'cache', 'fg_scores.json');
if (fs.existsSync(cachePath)) {
  const cache = JSON.parse(fs.readFileSync(cachePath));
  let fgCount = 0;

  const batchFG = db.transaction((ticker, history, startTs) => {
    const startDate = startTs ? new Date(startTs * 1000) : new Date(Date.now() - history.length * 86400000);
    for (let i = 0; i < history.length; i++) {
      const score = history[i];
      if (score == null) continue;
      const date = new Date(startDate.getTime() + i * 86400000).toISOString().split('T')[0];
      const zone = score < -25 ? 'extreme_fear' : score < -10 ? 'fear' : score < 10 ? 'neutral' : score < 25 ? 'greed' : 'extreme_greed';
      insertFG.run(ticker, date, score, zone);
      fgCount++;
    }
  });

  let processed = 0;
  for (const [k, v] of Object.entries(cache)) {
    if (!k.endsWith(':D')) continue;
    const ticker = k.replace(':D', '');
    if (Array.isArray(v.fgHistory) && v.fgHistory.length > 0) {
      batchFG(ticker, v.fgHistory, v.fgDates?.[0] || v.fgHistoryStart || null);
    }
    processed++;
    if (processed % 500 === 0) process.stdout.write(`\rF&G: ${processed} symbols, ${fgCount} points`);
  }
  console.log(`\nF&G migrated: ${fgCount} points`);
}

// Summary
const stats = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM symbols) as symbols,
    (SELECT COUNT(*) FROM prices) as prices,
    (SELECT COUNT(DISTINCT ticker) FROM prices) as tickers_with_prices,
    (SELECT COUNT(*) FROM fg_history) as fg_points,
    (SELECT COUNT(DISTINCT ticker) FROM fg_history) as tickers_with_fg
`).get();
console.log('\nDB summary:', stats);
console.log('DB size:', (fs.statSync(DB_PATH).size / 1048576).toFixed(1) + ' MB');
db.close();
