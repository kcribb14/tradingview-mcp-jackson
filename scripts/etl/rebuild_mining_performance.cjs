#!/usr/bin/env node
/**
 * [4/12] Rebuild mining_performance for ALL 514 miners.
 * Previously only 328 had data. Now includes miners with new F&G scores.
 */
const Database = require('better-sqlite3');
const db = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
db.pragma('journal_mode = WAL');
db.pragma('synchronous = normal');

console.log('[4/12] → Rebuild mining performance...');

const miners = db.prepare(`
  SELECT mc.ticker, mc.name, mc.exchange, mc.primary_commodity, mc.stage
  FROM mining_companies mc
`).all();

console.log('Total miners: ' + miners.length);

const upsert = db.prepare(`
  INSERT OR REPLACE INTO mining_performance
  (ticker, name, exchange, primary_commodity, stage, first_date, last_date, total_bars,
   total_return_pct, annualized_return_pct, ytd_return_pct, return_1y_pct, return_3y_pct,
   return_5y_pct, return_10y_pct, max_drawdown_pct, volatility_annual, sharpe_ratio,
   all_time_high, all_time_high_date, all_time_low, all_time_low_date,
   current_price, pct_from_ath, current_fg, avg_fg_1y, commodity_correlation, market_cap_aud)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

let processed = 0, inserted = 0, skipped = 0;

for (const m of miners) {
  try {
    const bars = db.prepare(
      'SELECT date, open, high, low, close, volume FROM prices WHERE ticker = ? AND close > 0 ORDER BY date ASC'
    ).all(m.ticker);

    if (bars.length < 20) { skipped++; continue; }

    const firstDate = bars[0].date;
    const lastDate = bars[bars.length - 1].date;
    const firstClose = bars[0].close;
    const lastClose = bars[bars.length - 1].close;

    // Total return
    const totalReturn = firstClose > 0 ? ((lastClose - firstClose) / firstClose) * 100 : 0;

    // Annualized
    const years = bars.length / 252;
    const annualized = years > 0.5 ? (Math.pow(lastClose / firstClose, 1 / years) - 1) * 100 : totalReturn;

    // YTD
    const ytdStart = bars.find(b => b.date >= new Date().getFullYear() + '-01-01');
    const ytdReturn = ytdStart && ytdStart.close > 0 ? ((lastClose - ytdStart.close) / ytdStart.close) * 100 : null;

    // Period returns (1Y, 3Y, 5Y, 10Y)
    function periodReturn(days) {
      const idx = Math.max(0, bars.length - days);
      const ref = bars[idx].close;
      return ref > 0 ? ((lastClose - ref) / ref) * 100 : null;
    }
    const ret1y = bars.length > 252 ? periodReturn(252) : null;
    const ret3y = bars.length > 756 ? periodReturn(756) : null;
    const ret5y = bars.length > 1260 ? periodReturn(1260) : null;
    const ret10y = bars.length > 2520 ? periodReturn(2520) : null;

    // Max drawdown
    let peak = bars[0].high;
    let maxDD = 0;
    for (const b of bars) {
      if (b.high > peak) peak = b.high;
      const dd = peak > 0 ? ((b.low - peak) / peak) * 100 : 0;
      if (dd < maxDD) maxDD = dd;
    }

    // Volatility (annualized from daily returns)
    const returns = [];
    for (let i = 1; i < bars.length; i++) {
      if (bars[i - 1].close > 0) {
        returns.push((bars[i].close - bars[i - 1].close) / bars[i - 1].close);
      }
    }
    const avgRet = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
    const variance = returns.length > 1 ? returns.reduce((s, r) => s + (r - avgRet) ** 2, 0) / (returns.length - 1) : 0;
    const dailyVol = Math.sqrt(variance);
    const annualVol = dailyVol * Math.sqrt(252) * 100;

    // Sharpe (assuming 4% risk-free)
    const sharpe = annualVol > 0 ? ((annualized - 4) / annualVol) : 0;

    // ATH/ATL
    let ath = 0, athDate = '', atl = Infinity, atlDate = '';
    for (const b of bars) {
      if (b.high > ath) { ath = b.high; athDate = b.date; }
      if (b.low > 0 && b.low < atl) { atl = b.low; atlDate = b.date; }
    }
    const pctFromATH = ath > 0 ? ((lastClose - ath) / ath) * 100 : 0;

    // Current F&G
    const fg = db.prepare('SELECT fg_score FROM fg_history WHERE ticker = ? ORDER BY date DESC LIMIT 1').get(m.ticker);
    const currentFG = fg?.fg_score || null;

    // Avg F&G over 1 year
    const avgFG = db.prepare(
      "SELECT AVG(fg_score) as avg FROM fg_history WHERE ticker = ? AND date >= date('now', '-365 days')"
    ).get(m.ticker);
    const avgFG1y = avgFG?.avg || null;

    // Commodity correlation (simplified — correlation of daily returns with commodity returns)
    let commCorr = null;
    if (m.primary_commodity) {
      const commReturns = db.prepare(`
        SELECT date,
               (price_usd - LAG(price_usd) OVER (ORDER BY date)) / NULLIF(LAG(price_usd) OVER (ORDER BY date), 0) as ret
        FROM commodity_prices WHERE commodity = ? AND date >= date('now', '-365 days')
        ORDER BY date
      `).all(m.primary_commodity);

      if (commReturns.length > 50) {
        // Build date-aligned return pairs
        const commMap = new Map(commReturns.filter(r => r.ret !== null).map(r => [r.date, r.ret]));
        const stockReturns = [];
        const commAligned = [];
        for (let i = 1; i < bars.length; i++) {
          const cr = commMap.get(bars[i].date);
          if (cr !== undefined && bars[i - 1].close > 0) {
            stockReturns.push((bars[i].close - bars[i - 1].close) / bars[i - 1].close);
            commAligned.push(cr);
          }
        }
        if (stockReturns.length > 20) {
          const n = stockReturns.length;
          const avgS = stockReturns.reduce((s, v) => s + v, 0) / n;
          const avgC = commAligned.reduce((s, v) => s + v, 0) / n;
          let cov = 0, varS = 0, varC = 0;
          for (let i = 0; i < n; i++) {
            cov += (stockReturns[i] - avgS) * (commAligned[i] - avgC);
            varS += (stockReturns[i] - avgS) ** 2;
            varC += (commAligned[i] - avgC) ** 2;
          }
          const denom = Math.sqrt(varS * varC);
          commCorr = denom > 0 ? Math.round(cov / denom * 1000) / 1000 : null;
        }
      }
    }

    upsert.run(
      m.ticker, m.name, m.exchange, m.primary_commodity, m.stage,
      firstDate, lastDate, bars.length,
      Math.round(totalReturn * 100) / 100,
      Math.round(annualized * 100) / 100,
      ytdReturn !== null ? Math.round(ytdReturn * 100) / 100 : null,
      ret1y !== null ? Math.round(ret1y * 100) / 100 : null,
      ret3y !== null ? Math.round(ret3y * 100) / 100 : null,
      ret5y !== null ? Math.round(ret5y * 100) / 100 : null,
      ret10y !== null ? Math.round(ret10y * 100) / 100 : null,
      Math.round(maxDD * 100) / 100,
      Math.round(annualVol * 100) / 100,
      Math.round(sharpe * 1000) / 1000,
      Math.round(ath * 10000) / 10000, athDate,
      Math.round(atl * 10000) / 10000, atlDate,
      Math.round(lastClose * 10000) / 10000,
      Math.round(pctFromATH * 100) / 100,
      currentFG, avgFG1y !== null ? Math.round(avgFG1y * 100) / 100 : null,
      commCorr, null // market_cap_aud — no reliable source
    );

    inserted++;
  } catch (e) {
    if (skipped < 3) console.log('  Error: ' + m.ticker + ' — ' + e.message);
    skipped++;
  }

  processed++;
  if (processed % 50 === 0) {
    process.stdout.write('\r  Progress: ' + processed + '/' + miners.length + ' | Inserted: ' + inserted + ' | Skipped: ' + skipped);
  }
}

console.log('\r  Progress: ' + processed + '/' + miners.length + ' | Inserted: ' + inserted + ' | Skipped: ' + skipped);
console.log('\n[4/12] ✓ Mining performance rebuilt');
console.log('  Before: 328 miners');
console.log('  After: ' + db.prepare('SELECT COUNT(*) as n FROM mining_performance').get().n + ' miners');

db.close();
