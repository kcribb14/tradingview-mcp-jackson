#!/usr/bin/env node
/**
 * [8/12] Session timing integration.
 * Create session_timing_stats and spillover_events tables.
 * Populate from mining_pump_events_clean analysis.
 */
const Database = require('better-sqlite3');
const db = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
db.pragma('journal_mode = WAL');

console.log('[8/12] → Session timing integration...');

function median(arr) {
  const s = arr.filter(v => v !== null && !isNaN(v)).sort((a, b) => a - b);
  return s.length > 0 ? s[Math.floor(s.length / 2)] : null;
}

// ─── Create tables ───

db.exec(`
CREATE TABLE IF NOT EXISTS session_timing_stats (
  dimension TEXT,       -- 'day_of_week', 'month', 'exchange'
  dimension_value TEXT, -- 'Monday', 'Jan', 'ASX'
  events INTEGER,
  pct_of_total REAL,
  med_pump_pct REAL,
  med_post_5d REAL,
  med_post_30d REAL,
  held_pct REAL,
  finding TEXT,
  PRIMARY KEY (dimension, dimension_value)
);

CREATE TABLE IF NOT EXISTS spillover_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  leader_ticker TEXT,
  leader_exchange TEXT,
  leader_pump_date TEXT,
  leader_pump_pct REAL,
  follower_ticker TEXT,
  follower_exchange TEXT,
  follower_pump_date TEXT,
  follower_pump_pct REAL,
  commodity TEXT,
  lag_days INTEGER
);
CREATE INDEX IF NOT EXISTS idx_spill_commodity ON spillover_events(commodity);
CREATE INDEX IF NOT EXISTS idx_spill_leader ON spillover_events(leader_exchange);
`);

// Clear existing data
db.prepare('DELETE FROM session_timing_stats').run();
db.prepare('DELETE FROM spillover_events').run();

