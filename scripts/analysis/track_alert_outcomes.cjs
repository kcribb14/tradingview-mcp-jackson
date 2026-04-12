#!/usr/bin/env node
/**
 * Track forward outcomes for volume alerts and AI screening picks.
 * For each alert from 1, 3, 7 days ago, fetch actual price and compute returns.
 */
const Database = require('better-sqlite3');
const db = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
db.pragma('journal_mode = WAL');

console.log('═══ ALERT OUTCOME TRACKER ═══\n');

db.exec(`
CREATE TABLE IF NOT EXISTS alert_outcomes (
  alert_id TEXT PRIMARY KEY,
  ticker TEXT,
  source TEXT,
  alert_date TEXT,
  price_at_alert REAL,
  price_1d REAL,
  price_3d REAL,
  price_7d REAL,
  return_1d REAL,
  return_3d REAL,
  return_7d REAL,
  pumped_20 INTEGER,
  pumped_40 INTEGER,
  archetype TEXT,
  scanner_score REAL,
  last_checked TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
`);

// ─── Track volume_alerts outcomes ───

const alerts = db.prepare(`
  SELECT va.alert_id, va.ticker, va.source, va.alert_date, va.price_at_alert,
         va.archetype, va.scanner_score
  FROM volume_alerts va
  LEFT JOIN alert_outcomes ao ON va.alert_id = ao.alert_id
  WHERE va.price_at_alert > 0
    AND (ao.alert_id IS NULL OR (ao.return_7d IS NULL AND va.alert_date <= date('now', '-7 days')))
`).all();

console.log('Alerts needing outcome tracking: ' + alerts.length);

const upsertOutcome = db.prepare(`
  INSERT OR REPLACE INTO alert_outcomes
  (alert_id, ticker, source, alert_date, price_at_alert, price_1d, price_3d, price_7d,
   return_1d, return_3d, return_7d, pumped_20, pumped_40, archetype, scanner_score, last_checked)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
`);

let tracked = 0;

for (const a of alerts) {
  // Extract base ticker from DEX format (SYMBOL:chain → just ticker in prices)
  const priceTicker = a.ticker.includes(':') ? a.ticker.split(':')[0] : a.ticker;

  // 1-day forward
  const p1d = db.prepare(
    'SELECT close FROM prices WHERE ticker = ? AND date > ? ORDER BY date ASC LIMIT 1'
  ).get(priceTicker, a.alert_date);

  // 3-day forward
  const p3d = db.prepare(
    "SELECT close FROM prices WHERE ticker = ? AND date >= date(?, '+3 days') ORDER BY date ASC LIMIT 1"
  ).get(priceTicker, a.alert_date);

  // 7-day forward
  const p7d = db.prepare(
    "SELECT close FROM prices WHERE ticker = ? AND date >= date(?, '+7 days') ORDER BY date ASC LIMIT 1"
  ).get(priceTicker, a.alert_date);

  const ret1d = p1d && a.price_at_alert > 0
    ? Math.round(((p1d.close - a.price_at_alert) / a.price_at_alert) * 10000) / 100 : null;
  const ret3d = p3d && a.price_at_alert > 0
    ? Math.round(((p3d.close - a.price_at_alert) / a.price_at_alert) * 10000) / 100 : null;
  const ret7d = p7d && a.price_at_alert > 0
    ? Math.round(((p7d.close - a.price_at_alert) / a.price_at_alert) * 10000) / 100 : null;

  const maxRet = Math.max(ret1d || -999, ret3d || -999, ret7d || -999);
  const pumped20 = maxRet >= 20 ? 1 : (ret7d !== null ? 0 : null);
  const pumped40 = maxRet >= 40 ? 1 : (ret7d !== null ? 0 : null);

  upsertOutcome.run(
    a.alert_id, a.ticker, a.source, a.alert_date, a.price_at_alert,
    p1d?.close || null, p3d?.close || null, p7d?.close || null,
    ret1d, ret3d, ret7d, pumped20, pumped40,
    a.archetype, a.scanner_score
  );
  tracked++;
}

console.log('Tracked: ' + tracked + '\n');

// ─── Also track AI screening results as alerts ───

const aiPicks = db.prepare(`
  SELECT ai.scan_date, ai.ticker, ai.action, ai.confidence, ai.archetype,
         (SELECT close FROM prices WHERE ticker = ai.ticker AND date <= ai.scan_date ORDER BY date DESC LIMIT 1) as price_at_screen
  FROM ai_screening_results ai
  LEFT JOIN alert_outcomes ao ON ('ai_' || ai.scan_date || '_' || ai.ticker) = ao.alert_id
  WHERE ao.alert_id IS NULL AND ai.action = 'alert' AND ai.confidence >= 70
`).all();

console.log('AI alert picks needing tracking: ' + aiPicks.length);

