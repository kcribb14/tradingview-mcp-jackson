#!/usr/bin/env node
/**
 * [6/12] Re-enrich pump events with commodity data.
 * Now that commodity_prices has 36 commodities, fill NULL commodity fields.
 */
const Database = require('better-sqlite3');
const db = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
db.pragma('journal_mode = WAL');

console.log('[6/12] → Re-enrich pump events with commodity data...');

// Before counts
const before = db.prepare(`
  SELECT COUNT(*) as total,
    SUM(CASE WHEN commodity_30d_return IS NOT NULL THEN 1 ELSE 0 END) as has_30d,
    SUM(CASE WHEN commodity_90d_return IS NOT NULL THEN 1 ELSE 0 END) as has_90d,
    SUM(CASE WHEN commodity_trend IS NOT NULL THEN 1 ELSE 0 END) as has_trend
  FROM mining_pump_events_clean
`).get();
console.log('Before: ' + before.has_30d + '/' + before.total + ' have comm_30d, ' + before.has_90d + ' have comm_90d\n');

// Update commodity_30d_return
const events = db.prepare(`
  SELECT event_id, primary_commodity, pump_date
  FROM mining_pump_events_clean
  WHERE primary_commodity IS NOT NULL
    AND (commodity_30d_return IS NULL OR commodity_90d_return IS NULL)
`).all();

console.log('Events to enrich: ' + events.length);

const update30d = db.prepare(`
  UPDATE mining_pump_events_clean
  SET commodity_30d_return = ?,
      commodity_90d_return = ?,
      commodity_trend = ?,
      commodity_price_at_pump = ?
  WHERE event_id = ?
`);

let filled30d = 0, filled90d = 0, filledTrend = 0, filledPrice = 0;

const enrichBatch = db.transaction(() => {
  for (const e of events) {
    // Get commodity price at pump date
    const atPump = db.prepare(`
      SELECT price_usd FROM commodity_prices
      WHERE commodity = ? AND date <= ? ORDER BY date DESC LIMIT 1
    `).get(e.primary_commodity, e.pump_date);

    // Get commodity price 30 days before pump
    const p30d = db.prepare(`
      SELECT price_usd FROM commodity_prices
      WHERE commodity = ? AND date <= date(?, '-30 days') ORDER BY date DESC LIMIT 1
    `).get(e.primary_commodity, e.pump_date);

    // Get commodity price 90 days before pump
    const p90d = db.prepare(`
      SELECT price_usd FROM commodity_prices
      WHERE commodity = ? AND date <= date(?, '-90 days') ORDER BY date DESC LIMIT 1
    `).get(e.primary_commodity, e.pump_date);

    let comm30d = null, comm90d = null, trend = null, priceAtPump = null;

    if (atPump) priceAtPump = atPump.price_usd;
    if (atPump && p30d && p30d.price_usd > 0) {
      comm30d = Math.round(((atPump.price_usd - p30d.price_usd) / p30d.price_usd) * 10000) / 100;
      filled30d++;
    }
    if (atPump && p90d && p90d.price_usd > 0) {
      comm90d = Math.round(((atPump.price_usd - p90d.price_usd) / p90d.price_usd) * 10000) / 100;
      filled90d++;
    }
    if (comm30d !== null) {
      trend = comm30d > 5 ? 'rising' : comm30d < -5 ? 'falling' : 'flat';
      filledTrend++;
    }
    if (priceAtPump) filledPrice++;

    update30d.run(comm30d, comm90d, trend, priceAtPump, e.event_id);
  }
});

enrichBatch();

// After counts
const after = db.prepare(`
  SELECT COUNT(*) as total,
    SUM(CASE WHEN commodity_30d_return IS NOT NULL THEN 1 ELSE 0 END) as has_30d,
    SUM(CASE WHEN commodity_90d_return IS NOT NULL THEN 1 ELSE 0 END) as has_90d,
    SUM(CASE WHEN commodity_trend IS NOT NULL THEN 1 ELSE 0 END) as has_trend,
    SUM(CASE WHEN commodity_price_at_pump IS NOT NULL THEN 1 ELSE 0 END) as has_price
  FROM mining_pump_events_clean
`).get();

console.log('\n[6/12] ✓ Pump events enriched with commodity data');
console.log('  commodity_30d_return: ' + before.has_30d + ' → ' + after.has_30d + ' (+' + (after.has_30d - before.has_30d) + ')');
console.log('  commodity_90d_return: ' + before.has_90d + ' → ' + after.has_90d + ' (+' + (after.has_90d - before.has_90d) + ')');
console.log('  commodity_trend:      ' + before.has_trend + ' → ' + after.has_trend + ' (+' + (after.has_trend - before.has_trend) + ')');
console.log('  commodity_price:      ' + after.has_price + '/' + after.total);

// Show remaining gaps by commodity
const gaps = db.prepare(`
  SELECT primary_commodity, COUNT(*) as n
  FROM mining_pump_events_clean
  WHERE primary_commodity IS NOT NULL AND commodity_30d_return IS NULL
  GROUP BY primary_commodity ORDER BY n DESC
`).all();
if (gaps.length > 0) {
  console.log('\n  Still missing (no commodity price data for date range):');
  for (const g of gaps) console.log('    ' + g.primary_commodity.padEnd(18) + g.n + ' events');
}

db.close();
