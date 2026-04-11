// Enrich pump events with on-chain context from existing DB data
const Database = require('better-sqlite3');
const db = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');

console.log('Enriching pump events with structural context...\n');

const pumps = db.prepare("SELECT pe.event_id, pe.ticker, pe.pump_date FROM pump_events pe LEFT JOIN pump_onchain_context poc ON pe.event_id = poc.event_id WHERE poc.event_id IS NULL").all();
console.log('Events to enrich:', pumps.length);

const insert = db.prepare("INSERT OR IGNORE INTO pump_onchain_context (event_id, pre_holder_count, pre_top10_concentration, pre_whale_buys_7d, pre_whale_sells_7d, pre_whale_net_flow_usd, token_age_at_pump, exchanges_listed, social_followers_at_pump, is_verified) VALUES (?,?,?,?,?,?,?,?,?,?)");

let enriched = 0;
const batch = db.transaction(() => {
  for (const p of pumps) {
    const sym = p.ticker.replace('-USD', '').replace('USDT', '');
    // Token metadata
    const meta = db.prepare("SELECT token_age_days, is_verified, token_address FROM token_metadata WHERE UPPER(symbol) = UPPER(?) LIMIT 1").get(sym);
    // Exchange count
    const ex = db.prepare("SELECT COUNT(DISTINCT exchange) as n FROM exchange_listings WHERE UPPER(symbol) = UPPER(?)").get(sym);
    // Whale activity
    let wB = 0, wS = 0, wNet = 0;
    if (meta?.token_address) {
      const w = db.prepare("SELECT direction, COUNT(*) as n, SUM(amount_usd) as total FROM whale_trades WHERE token_address = ? AND timestamp < ? AND timestamp > datetime(?, '-7 days') GROUP BY direction").all(meta.token_address, p.pump_date, p.pump_date);
      for (const r of w) { if (r.direction === 'buy') { wB = r.n; wNet += r.total; } if (r.direction === 'sell') { wS = r.n; wNet -= r.total; } }
    }
    // Holder data
    let holders = null, top10 = null;
    if (meta?.token_address) {
      const h = db.prepare("SELECT total_holders, top10_pct FROM holder_snapshots WHERE token_address = ? ORDER BY ABS(julianday(snapshot_ts) - julianday(?)) LIMIT 1").get(meta.token_address, p.pump_date);
      if (h) { holders = h.total_holders; top10 = h.top10_pct; }
    }
    // Social
    let social = null;
    if (meta?.token_address) {
      const s = db.prepare("SELECT twitter_followers + COALESCE(telegram_members, 0) as t FROM social_snapshots WHERE token_address = ? ORDER BY ABS(julianday(snapshot_ts) - julianday(?)) LIMIT 1").get(meta.token_address, p.pump_date);
      social = s?.t || null;
    }
    // Age at pump
    let age = null;
    if (meta?.token_age_days) { const dsp = Math.floor((Date.now() - new Date(p.pump_date).getTime()) / 86400000); age = Math.max(0, (meta.token_age_days || 0) - dsp); }

    insert.run(p.event_id, holders, top10, wB, wS, wNet, age, ex?.n || null, social, meta?.is_verified || null);
    enriched++;
  }
});
batch();

console.log('Enriched:', enriched);

// Analyze what we got
const withCtx = db.prepare("SELECT pe.*, poc.* FROM pump_events pe JOIN pump_onchain_context poc ON pe.event_id = poc.event_id WHERE pe.pump_pct >= 60").all();
console.log('\nPumps with on-chain context:', withCtx.length);

const insertChar = db.prepare("INSERT OR REPLACE INTO pump_characteristics (characteristic, avg_value, median_value, min_value, max_value, std_dev, sample_count, description) VALUES (?,?,?,?,?,?,?,?)");

function analyze(name, vals, desc) {
  const c = vals.filter(v => v != null && isFinite(v));
  if (c.length < 5) { console.log('  ' + name.padEnd(35) + 'n=' + c.length); return; }
  const sorted = [...c].sort((a, b) => a - b);
  const avg = c.reduce((s, v) => s + v, 0) / c.length;
  const med = sorted[Math.floor(sorted.length / 2)];
  const sd = Math.sqrt(c.reduce((s, v) => s + (v - avg) ** 2, 0) / (c.length - 1));
  insertChar.run(name, avg, med, Math.min(...c), Math.max(...c), sd, c.length, desc);
  console.log('  ' + name.padEnd(35) + 'avg:' + avg.toFixed(1).padStart(8) + ' med:' + med.toFixed(1).padStart(8) + ' n=' + c.length);
}

console.log('\nOn-chain characteristics:');
analyze('token_age_days_at_pump', withCtx.map(p => p.token_age_at_pump), 'Token age when it pumped');
analyze('exchanges_listed', withCtx.map(p => p.exchanges_listed), 'Exchange count at pump');
analyze('pre_whale_buys_7d', withCtx.map(p => p.pre_whale_buys_7d), 'Whale buys 7d before');
analyze('pre_whale_sells_7d', withCtx.map(p => p.pre_whale_sells_7d), 'Whale sells 7d before');
analyze('pre_whale_net_flow_usd', withCtx.map(p => p.pre_whale_net_flow_usd), 'Net whale flow USD');

db.close();