for (const a of aiPicks) {
  if (!a.price_at_screen || a.price_at_screen <= 0) continue;

  const alertId = 'ai_' + a.scan_date + '_' + a.ticker;
  const p1d = db.prepare('SELECT close FROM prices WHERE ticker = ? AND date > ? ORDER BY date ASC LIMIT 1').get(a.ticker, a.scan_date);
  const p3d = db.prepare("SELECT close FROM prices WHERE ticker = ? AND date >= date(?, '+3 days') ORDER BY date ASC LIMIT 1").get(a.ticker, a.scan_date);
  const p7d = db.prepare("SELECT close FROM prices WHERE ticker = ? AND date >= date(?, '+7 days') ORDER BY date ASC LIMIT 1").get(a.ticker, a.scan_date);

  const ret1d = p1d ? Math.round(((p1d.close - a.price_at_screen) / a.price_at_screen) * 10000) / 100 : null;
  const ret3d = p3d ? Math.round(((p3d.close - a.price_at_screen) / a.price_at_screen) * 10000) / 100 : null;
  const ret7d = p7d ? Math.round(((p7d.close - a.price_at_screen) / a.price_at_screen) * 10000) / 100 : null;

  const maxRet = Math.max(ret1d || -999, ret3d || -999, ret7d || -999);
  upsertOutcome.run(alertId, a.ticker, 'ai_screener', a.scan_date, a.price_at_screen,
    p1d?.close || null, p3d?.close || null, p7d?.close || null,
    ret1d, ret3d, ret7d,
    maxRet >= 20 ? 1 : (ret7d !== null ? 0 : null),
    maxRet >= 40 ? 1 : (ret7d !== null ? 0 : null),
    a.archetype, a.confidence
  );
}

// ─── Summary report ───

const outcomes = db.prepare('SELECT * FROM alert_outcomes').all();
console.log('\nTotal tracked outcomes: ' + outcomes.length);

if (outcomes.length > 0) {
  console.log('\n▸ HIT RATES BY SOURCE:\n');
  console.log('Source'.padEnd(16) + 'Alerts'.padStart(7) + 'Has 1d'.padStart(8) + 'Has 7d'.padStart(8) + 'Med 1d'.padStart(8) + 'Med 7d'.padStart(8) + 'Pump20%'.padStart(8));
  console.log('─'.repeat(63));

  for (const source of ['mining', 'dex', 'ai_screener']) {
    const grp = outcomes.filter(o => o.source === source);
    if (grp.length === 0) continue;
    const has1d = grp.filter(o => o.return_1d !== null);
    const has7d = grp.filter(o => o.return_7d !== null);
    const med1d = has1d.length > 0 ? has1d.map(o => o.return_1d).sort((a, b) => a - b)[Math.floor(has1d.length / 2)] : null;
    const med7d = has7d.length > 0 ? has7d.map(o => o.return_7d).sort((a, b) => a - b)[Math.floor(has7d.length / 2)] : null;
    const pumped = grp.filter(o => o.pumped_20 === 1).length;
    const measurable = grp.filter(o => o.pumped_20 !== null).length;
    console.log(
      source.padEnd(16) + String(grp.length).padStart(7) +
      String(has1d.length).padStart(8) + String(has7d.length).padStart(8) +
      (med1d !== null ? med1d.toFixed(0) + '%' : '-').padStart(8) +
      (med7d !== null ? med7d.toFixed(0) + '%' : '-').padStart(8) +
      (measurable > 0 ? pumped + '/' + measurable : '-').padStart(8)
    );
  }

  // Best and worst calls
  const withReturns = outcomes.filter(o => o.return_7d !== null || o.return_3d !== null || o.return_1d !== null);
  if (withReturns.length > 0) {
    const byBestReturn = [...withReturns].sort((a, b) => (b.return_7d || b.return_3d || b.return_1d || 0) - (a.return_7d || a.return_3d || a.return_1d || 0));
    console.log('\n▸ TOP 5 BEST CALLS:');
    for (const o of byBestReturn.slice(0, 5)) {
      const best = o.return_7d || o.return_3d || o.return_1d || 0;
      console.log('  ' + o.ticker.padEnd(14) + (best > 0 ? '+' : '') + best.toFixed(1) + '%  ' + o.source + '  ' + (o.archetype || ''));
    }
    console.log('\n▸ TOP 5 WORST CALLS:');
    for (const o of byBestReturn.slice(-5).reverse()) {
      const worst = o.return_7d || o.return_3d || o.return_1d || 0;
      console.log('  ' + o.ticker.padEnd(14) + (worst > 0 ? '+' : '') + worst.toFixed(1) + '%  ' + o.source + '  ' + (o.archetype || ''));
    }
  }
} else {
  console.log('No outcomes measured yet — alerts are < 1 day old.');
  console.log('First results after next trading day closes.');
}

db.close();
