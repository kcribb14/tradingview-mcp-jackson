const Database = require('better-sqlite3');
const DB = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
const today = new Date().toISOString().split('T')[0];

const insertSignal = DB.prepare(`INSERT OR REPLACE INTO cascade_signals (signal_id, group_name, leader_ticker, leader_move_pct, leader_move_date, follower_ticker, expected_lag_days, expected_follower_move, hit_rate, signal_strength, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

function generate() {
  console.log('Cascade signal generator\n');
  const groups = DB.prepare('SELECT DISTINCT group_name FROM asset_groups').all().map(r => r.group_name);
  let signalCount = 0;

  for (const group of groups) {
    const leaders = DB.prepare(`SELECT ticker FROM asset_groups WHERE group_name = ? AND position = (SELECT MIN(position) FROM asset_groups WHERE group_name = ?)`).all(group, group).map(r => r.ticker);

    for (const leader of leaders) {
      const recent = DB.prepare(`SELECT date_or_ts as date, return_pct FROM returns WHERE ticker = ? AND timeframe = 'D' ORDER BY date_or_ts DESC LIMIT 10`).all(leader);
      if (recent.length < 3) continue;

      // Check 1d, 3d, 5d moves
      const moves = {};
      for (const w of [1, 3, 5]) {
        const slice = recent.slice(0, w);
        moves[w] = slice.reduce((acc, r) => acc * (1 + r.return_pct), 1) - 1;
      }

      const sig = Object.entries(moves).find(([, v]) => Math.abs(v) > 0.02);
      if (!sig) continue;
      const [moveWindow, moveSize] = sig;

      const followers = DB.prepare(`SELECT ticker FROM asset_groups WHERE group_name = ? AND ticker != ?`).all(group, leader).map(r => r.ticker);

      for (const follower of followers) {
        // Get all lag relationships, pick the one with best hit rate among lags > 0
        const lags = DB.prepare(`SELECT lag_days, correlation, hit_rate, avg_follower_move FROM lag_correlations WHERE ticker_leader = ? AND ticker_follower = ? AND lag_days > 0 ORDER BY hit_rate DESC`).all(leader, follower);
        const peak = lags[0];
        if (!peak || peak.hit_rate < 0.50 || Math.abs(peak.correlation) < 0.05) continue;

        const leaderMoveDate = recent[Math.min(parseInt(moveWindow) - 1, recent.length - 1)]?.date;
        const daysSince = Math.floor((Date.now() - new Date(leaderMoveDate).getTime()) / 86400000);
        if (daysSince > peak.lag_days + 2) continue;

        // Check if follower already caught up
        const fRec = DB.prepare(`SELECT return_pct FROM returns WHERE ticker = ? AND timeframe = 'D' AND date_or_ts >= ? ORDER BY date_or_ts`).all(follower, leaderMoveDate);
        const fMove = fRec.reduce((acc, r) => acc * (1 + r.return_pct), 1) - 1;
        const expected = (peak.avg_follower_move || 0) * (moveSize / 0.02);
        const remaining = expected - fMove;
        if (Math.abs(remaining) < 0.003) continue;

        const lagRem = Math.max(0.1, (peak.lag_days - daysSince) / peak.lag_days);
        const strength = Math.abs(peak.correlation) * peak.hit_rate * lagRem;

        const sigId = `${group}_${leader}_${follower}_${today}`;
        insertSignal.run(sigId, group, leader, moveSize, leaderMoveDate, follower, Math.max(1, peak.lag_days - daysSince), remaining, peak.hit_rate, strength, 'active');
        const dir = remaining > 0 ? '🟢' : '🔴';
        console.log(`  ${dir} ${group.padEnd(20)} ${leader.padEnd(10)} ${(moveSize*100).toFixed(1)}% -> ${follower.padEnd(10)} exp ${(remaining*100).toFixed(1)}% in ${peak.lag_days-daysSince}d (hit ${(peak.hit_rate*100).toFixed(0)}%, str ${strength.toFixed(2)})`);
        signalCount++;
      }
    }
  }
  console.log(`\n${signalCount} active signals`);
  DB.close();
}
generate();
