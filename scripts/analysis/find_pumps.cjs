const Database = require('better-sqlite3');
const db = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');

db.exec(`
CREATE TABLE IF NOT EXISTS pump_events (
  event_id TEXT PRIMARY KEY, ticker TEXT, source TEXT, chain TEXT, pump_date TEXT,
  pump_start_price REAL, pump_peak_price REAL, pump_pct REAL, pump_duration_hours REAL,
  pre_7d_return REAL, pre_14d_return REAL, pre_30d_return REAL,
  pre_7d_avg_volume REAL, pre_1d_volume REAL, volume_ratio REAL, pre_7d_volatility REAL,
  pre_fg_score REAL, pre_fg_zone TEXT, days_in_fear INTEGER,
  drawdown_from_high REAL, recovery_pct_before_pump REAL,
  day_of_week INTEGER, hour_utc INTEGER,
  post_24h_return REAL, post_72h_return REAL, post_7d_return REAL, held_gains INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pump_pct ON pump_events(pump_pct);

CREATE TABLE IF NOT EXISTS pump_characteristics (
  characteristic TEXT PRIMARY KEY, avg_value REAL, median_value REAL,
  min_value REAL, max_value REAL, std_dev REAL, sample_count INTEGER, description TEXT
);
`);

const insertPump = db.prepare(`INSERT OR IGNORE INTO pump_events (event_id,ticker,source,chain,pump_date,pump_start_price,pump_peak_price,pump_pct,pump_duration_hours,pre_7d_return,pre_14d_return,pre_30d_return,pre_7d_avg_volume,pre_1d_volume,volume_ratio,pre_7d_volatility,pre_fg_score,pre_fg_zone,days_in_fear,drawdown_from_high,recovery_pct_before_pump,day_of_week,hour_utc,post_24h_return,post_72h_return,post_7d_return,held_gains) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

console.log('═══ FINDING ALL PUMPS ═══\n');

// Get all tickers that have enough data
const tickers = db.prepare(`SELECT DISTINCT ticker FROM prices GROUP BY ticker HAVING COUNT(*) > 30`).all().map(r => r.ticker);
console.log('Scanning', tickers.length, 'tickers...');

let total = 0;
for (let ti = 0; ti < tickers.length; ti++) {
  const ticker = tickers[ti];
  const prices = db.prepare('SELECT date, open, high, low, close, volume FROM prices WHERE ticker = ? ORDER BY date ASC').all(ticker);
  if (prices.length < 30) continue;

  for (let i = 1; i < prices.length; i++) {
    const today = prices[i], yest = prices[i - 1];
    if (!yest.close || yest.close <= 0) continue;
    const pumpPct = Math.max(
      ((today.high - yest.close) / yest.close) * 100,
      ((today.close - yest.close) / yest.close) * 100
    );
    if (pumpPct < 40) continue;

    const pre7 = prices.slice(Math.max(0, i - 7), i);
    const pre14 = prices.slice(Math.max(0, i - 14), i);
    const pre30 = prices.slice(Math.max(0, i - 30), i);
    if (pre7.length < 3) continue;

    const pre7dRet = pre7.length >= 7 ? ((pre7[pre7.length-1].close - pre7[0].close) / pre7[0].close) * 100 : null;
    const pre14dRet = pre14.length >= 14 ? ((pre14[pre14.length-1].close - pre14[0].close) / pre14[0].close) * 100 : null;
    const pre30dRet = pre30.length >= 20 ? ((pre30[pre30.length-1].close - pre30[0].close) / pre30[0].close) * 100 : null;
    const pre7dAvgVol = pre7.reduce((s, p) => s + (p.volume || 0), 0) / pre7.length;
    const volRatio = pre7dAvgVol > 0 ? (today.volume || 0) / pre7dAvgVol : 0;

    const rets = [];
    for (let j = 1; j < pre7.length; j++) if (pre7[j-1].close > 0) rets.push((pre7[j].close - pre7[j-1].close) / pre7[j-1].close);
    const avgR = rets.length > 0 ? rets.reduce((s, v) => s + v, 0) / rets.length : 0;
    const vol = rets.length > 0 ? Math.sqrt(rets.reduce((s, v) => s + (v - avgR) ** 2, 0) / rets.length) * 100 : 0;

    const recentHigh = Math.max(...pre30.map(p => p.high || p.close));
    const dd = recentHigh > 0 ? ((yest.close - recentHigh) / recentHigh) * 100 : 0;
    const recentLow = Math.min(...pre14.filter(p => p.low > 0).map(p => p.low));
    const recov = recentLow > 0 ? ((yest.close - recentLow) / recentLow) * 100 : 0;

    const fgRow = db.prepare('SELECT fg_score, zone FROM fg_history WHERE ticker = ? AND date <= ? ORDER BY date DESC LIMIT 1').get(ticker, today.date);

    const post1 = prices[i + 1], post3 = prices[i + 3], post7 = prices[i + 7];
    const p24 = post1 ? ((post1.close - today.close) / today.close) * 100 : null;
    const p72 = post3 ? ((post3.close - today.close) / today.close) * 100 : null;
    const p7d = post7 ? ((post7.close - today.close) / today.close) * 100 : null;

    try {
      insertPump.run(`${ticker}_${today.date}`, ticker, 'cex', '', today.date,
        yest.close, today.high, pumpPct, 24,
        pre7dRet, pre14dRet, pre30dRet, pre7dAvgVol, yest.volume || 0, volRatio, vol,
        fgRow?.fg_score || null, fgRow?.zone || null, 0, dd, recov,
        new Date(today.date).getDay(), null, p24, p72, p7d,
        p7d !== null ? (p7d > -20 ? 1 : 0) : null);
      total++;
    } catch {}
  }
  if (ti % 500 === 0) process.stdout.write(`\r  ${ti}/${tickers.length} | ${total} pumps`);
}

console.log(`\n\nTotal pump events: ${total}`);
const bySize = db.prepare("SELECT CASE WHEN pump_pct>=200 THEN '200%+' WHEN pump_pct>=100 THEN '100-200%' WHEN pump_pct>=60 THEN '60-100%' ELSE '40-60%' END as tier, COUNT(*) as n FROM pump_events GROUP BY tier ORDER BY MIN(pump_pct) DESC").all();
for (const b of bySize) console.log('  ' + (b.tier||'?').padEnd(12) + b.n);
db.close();
