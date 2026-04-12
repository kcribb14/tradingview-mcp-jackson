#!/usr/bin/env node
/**
 * AI Outcome Tracker — measures accuracy of Gemma screening predictions.
 * Checks ai_screening_results from 7+ and 30+ days ago against actual price movement.
 */
const Database = require('better-sqlite3');
const db = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
db.pragma('journal_mode = WAL');

console.log('═══ AI OUTCOME TRACKER ═══\n');

db.exec(`
CREATE TABLE IF NOT EXISTS ai_screening_outcomes (
  scan_date TEXT,
  ticker TEXT,
  predicted_action TEXT,
  predicted_confidence REAL,
  actual_7d_return REAL,
  actual_30d_return REAL,
  held_gains INTEGER,
  outcome_date TEXT,
  PRIMARY KEY (scan_date, ticker)
);
`);

const today = new Date().toISOString().split('T')[0];

// ─── Find screenings needing outcome tracking ───

// 7-day outcomes: screenings from 7+ days ago without outcomes
const need7d = db.prepare(`
  SELECT s.scan_date, s.ticker, s.action, s.confidence, s.archetype
  FROM ai_screening_results s
  LEFT JOIN ai_screening_outcomes o ON s.scan_date = o.scan_date AND s.ticker = o.ticker
  WHERE o.scan_date IS NULL
    AND s.scan_date <= date('now', '-7 days')
`).all();

console.log('Screenings needing 7d outcome: ' + need7d.length);

const insertOutcome = db.prepare(`
  INSERT OR REPLACE INTO ai_screening_outcomes
  (scan_date, ticker, predicted_action, predicted_confidence, actual_7d_return, actual_30d_return, held_gains, outcome_date)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

let tracked = 0;

for (const s of need7d) {
  // Get price at screening date
  const priceAtScan = db.prepare(
    'SELECT close FROM prices WHERE ticker = ? AND date <= ? ORDER BY date DESC LIMIT 1'
  ).get(s.ticker, s.scan_date);

  if (!priceAtScan) continue;

  // Get price 7 days after screening
  const price7d = db.prepare(
    'SELECT close FROM prices WHERE ticker = ? AND date >= date(?, "+7 days") ORDER BY date ASC LIMIT 1'
  ).get(s.ticker, s.scan_date);

  // Get price 30 days after screening (if available)
  const price30d = db.prepare(
    'SELECT close FROM prices WHERE ticker = ? AND date >= date(?, "+30 days") ORDER BY date ASC LIMIT 1'
  ).get(s.ticker, s.scan_date);

  const ret7d = price7d && priceAtScan.close > 0
    ? Math.round(((price7d.close - priceAtScan.close) / priceAtScan.close) * 10000) / 100
    : null;

  const ret30d = price30d && priceAtScan.close > 0
    ? Math.round(((price30d.close - priceAtScan.close) / priceAtScan.close) * 10000) / 100
    : null;

  // "Held gains" = gained 20%+ and still positive at 30d
  const held = ret30d !== null && ret7d !== null && ret7d >= 20 && ret30d > 0 ? 1 : (ret30d !== null ? 0 : null);

  insertOutcome.run(s.scan_date, s.ticker, s.action, s.confidence, ret7d, ret30d, held, today);
  tracked++;
}

console.log('Tracked: ' + tracked + '\n');

// ─── Accuracy report ───

const outcomes = db.prepare('SELECT * FROM ai_screening_outcomes WHERE actual_7d_return IS NOT NULL').all();

if (outcomes.length > 0) {
  console.log('═══ ACCURACY REPORT ═══\n');

  // By predicted action
  for (const action of ['alert', 'watch', 'avoid']) {
    const group = outcomes.filter(o => o.predicted_action === action);
    if (group.length === 0) continue;

    const avg7d = Math.round(group.reduce((s, o) => s + (o.actual_7d_return || 0), 0) / group.length * 10) / 10;
    const pumped = group.filter(o => (o.actual_7d_return || 0) >= 20).length;
    const positive = group.filter(o => (o.actual_7d_return || 0) > 0).length;

    console.log('  ' + action.toUpperCase().padEnd(8) + group.length + ' picks');
    console.log('    Avg 7d return: ' + (avg7d > 0 ? '+' : '') + avg7d + '%');
    console.log('    Pumped 20%+: ' + pumped + '/' + group.length + ' (' + Math.round(pumped / group.length * 100) + '%)');
    console.log('    Positive: ' + positive + '/' + group.length + ' (' + Math.round(positive / group.length * 100) + '%)');
    console.log('');
  }

  // Overall accuracy
  const alertPicks = outcomes.filter(o => o.predicted_action === 'alert');
  const avoidPicks = outcomes.filter(o => o.predicted_action === 'avoid');

  if (alertPicks.length >= 3 && avoidPicks.length >= 3) {
    const alertAvg = alertPicks.reduce((s, o) => s + (o.actual_7d_return || 0), 0) / alertPicks.length;
    const avoidAvg = avoidPicks.reduce((s, o) => s + (o.actual_7d_return || 0), 0) / avoidPicks.length;
    const spread = alertAvg - avoidAvg;
    console.log('  SPREAD (alert vs avoid): ' + (spread > 0 ? '+' : '') + spread.toFixed(1) + '% — ' +
      (spread > 5 ? 'AI ADDS VALUE' : spread > 0 ? 'marginal' : 'AI NOT HELPING'));
  }

  // High confidence accuracy
  const highConf = outcomes.filter(o => o.predicted_confidence >= 70);
  if (highConf.length > 0) {
    const hcPumped = highConf.filter(o => (o.actual_7d_return || 0) >= 20).length;
    console.log('  HIGH CONFIDENCE (70%+): ' + hcPumped + '/' + highConf.length + ' pumped (' + Math.round(hcPumped / highConf.length * 100) + '%)');
  }
} else {
  console.log('No outcomes tracked yet — need 7+ days of screening history.');
  console.log('First results will appear after: ' + new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0]);
}

db.close();
