#!/usr/bin/env node
/**
 * Accuracy backtest — did high-scored miners actually pump?
 * Simulates scanner scoring on the day BEFORE each historical pump event,
 * then measures correlation between pre-pump score and pump quality.
 */
const Database = require('better-sqlite3');
const db = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db', { readonly: true });

function median(arr) {
  const s = arr.filter(v => v !== null && !isNaN(v)).sort((a, b) => a - b);
  return s.length > 0 ? s[Math.floor(s.length / 2)] : null;
}

console.log('═══ ACCURACY BACKTEST — Did high-score miners pump? ═══\n');

// Get pump events with pre-pump metrics
const pumps = db.prepare(`
  SELECT ticker, pump_date, pump_pct, drawdown_from_high, pre_fg_score, volume_ratio,
         pre_7d_return, pre_14d_return, pre_30d_return, pre_7d_volatility,
         commodity_trend, commodity_30d_return, stock_commodity_divergence,
         held_gains_30d, post_1d_return, post_5d_return, post_10d_return, post_30d_return,
         primary_commodity, stage, exchange
  FROM mining_pump_events_clean
  WHERE pump_pct >= 40
`).all();

console.log('Total historical pump events: ' + pumps.length);

// Simulate scanner score for each pump
function simulateScore(p) {
  let score = 0;

  // Drawdown depth
  if (p.drawdown_from_high !== null) {
    if (p.drawdown_from_high < -30) score += 15;
    else if (p.drawdown_from_high < -20) score += 10;
  }

  // F&G sweet spot
  if (p.pre_fg_score !== null) {
    if (p.pre_fg_score >= -15 && p.pre_fg_score <= -5) score += 20;
    else if (p.pre_fg_score >= -25 && p.pre_fg_score < -15) score += 12;
    else if (p.pre_fg_score < -25) score += 5;
  }

  // Archetype bonus (approximate from available data)
  let archetype = 'NONE';
  if (p.volume_ratio >= 3) { score += 15; archetype = 'VOLUME_EXPLOSION'; score += 21; } // 70% held * 0.3
  if (p.commodity_30d_return > 3 && p.pre_30d_return < 0) { score += 12; if (archetype === 'NONE') { archetype = 'CATCH_UP'; score += 22; } }
  if (p.pre_7d_volatility !== null && p.pre_7d_volatility < 3 && p.volume_ratio >= 2) { if (archetype === 'NONE') { archetype = 'FLAT_BREAKOUT'; score += 23; } }
  if (p.drawdown_from_high < -60 && p.pre_30d_return < -30) { if (archetype === 'NONE') { archetype = 'DEAD_CAT'; score += 21; } }
  if (p.pre_7d_return > 5) { score += 5; if (archetype === 'NONE') { archetype = 'MOMENTUM'; score += 20; } }
  if (p.drawdown_from_high < -25 && p.pre_fg_score > -20 && p.pre_fg_score < -5 && p.volume_ratio < 2) {
    if (archetype === 'NONE') { archetype = 'QUIET_ACCUM'; score += 20; }
  }
  if (p.pre_fg_score < -30) { score -= 10; if (archetype === 'NONE') archetype = 'EXTREME_FEAR'; }

  // Stage/exchange adjustment
  if (p.stage && p.stage.includes('Producer')) score += 5;
  if (p.stage && (p.stage === 'Explorer' || p.stage === 'Shell')) score -= 10;
  if (p.exchange === 'ASX' || p.exchange === 'JSE') score += 3;
  if (p.exchange === 'NYSE') score -= 5;

  // Commodity falling
  if (p.commodity_trend === 'falling') score -= 8;

  return { score: Math.max(0, Math.min(100, score)), archetype };
}

const scored = pumps.map(p => {
  const { score, archetype } = simulateScore(p);
  return { ...p, sim_score: score, sim_arch: archetype };
});

const withScores = scored.filter(p => p.sim_score > 0);
console.log('Events with computable scores: ' + withScores.length + '\n');

// ── Distribution of scores on pre-pump day ──

console.log('▸ PRE-PUMP SCORE DISTRIBUTION:\n');
console.log('Score bucket'.padEnd(18) + 'Events'.padStart(8) + '% pumps'.padStart(9) + 'Med pump'.padStart(10) + 'Med post5d'.padStart(11) + 'Held30d%'.padStart(9));
console.log('─'.repeat(65));

const buckets = [
  { label: '70-100 (high)', min: 70, max: 101 },
  { label: '50-70 (medium)', min: 50, max: 70 },
  { label: '30-50 (low)', min: 30, max: 50 },
  { label: '0-30 (very low)', min: 0, max: 30 },
];

for (const b of buckets) {
  const inBucket = withScores.filter(p => p.sim_score >= b.min && p.sim_score < b.max);
  if (inBucket.length === 0) continue;
  const held = inBucket.filter(p => p.held_gains_30d !== null);
  const heldPct = held.length > 0 ? (held.filter(p => p.held_gains_30d === 1).length / held.length * 100).toFixed(0) : '?';
  const post5d = inBucket.map(p => p.post_5d_return).filter(v => v !== null);
  console.log(
    b.label.padEnd(18) + String(inBucket.length).padStart(8) +
    ((inBucket.length / withScores.length * 100).toFixed(1) + '%').padStart(9) +
    ((median(inBucket.map(p => p.pump_pct)) || 0).toFixed(0) + '%').padStart(10) +
    ((median(post5d) || 0).toFixed(0) + '%').padStart(11) +
    (heldPct + '%').padStart(9)
  );
}

