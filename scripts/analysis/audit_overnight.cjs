#!/usr/bin/env node
// [1/12] FULL DATA AUDIT — Overnight Build
const Database = require('better-sqlite3');
const fs = require('fs');
const db = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db', { readonly: true });

const out = [];
function log(s = '') { out.push(s); console.log(s); }

log('══════════════════════════════════════════════════════════════');
log('[1/12] FULL DATA AUDIT — ' + new Date().toISOString());
log('══════════════════════════════════════════════════════════════');

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
log('\nTables: ' + tables.length);

// Row counts
log('\n─── TABLE ROW COUNTS ───');
for (const t of tables) {
  try {
    const n = db.prepare(`SELECT COUNT(*) as n FROM "${t}"`).get().n;
    log('  ' + t.padEnd(35) + String(n).padStart(10));
  } catch (e) { log('  ' + t.padEnd(35) + 'ERROR'); }
}

// Symbols with no prices
log('\n─── SYMBOLS WITH NO PRICE DATA ───');
const noPrice = db.prepare(`
  SELECT s.category, COUNT(*) as n
  FROM symbols s LEFT JOIN (SELECT DISTINCT ticker FROM prices) p ON s.ticker = p.ticker
  WHERE p.ticker IS NULL
  GROUP BY s.category ORDER BY n DESC
`).all();
let totalNoPrice = 0;
for (const r of noPrice) { log('  ' + (r.category || 'NULL').padEnd(25) + r.n); totalNoPrice += r.n; }
log('  TOTAL: ' + totalNoPrice);

// Stale tickers
log('\n─── STALE TICKERS (last price > 7 days old) ───');
const staleCount = db.prepare(`
  SELECT COUNT(*) as n FROM (SELECT ticker FROM prices GROUP BY ticker HAVING MAX(date) < date('now', '-7 days'))
`).get().n;
log('  Total stale tickers: ' + staleCount);
const stale = db.prepare(`
  SELECT ticker, MAX(date) as last_date, COUNT(*) as bars
  FROM prices GROUP BY ticker HAVING MAX(date) < date('now', '-7 days')
  ORDER BY last_date DESC LIMIT 20
`).all();
for (const r of stale) { log('  ' + r.ticker.padEnd(20) + r.last_date + '  (' + r.bars + ' bars)'); }

// Few bars
log('\n─── TICKERS WITH < 100 BARS ───');
const fewBars = db.prepare('SELECT COUNT(*) as n FROM (SELECT ticker FROM prices GROUP BY ticker HAVING COUNT(*) < 100)').get().n;
log('  Total: ' + fewBars);

// Tickers with prices but no F&G
log('\n─── PRICES BUT NO F&G ───');
const noFG = db.prepare(`
  SELECT COUNT(*) as n FROM (
    SELECT DISTINCT p.ticker FROM prices p
    LEFT JOIN fg_history f ON p.ticker = f.ticker
    WHERE f.ticker IS NULL
  )
`).get().n;
log('  Total tickers with prices but no F&G: ' + noFG);

// Break down by category
const noFGDetail = db.prepare(`
  SELECT COALESCE(s.category, 'NO_CATEGORY') as cat, COUNT(DISTINCT p.ticker) as n
  FROM prices p
  LEFT JOIN fg_history f ON p.ticker = f.ticker
  LEFT JOIN symbols s ON p.ticker = s.ticker
  WHERE f.ticker IS NULL
  GROUP BY cat ORDER BY n DESC LIMIT 15
`).all();
for (const r of noFGDetail) { log('  ' + r.cat.padEnd(25) + r.n); }

// Mining metadata gaps
log('\n─── MINING METADATA GAPS ───');
const totalMiners = db.prepare('SELECT COUNT(*) as n FROM mining_companies').get().n;
const nullComm = db.prepare('SELECT COUNT(*) as n FROM mining_companies WHERE primary_commodity IS NULL').get().n;
const nullStage = db.prepare('SELECT COUNT(*) as n FROM mining_companies WHERE stage IS NULL').get().n;
log('  Total miners: ' + totalMiners);
log('  NULL commodity: ' + nullComm + ' (' + (nullComm / totalMiners * 100).toFixed(1) + '%)');
log('  NULL stage: ' + nullStage + ' (' + (nullStage / totalMiners * 100).toFixed(1) + '%)');

