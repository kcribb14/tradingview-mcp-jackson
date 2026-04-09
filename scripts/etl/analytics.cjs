const Database = require('better-sqlite3');
const DB = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
DB.pragma('journal_mode = WAL');

const insertReturn = DB.prepare('INSERT OR IGNORE INTO returns (ticker, date_or_ts, timeframe, return_pct, log_return) VALUES (?, ?, ?, ?, ?)');
const insertCorr = DB.prepare('INSERT OR IGNORE INTO correlations (ticker_a, ticker_b, date, timeframe, window_size, correlation, sample_size) VALUES (?, ?, ?, ?, ?, ?, ?)');
const insertPerf = DB.prepare('INSERT OR REPLACE INTO performance_stats (ticker, as_of_date, timeframe, lookback_days, total_return, ann_return, ann_vol, sharpe, max_drawdown, win_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');

function pearson(a, b) {
  const n = a.length;
  if (n < 5) return null;
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; saa += a[i] * a[i]; sbb += b[i] * b[i]; sab += a[i] * b[i]; }
  const den = Math.sqrt((n * saa - sa * sa) * (n * sbb - sb * sb));
  return den === 0 ? null : (n * sab - sa * sb) / den;
}

// 1. Daily returns
function computeDailyReturns() {
  console.log('Computing daily returns...');
  const tickers = DB.prepare('SELECT DISTINCT ticker FROM prices').all().map(r => r.ticker);
  let total = 0;
  for (let i = 0; i < tickers.length; i++) {
    const bars = DB.prepare('SELECT date, close FROM prices WHERE ticker = ? AND close > 0 ORDER BY date ASC').all(tickers[i]);
    if (bars.length < 2) continue;
    const tx = DB.transaction(() => {
      for (let j = 1; j < bars.length; j++) {
        const ret = bars[j].close / bars[j - 1].close - 1;
        if (isFinite(ret) && Math.abs(ret) < 1) { // Filter >100% moves as data errors
          insertReturn.run(tickers[i], bars[j].date, 'D', ret, Math.log(1 + ret));
          total++;
        }
      }
    });
    tx();
    if (i % 500 === 0) process.stdout.write(`\r  ${i + 1}/${tickers.length} | ${total.toLocaleString()} returns`);
  }
  console.log(`\n  Daily returns: ${total.toLocaleString()}`);
}

// 2. 1h returns
function computeHourlyReturns() {
  console.log('Computing 1h returns...');
  const tickers = DB.prepare('SELECT DISTINCT ticker FROM prices_1h').all().map(r => r.ticker);
  let total = 0;
  for (let i = 0; i < tickers.length; i++) {
    const bars = DB.prepare('SELECT ts, close FROM prices_1h WHERE ticker = ? AND close > 0 ORDER BY ts ASC').all(tickers[i]);
    if (bars.length < 2) continue;
    const tx = DB.transaction(() => {
      for (let j = 1; j < bars.length; j++) {
        const ret = bars[j].close / bars[j - 1].close - 1;
        if (isFinite(ret) && Math.abs(ret) < 0.5) {
          insertReturn.run(tickers[i], String(bars[j].ts), '1h', ret, Math.log(1 + ret));
          total++;
        }
      }
    });
    tx();
    if (i % 10 === 0) process.stdout.write(`\r  ${i + 1}/${tickers.length} | ${total.toLocaleString()}`);
  }
  console.log(`\n  1h returns: ${total.toLocaleString()}`);
}

// 3. Performance stats
function computePerformanceStats() {
  console.log('Computing performance stats...');
  const tickers = DB.prepare("SELECT DISTINCT ticker FROM returns WHERE timeframe = 'D'").all().map(r => r.ticker);
  const today = new Date().toISOString().split('T')[0];
  let count = 0;
  for (const t of tickers) {
    for (const days of [90, 180, 365]) {
      const cutoff = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
      const rows = DB.prepare("SELECT return_pct FROM returns WHERE ticker = ? AND timeframe = 'D' AND date_or_ts >= ? ORDER BY date_or_ts").all(t, cutoff);
      if (rows.length < 20) continue;
      const rets = rows.map(r => r.return_pct);
      const totalRet = rets.reduce((acc, r) => acc * (1 + r), 1) - 1;
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
      const annVol = Math.sqrt(variance * 252);
      const annRet = Math.pow(1 + totalRet, 252 / rets.length) - 1;
      const sharpe = annVol > 0 ? (annRet - 0.04) / annVol : 0;
      let peak = 1, eq = 1, maxDD = 0;
      for (const r of rets) { eq *= (1 + r); if (eq > peak) peak = eq; const dd = (eq - peak) / peak; if (dd < maxDD) maxDD = dd; }
      const wr = rets.filter(r => r > 0).length / rets.length;
      insertPerf.run(t, today, 'D', days, totalRet, annRet, annVol, sharpe, maxDD, wr);
      count++;
    }
  }
  console.log('  Performance stats:', count);
}

// 4. Rolling correlations — CRITICAL: join on matching dates
function computeCorrelations() {
  console.log('Computing rolling correlations...');
  const pairs = [
    ['BTC', 'ETH'], ['BTC', 'SOL'], ['ETH', 'SOL'],
    ['AAPL', 'MSFT'], ['AAPL', 'NVDA'], ['MSFT', 'NVDA'],
    ['BHP.AX', 'RIO.AX'], ['BHP.AX', 'FMG.AX'], ['RIO.AX', 'FMG.AX'],
    ['AUDUSD=X', 'EURUSD=X'], ['AUDUSD=X', 'USDJPY=X'], ['EURUSD=X', 'USDJPY=X'],
    ['BTC', 'SPY'], ['BTC', 'GLD'], ['SPY', 'QQQ'], ['SPY', 'GLD'], ['SPY', 'IWM'],
  ];
  const today = new Date().toISOString().split('T')[0];
  let count = 0;

  for (const [a, b] of pairs) {
    // JOIN on date — this is the fix for the alignment bug
    const aligned = DB.prepare(`
      SELECT ra.date_or_ts as date, ra.return_pct as ra, rb.return_pct as rb
      FROM returns ra JOIN returns rb ON ra.date_or_ts = rb.date_or_ts AND ra.timeframe = rb.timeframe
      WHERE ra.ticker = ? AND rb.ticker = ? AND ra.timeframe = 'D'
      ORDER BY ra.date_or_ts ASC
    `).all(a, b);

    if (aligned.length < 30) { console.log(`  ${a}/${b}: ${aligned.length} aligned bars — skipping`); continue; }

    // Rolling 30-day
    for (let i = 30; i < aligned.length; i++) {
      const slice = aligned.slice(i - 30, i);
      const corr = pearson(slice.map(r => r.ra), slice.map(r => r.rb));
      if (corr != null) { insertCorr.run(a, b, aligned[i - 1].date, 'D', 30, Math.round(corr * 1000) / 1000, 30); count++; }
    }

    // Full-period
    const full = pearson(aligned.map(r => r.ra), aligned.map(r => r.rb));
    if (full != null) { insertCorr.run(a, b, today, 'D', aligned.length, Math.round(full * 1000) / 1000, aligned.length); count++; }
    console.log(`  ${a.padEnd(10)} / ${b.padEnd(10)} ${aligned.length} bars, corr: ${full?.toFixed(3)}`);
  }
  console.log('  Correlation rows:', count);
}

const start = Date.now();
computeDailyReturns();
computeHourlyReturns();
computePerformanceStats();
computeCorrelations();
console.log(`\nAnalytics ETL done in ${((Date.now() - start) / 60000).toFixed(1)} min`);
DB.close();