// ── By archetype ──

console.log('\n▸ BY SIMULATED ARCHETYPE:\n');
console.log('Archetype'.padEnd(22) + 'Events'.padStart(7) + 'Med Score'.padStart(10) + 'Med Pump'.padStart(10) + 'Held%'.padStart(7) + 'Med Post5d'.padStart(11));
console.log('─'.repeat(67));

const byArch = {};
for (const p of withScores) {
  if (p.sim_arch === 'NONE') continue;
  if (!byArch[p.sim_arch]) byArch[p.sim_arch] = [];
  byArch[p.sim_arch].push(p);
}

for (const [arch, events] of Object.entries(byArch).sort((a, b) => b[1].length - a[1].length)) {
  const held = events.filter(p => p.held_gains_30d !== null);
  const heldPct = held.length > 0 ? (held.filter(p => p.held_gains_30d === 1).length / held.length * 100).toFixed(0) : '?';
  const post5d = events.map(p => p.post_5d_return).filter(v => v !== null);
  console.log(
    arch.padEnd(22) + String(events.length).padStart(7) +
    ((median(events.map(p => p.sim_score)) || 0).toFixed(0)).padStart(10) +
    ((median(events.map(p => p.pump_pct)) || 0).toFixed(0) + '%').padStart(10) +
    (heldPct + '%').padStart(7) +
    ((median(post5d) || 0).toFixed(0) + '%').padStart(11)
  );
}

// ── KEY METRICS ──

console.log('\n▸ KEY METRICS:\n');
const high = withScores.filter(p => p.sim_score >= 50);
const low = withScores.filter(p => p.sim_score < 50);

console.log('  Score 50+ events: ' + high.length + '/' + withScores.length + ' (' + (high.length / withScores.length * 100).toFixed(0) + '% of pumps had high pre-score)');

if (high.length > 0 && low.length > 0) {
  const highHeld = high.filter(p => p.held_gains_30d !== null);
  const lowHeld = low.filter(p => p.held_gains_30d !== null);
  const highRate = highHeld.length > 0 ? (highHeld.filter(p => p.held_gains_30d === 1).length / highHeld.length * 100) : 0;
  const lowRate = lowHeld.length > 0 ? (lowHeld.filter(p => p.held_gains_30d === 1).length / lowHeld.length * 100) : 0;
  console.log('  High-score held rate: ' + highRate.toFixed(0) + '% vs Low-score: ' + lowRate.toFixed(0) + '%');
  console.log('  Spread: ' + (highRate - lowRate).toFixed(0) + '% — ' + (highRate - lowRate > 5 ? 'SCORE ADDS VALUE' : highRate - lowRate > 0 ? 'marginal' : 'SCORE NOT PREDICTIVE'));
}

// ── Forward return by score bucket ──

console.log('\n▸ FORWARD RETURNS BY SCORE (does higher score = better outcome?):\n');
console.log('Score'.padEnd(16) + 'Post 1d'.padStart(9) + 'Post 5d'.padStart(9) + 'Post 10d'.padStart(10) + 'Post 30d'.padStart(10));
console.log('─'.repeat(54));

for (const b of buckets) {
  const grp = withScores.filter(p => p.sim_score >= b.min && p.sim_score < b.max);
  if (grp.length < 10) continue;
  const m1 = median(grp.map(p => p.post_1d_return).filter(v => v !== null));
  const m5 = median(grp.map(p => p.post_5d_return).filter(v => v !== null));
  const m10 = median(grp.map(p => p.post_10d_return).filter(v => v !== null));
  const m30 = median(grp.map(p => p.post_30d_return).filter(v => v !== null));
  console.log(
    b.label.padEnd(16) +
    ((m1 !== null ? m1.toFixed(0) : '?') + '%').padStart(9) +
    ((m5 !== null ? m5.toFixed(0) : '?') + '%').padStart(9) +
    ((m10 !== null ? m10.toFixed(0) : '?') + '%').padStart(10) +
    ((m30 !== null ? m30.toFixed(0) : '?') + '%').padStart(10)
  );
}

// ── VERDICT ──

console.log('\n╔═══════════════════════════════════════════════════════╗');
console.log('║                   BACKTEST VERDICT                    ║');
console.log('╚═══════════════════════════════════════════════════════╝\n');

const highHeld = high.filter(p => p.held_gains_30d !== null);
const lowHeld = low.filter(p => p.held_gains_30d !== null);
const highRate = highHeld.length > 0 ? highHeld.filter(p => p.held_gains_30d === 1).length / highHeld.length * 100 : 0;
const lowRate = lowHeld.length > 0 ? lowHeld.filter(p => p.held_gains_30d === 1).length / lowHeld.length * 100 : 0;
const spread = highRate - lowRate;

if (spread > 10) {
  console.log('  STRONG: High-score pumps held ' + spread.toFixed(0) + '% better than low-score.');
  console.log('  Scanner scoring IS predictive of pump quality.');
} else if (spread > 0) {
  console.log('  MARGINAL: High-score pumps held ' + spread.toFixed(0) + '% better. Some signal.');
  console.log('  Scanner helps but isn\'t a strong filter alone.');
} else {
  console.log('  WEAK: Score does not differentiate pump quality.');
  console.log('  Scanner needs recalibration — score != outcome quality.');
}

db.close();
