#!/usr/bin/env node
/**
 * [3/12] Fill missing mining company metadata.
 * Infer primary_commodity from company name patterns.
 * Infer stage from market cap and exchange.
 */
const Database = require('better-sqlite3');
const db = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
db.pragma('journal_mode = WAL');

console.log('[3/12] → Fill mining company metadata...');

// ─── Commodity inference from name ───

const COMMODITY_PATTERNS = [
  [/\bgold\b/i, 'Gold'],
  [/\baurum\b/i, 'Gold'],
  [/\bsilver\b/i, 'Silver'],
  [/\bargent\b/i, 'Silver'],
  [/\bcopper\b/i, 'Copper'],
  [/\blithium\b/i, 'Lithium'],
  [/\buranium\b/i, 'Uranium'],
  [/\bnickel\b/i, 'Nickel'],
  [/\biron\s*ore\b/i, 'Iron Ore'],
  [/\biron\b/i, 'Iron Ore'],
  [/\bcoal\b/i, 'Coal'],
  [/\bzinc\b/i, 'Zinc'],
  [/\btin\b/i, 'Tin'],
  [/\bcobalt\b/i, 'Cobalt'],
  [/\bplatinum\b/i, 'PGMs'],
  [/\bpalladium\b/i, 'PGMs'],
  [/\bPGM\b/i, 'PGMs'],
  [/\brare\s*earth/i, 'Rare Earths'],
  [/\bREE\b/, 'Rare Earths'],
  [/\bgraphite\b/i, 'Graphite'],
  [/\bmanganese\b/i, 'Manganese'],
  [/\bvanadium\b/i, 'Vanadium'],
  [/\bmineral\s*sand/i, 'Mineral Sands'],
  [/\bsand\b/i, 'Mineral Sands'],
  [/\bzircon\b/i, 'Mineral Sands'],
  [/\btitanium\b/i, 'Mineral Sands'],
  [/\bilmenite\b/i, 'Mineral Sands'],
  [/\bpotash\b/i, 'Potash'],
  [/\bphosphate\b/i, 'Potash/Phosphate'],
  [/\bdiamond\b/i, 'Diamonds'],
  [/\btungsten\b/i, 'Tungsten'],
  [/\bantimony\b/i, 'Antimony'],
  [/\bhelium\b/i, 'Helium'],
  [/\bhydrogen\b/i, 'Hydrogen'],
  [/\boil\b/i, 'Oil & Gas'],
  [/\bgas\b/i, 'Oil & Gas'],
  [/\bpetrol/i, 'Oil & Gas'],
  [/\benergy\b/i, 'Oil & Gas'],
  [/\broyalt/i, 'Royalties'],
  [/\bstream/i, 'Streaming'],
  [/\bdivers/i, 'Diversified'],
];

function inferCommodity(name) {
  if (!name) return null;
  for (const [pattern, commodity] of COMMODITY_PATTERNS) {
    if (pattern.test(name)) return commodity;
  }
  return null;
}

// ─── Stage inference ───

function inferStage(ticker, exchange, mcap) {
  // If we have market cap data from prices, use it
  if (mcap && mcap > 0) {
    if (mcap >= 1e9) return 'Producer Major';
    if (mcap >= 1e8) return 'Producer Mid';
    if (mcap >= 1e7) return 'Developer';
    return 'Explorer';
  }

  // Heuristic from exchange
  if (exchange === 'ASX') return 'Explorer'; // Most ASX miners are explorers
  if (exchange === 'NYSE') return 'Producer Mid';
  if (exchange === 'TSX') return 'Developer';
  if (exchange === 'LSE') return 'Producer Mid';
  return 'Explorer';
}

// ─── Apply commodity inference ───

const nullComm = db.prepare("SELECT ticker, name, exchange FROM mining_companies WHERE primary_commodity IS NULL").all();
console.log('NULL commodity miners: ' + nullComm.length);

const updateComm = db.prepare("UPDATE mining_companies SET primary_commodity = ? WHERE ticker = ?");
let commFilled = 0;
for (const m of nullComm) {
  const inferred = inferCommodity(m.name);
  if (inferred) {
    updateComm.run(inferred, m.ticker);
    commFilled++;
  }
}
console.log('  Commodity inferred: ' + commFilled + '/' + nullComm.length);

// ─── Apply stage inference ───

const nullStage = db.prepare("SELECT mc.ticker, mc.name, mc.exchange FROM mining_companies mc WHERE mc.stage IS NULL").all();
console.log('\nNULL stage miners: ' + nullStage.length);

// Try to get market cap from latest price × shares (approximate)
const updateStage = db.prepare("UPDATE mining_companies SET stage = ? WHERE ticker = ?");
let stageFilled = 0;
for (const m of nullStage) {
  const stage = inferStage(m.ticker, m.exchange, null);
  if (stage) {
    updateStage.run(stage, m.ticker);
    stageFilled++;
  }
}
console.log('  Stage inferred: ' + stageFilled + '/' + nullStage.length);

// ─── Summary ───

const remaining = {
  nullComm: db.prepare("SELECT COUNT(*) as n FROM mining_companies WHERE primary_commodity IS NULL").get().n,
  nullStage: db.prepare("SELECT COUNT(*) as n FROM mining_companies WHERE stage IS NULL").get().n,
};

console.log('\n[3/12] ✓ Mining metadata filled');
console.log('  Commodity: ' + commFilled + ' filled, ' + remaining.nullComm + ' still NULL');
console.log('  Stage: ' + stageFilled + ' filled, ' + remaining.nullStage + ' still NULL');

db.close();
