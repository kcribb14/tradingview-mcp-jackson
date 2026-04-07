// Pull comprehensive ASX mining universe via Yahoo screener
// Additive — INSERT OR IGNORE only
const Database = require('better-sqlite3');
const DB = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
DB.pragma('journal_mode = WAL');

const insertMining = DB.prepare(`INSERT OR IGNORE INTO mining_companies (ticker, name, exchange, country, primary_commodity, stage, market_cap_aud, data_source) VALUES (?, ?, 'ASX', 'AU', ?, ?, ?, 'asx_full')`);
const insertSym = DB.prepare(`INSERT OR IGNORE INTO symbols (ticker, name, category, asset_class, exchange) VALUES (?, ?, 'ASX_MINING', 'equity', 'ASX')`);

function classifyCommodity(name, industry) {
  const n = ((name || '') + ' ' + (industry || '')).toLowerCase();
  if (/lithium/.test(n)) return 'Lithium'; if (/gold/.test(n)) return 'Gold';
  if (/silver/.test(n)) return 'Silver'; if (/copper/.test(n)) return 'Copper';
  if (/nickel/.test(n)) return 'Nickel'; if (/uranium/.test(n)) return 'Uranium';
  if (/iron|magnetite/.test(n)) return 'Iron Ore'; if (/coal|coking/.test(n)) return 'Coal';
  if (/rare earth|\bree\b/.test(n)) return 'Rare Earths'; if (/zinc/.test(n)) return 'Zinc';
  if (/cobalt/.test(n)) return 'Cobalt'; if (/graphite/.test(n)) return 'Graphite';
  if (/vanadium/.test(n)) return 'Vanadium'; if (/manganese/.test(n)) return 'Manganese';
  if (/platinum|pgm|palladium/.test(n)) return 'PGMs';
  if (/oil|petroleum|gas|lng|energy/.test(n)) return 'Oil & Gas';
  if (/potash|phosphate/.test(n)) return 'Potash'; if (/tin\b/.test(n)) return 'Tin';
  if (/tungsten/.test(n)) return 'Tungsten'; if (/diamond/.test(n)) return 'Diamonds';
  if (/mineral sand|zircon|titanium|rutile/.test(n)) return 'Mineral Sands';
  if (/bauxite|alumin/.test(n)) return 'Aluminium'; if (/antimony/.test(n)) return 'Antimony';
  if (/helium/.test(n)) return 'Helium'; if (/hydrogen/.test(n)) return 'Hydrogen';
  return 'Diversified';
}

function classifyStage(mcap) {
  if (!mcap || mcap < 5e6) return 'Shell'; if (mcap < 50e6) return 'Explorer';
  if (mcap < 250e6) return 'Developer'; if (mcap < 2e9) return 'Producer (Mid)';
  return 'Producer (Major)';
}

// Fetch ASX tickers from existing symbols table + universe file
async function getASXTickers() {
  const fs = require('fs');
  const u = JSON.parse(fs.readFileSync(process.env.HOME + '/.tradingview-mcp/universes/master.json'));
  const existing = new Set();
  for (const [cat, tickers] of Object.entries(u)) {
    if (cat.includes('ASX') || cat.includes('MINING')) {
      for (const t of tickers) existing.add(t);
    }
  }
  // Also get from symbols table
  DB.prepare("SELECT ticker FROM symbols WHERE ticker LIKE '%.AX'").all().forEach(r => existing.add(r.ticker));
  return [...existing];
}

async function main() {
  console.log('Comprehensive ASX mining universe...\n');

  const tickers = await getASXTickers();
  console.log('Found', tickers.length, 'ASX tickers to check\n');

  let inserted = 0, skipped = 0;
  const batch = [];

  // Fetch in batches of 10 via Yahoo quote API
  for (let i = 0; i < tickers.length; i += 10) {
    const batchTickers = tickers.slice(i, i + 10);
    const syms = batchTickers.join(',');
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${syms}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000)
      });
      if (!r.ok) continue;
      const d = await r.json();
      for (const q of (d?.quoteResponse?.result || [])) {
        if (!q.symbol?.endsWith('.AX')) continue;
        const sector = (q.sector || '').toLowerCase();
        const industry = (q.industry || '').toLowerCase();
        // Filter for mining/energy/materials
        if (!/material|metal|mining|gold|coal|oil|gas|energy|basic/i.test(sector + ' ' + industry + ' ' + q.quoteType)) {
          // Also check if already in mining_companies
          const exists = DB.prepare('SELECT ticker FROM mining_companies WHERE ticker = ?').get(q.symbol);
          if (!exists) { skipped++; continue; }
        }

        const name = q.longName || q.shortName || q.symbol;
        const mcap = q.marketCap || 0;
        const commodity = classifyCommodity(name, industry);
        const stage = classifyStage(mcap);

        try {
          insertMining.run(q.symbol, name, commodity, stage, mcap);
          insertSym.run(q.symbol, name);
          inserted++;
        } catch {}
      }
    } catch {}
    if (i % 100 === 0) process.stdout.write(`\r${i}/${tickers.length} new:${inserted} skip:${skipped}`);
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n\nInserted: ${inserted}, Skipped: ${skipped}`);
  const total = DB.prepare("SELECT COUNT(*) as n FROM mining_companies WHERE exchange='ASX'").get();
  console.log('Total ASX miners:', total.n);

  const byCom = DB.prepare("SELECT primary_commodity, COUNT(*) as n FROM mining_companies WHERE exchange='ASX' GROUP BY primary_commodity ORDER BY n DESC LIMIT 15").all();
  console.log('\nASX by commodity:');
  byCom.forEach(c => console.log('  ' + (c.primary_commodity || '?').padEnd(20) + c.n));
  DB.close();
}
main().catch(console.error);