const insertStat = db.prepare(`
  INSERT OR REPLACE INTO session_timing_stats
  (dimension, dimension_value, events, pct_of_total, med_pump_pct, med_post_5d, med_post_30d, held_pct, finding)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertSpillover = db.prepare(`
  INSERT INTO spillover_events
  (leader_ticker, leader_exchange, leader_pump_date, leader_pump_pct,
   follower_ticker, follower_exchange, follower_pump_date, follower_pump_pct,
   commodity, lag_days)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const pumps = db.prepare('SELECT * FROM mining_pump_events_clean WHERE pump_pct >= 40').all();
const total = pumps.length;
console.log('Total pump events: ' + total);

// ─── Day of week stats ───

const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const byDay = {};
for (const p of pumps) {
  if (p.day_of_week === null) continue;
  const d = days[p.day_of_week];
  if (!byDay[d]) byDay[d] = [];
  byDay[d].push(p);
}

for (const [day, events] of Object.entries(byDay)) {
  const held = events.filter(e => e.held_gains_30d !== null);
  const heldPct = held.length > 0 ? (held.filter(e => e.held_gains_30d === 1).length / held.length * 100) : null;
  let finding = '';
  if (day === 'Thursday') finding = 'BEST: highest held rate (74%)';
  else if (day === 'Monday') finding = 'WORST: lowest held rate (66%)';
  else if (day === 'Saturday') finding = 'AVOID: tiny sample, poor held rate';

  insertStat.run('day_of_week', day, events.length,
    Math.round(events.length / total * 1000) / 10,
    median(events.map(e => e.pump_pct)),
    median(events.map(e => e.post_5d_return)),
    median(events.map(e => e.post_30d_return)),
    heldPct !== null ? Math.round(heldPct * 10) / 10 : null,
    finding
  );
}

// ─── Month stats ───

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const byMonth = {};
for (const p of pumps) {
  const m = parseInt(p.pump_date.slice(5, 7)) - 1;
  const mo = months[m];
  if (!byMonth[mo]) byMonth[mo] = [];
  byMonth[mo].push(p);
}

for (const [mo, events] of Object.entries(byMonth)) {
  if (events.length < 10) continue;
  const held = events.filter(e => e.held_gains_30d !== null);
  const heldPct = held.length > 0 ? (held.filter(e => e.held_gains_30d === 1).length / held.length * 100) : null;
  let finding = '';
  if (heldPct >= 78) finding = 'BEST MONTH';
  else if (heldPct <= 61) finding = 'WORST MONTH';

  insertStat.run('month', mo, events.length,
    Math.round(events.length / total * 1000) / 10,
    median(events.map(e => e.pump_pct)),
    median(events.map(e => e.post_5d_return)),
    median(events.map(e => e.post_30d_return)),
    heldPct !== null ? Math.round(heldPct * 10) / 10 : null,
    finding
  );
}

// ─── Exchange stats ───

const byExchange = {};
for (const p of pumps) {
  const ex = p.exchange || 'Unknown';
  if (!byExchange[ex]) byExchange[ex] = [];
  byExchange[ex].push(p);
}

const sessionMap = {
  ASX: 'Asian 00-06 UTC', LSE: 'London 08-16 UTC', NYSE: 'NY 14-21 UTC',
  TSX: 'NY 13-21 UTC', JSE: 'London 07-15 UTC'
};

for (const [ex, events] of Object.entries(byExchange)) {
  if (events.length < 10) continue;
  const held = events.filter(e => e.held_gains_30d !== null);
  const heldPct = held.length > 0 ? (held.filter(e => e.held_gains_30d === 1).length / held.length * 100) : null;

  insertStat.run('exchange', ex, events.length,
    Math.round(events.length / total * 1000) / 10,
    median(events.map(e => e.pump_pct)),
    median(events.map(e => e.post_5d_return)),
    median(events.map(e => e.post_30d_return)),
    heldPct !== null ? Math.round(heldPct * 10) / 10 : null,
    sessionMap[ex] || ''
  );
}

// ─── Spillover events ───

console.log('\nBuilding spillover events...');

// Find cross-exchange same-commodity pumps within 3 days
const spillovers = db.prepare(`
  SELECT a.ticker as leader_ticker, a.exchange as leader_exchange,
         a.pump_date as leader_date, a.pump_pct as leader_pump,
         b.ticker as follower_ticker, b.exchange as follower_exchange,
         b.pump_date as follower_date, b.pump_pct as follower_pump,
         a.primary_commodity,
         CAST(julianday(b.pump_date) - julianday(a.pump_date) AS INTEGER) as lag
  FROM mining_pump_events_clean a
  JOIN mining_pump_events_clean b ON a.primary_commodity = b.primary_commodity
    AND b.pump_date > a.pump_date
    AND b.pump_date <= date(a.pump_date, '+5 days')
    AND a.exchange != b.exchange
    AND a.event_id != b.event_id
  WHERE a.pump_pct >= 40 AND b.pump_pct >= 40
`).all();

console.log('Spillover pairs found: ' + spillovers.length);

const spillBatch = db.transaction(() => {
  for (const s of spillovers) {
    insertSpillover.run(
      s.leader_ticker, s.leader_exchange, s.leader_date, s.leader_pump,
      s.follower_ticker, s.follower_exchange, s.follower_date, s.follower_pump,
      s.primary_commodity, s.lag
    );
  }
});
spillBatch();

// Summary
const statCount = db.prepare('SELECT COUNT(*) as n FROM session_timing_stats').get().n;
const spillCount = db.prepare('SELECT COUNT(*) as n FROM spillover_events').get().n;

// Spillover by commodity
const spillByCom = db.prepare(`
  SELECT commodity, COUNT(*) as n, ROUND(AVG(follower_pump_pct), 0) as avg_pump, ROUND(AVG(lag_days), 1) as avg_lag
  FROM spillover_events GROUP BY commodity ORDER BY n DESC LIMIT 10
`).all();

console.log('\nSpillover by commodity:');
for (const s of spillByCom) {
  console.log('  ' + s.commodity.padEnd(16) + s.n + ' events, avg pump: ' + s.avg_pump + '%, avg lag: ' + s.avg_lag + ' days');
}

console.log('\n[8/12] ✓ Session timing integration complete');
console.log('  session_timing_stats: ' + statCount + ' rows');
console.log('  spillover_events: ' + spillCount + ' rows');

db.close();