// Sample NULL commodity miners
if (nullComm > 0) {
  const samples = db.prepare("SELECT ticker, name, exchange FROM mining_companies WHERE primary_commodity IS NULL LIMIT 20").all();
  log('  Sample NULL commodity miners:');
  for (const r of samples) { log('    ' + r.ticker.padEnd(14) + (r.name || '').substring(0, 40)); }
}

// Mining performance gap
log('\n─── MINERS NOT IN PERFORMANCE ───');
const notProfiled = db.prepare(`
  SELECT COUNT(*) as n FROM mining_companies mc
  LEFT JOIN mining_performance mp ON mc.ticker = mp.ticker
  WHERE mp.ticker IS NULL
`).get().n;
log('  Not profiled: ' + notProfiled + '/' + totalMiners);

// Commodity prices
log('\n─── COMMODITY PRICES ───');
const commodities = db.prepare(`
  SELECT commodity, COUNT(*) as bars, MIN(date) as first_date, MAX(date) as last_date
  FROM commodity_prices GROUP BY commodity ORDER BY commodity
`).all();
log('  Commodities tracked: ' + commodities.length);
for (const r of commodities) {
  log('  ' + r.commodity.padEnd(18) + String(r.bars).padStart(6) + ' bars  ' + r.first_date + ' → ' + r.last_date);
}

// Missing commodities
const miningComms = db.prepare("SELECT DISTINCT primary_commodity FROM mining_companies WHERE primary_commodity IS NOT NULL").all().map(r => r.primary_commodity);
const haveComm = new Set(commodities.map(r => r.commodity.toLowerCase()));
const missing = miningComms.filter(c => !haveComm.has(c.toLowerCase()));
if (missing.length > 0) log('  MISSING: ' + missing.join(', '));

// DEX
log('\n─── DEX REGISTRY ───');
const dexChains = db.prepare('SELECT chain, COUNT(*) as n FROM dex_registry GROUP BY chain ORDER BY n DESC').all();
for (const r of dexChains) { log('  ' + r.chain.padEnd(16) + r.n + ' tokens'); }

// On-chain tables
log('\n─── ON-CHAIN TABLES ───');
for (const t of tables.filter(t => t.includes('whale') || t.includes('holder') || t.includes('defi') || t.includes('dex') || t.includes('social') || t.includes('liquidity'))) {
  const n = db.prepare(`SELECT COUNT(*) as n FROM "${t}"`).get().n;
  log('  ' + t.padEnd(30) + String(n).padStart(8));
}

// Date ranges
log('\n─── KEY DATE RANGES ───');
const checks = [
  ['prices', 'date'], ['fg_history', 'date'], ['commodity_prices', 'date'],
  ['mining_pump_events_clean', 'pump_date'], ['scanner_results', 'scan_date'],
  ['insider_trades', 'filed_at'], ['filings', 'filing_date']
];
for (const [t, col] of checks) {
  if (tables.includes(t)) {
    try {
      const r = db.prepare(`SELECT MIN("${col}") as mn, MAX("${col}") as mx FROM "${t}"`).get();
      log('  ' + t.padEnd(30) + (r.mn || '?') + ' → ' + (r.mx || '?'));
    } catch (e) { log('  ' + t.padEnd(30) + 'ERROR: ' + e.message.substring(0, 40)); }
  }
}

// DB size
const stats = fs.statSync(process.env.HOME + '/.tradingview-mcp/db/fg.db');
log('\n─── DATABASE SIZE ───');
log('  ' + (stats.size / 1024 / 1024 / 1024).toFixed(2) + ' GB');

log('\n[1/12] ✓ AUDIT COMPLETE');

// Save
const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
fs.writeFileSync('/Volumes/Ext/tradingview-mcp-jackson/scripts/analysis/audit_' + dateStr + '.txt', out.join('\n'));
log('Saved to scripts/analysis/audit_' + dateStr + '.txt');

db.close();
