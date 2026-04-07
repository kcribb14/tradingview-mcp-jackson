// ASX mining ETL — additive, uses INSERT OR IGNORE
const Database = require('better-sqlite3');
const DB = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
DB.pragma('journal_mode = WAL');

const insertMining = DB.prepare(`INSERT OR IGNORE INTO mining_companies (ticker, name, exchange, country, primary_commodity, stage, market_cap_aud, data_source) VALUES (?, ?, 'ASX', 'AU', ?, ?, ?, 'asx_yahoo')`);
const updateMining = DB.prepare(`UPDATE mining_companies SET market_cap_aud = ?, primary_commodity = COALESCE(primary_commodity, ?), stage = COALESCE(stage, ?), name = COALESCE(name, ?), fetched_at = CURRENT_TIMESTAMP WHERE ticker = ?`);
const insertSym = DB.prepare(`INSERT OR IGNORE INTO symbols (ticker, name, category, asset_class, exchange) VALUES (?, ?, 'ASX_MINING', 'equity', 'ASX')`);

function classifyCommodity(name) {
  const n = (name || '').toLowerCase();
  if (/lithium/.test(n)) return 'Lithium'; if (/gold/.test(n)) return 'Gold';
  if (/silver/.test(n)) return 'Silver'; if (/copper/.test(n)) return 'Copper';
  if (/nickel/.test(n)) return 'Nickel'; if (/uranium/.test(n)) return 'Uranium';
  if (/iron|magnetite/.test(n)) return 'Iron Ore'; if (/coal|coking/.test(n)) return 'Coal';
  if (/rare earth|\bree\b/.test(n)) return 'Rare Earths'; if (/zinc/.test(n)) return 'Zinc';
  if (/cobalt/.test(n)) return 'Cobalt'; if (/graphite/.test(n)) return 'Graphite';
  if (/vanadium/.test(n)) return 'Vanadium'; if (/manganese/.test(n)) return 'Manganese';
  if (/platinum|pgm|palladium/.test(n)) return 'PGMs';
  if (/oil|petroleum|gas|lng/.test(n)) return 'Oil & Gas';
  if (/tin\b/.test(n)) return 'Tin'; if (/tungsten/.test(n)) return 'Tungsten';
  return 'Diversified';
}

function classifyStage(mcap) {
  if (!mcap || mcap < 5e6) return 'Shell'; if (mcap < 50e6) return 'Explorer';
  if (mcap < 250e6) return 'Developer'; if (mcap < 2e9) return 'Producer (Mid)';
  return 'Producer (Major)';
}

const ASX_MINERS = [
  'BHP','RIO','FMG','S32','NCM','NST','EVN','PLS','MIN','IGO','LYC','WHC','WDS','STO','ORG','ILU',
  'PLL','AKE','LTR','CXO','SYR','SBM','RRL','RMS','OZL','GMD','RED','PRU','CMM','BGL','GOR','SLR','WGX','WAF','TIE',
  'PMT','LKE','VUL','GL1','PSC','AGY','LRS','ASN','LEL','SYA','EMH','EMN',
  'PDN','BOE','DYL','LOT','BMN','EL8','AGE','ALX','URM','TOE','SLX','DEV','HAR','BSN',
  'ARU','ARR','VML','HAS','RNU','PEK','MLX',
  'SFR','29M','HCH','AIS','C29',
  'CY5','ARV','KIN','THR','BTR','PNR','MTH','CHN','RSG','HRZ','CDR','ADN','TLG','GBR',
  'WSA','MCR','POS','CTM','PAN','GAL',
  'MGX','GRR','TI1','CIA',
  'COB','SGQ','ACR','VR8','EGR','MNS','BAT','EV1',
  'BPT','KAR','CVN','SXY','HZN','NHC','YAL'
];

async function main() {
  console.log('ASX Mining ETL (additive — INSERT OR IGNORE)');
  const tickers = [...new Set(ASX_MINERS)].map(c => c + '.AX');
  let inserted = 0, updated = 0;

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    let mcap = 0, name = ticker.replace('.AX', '');
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ticker}`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) { const d = await r.json(); const q = d?.quoteResponse?.result?.[0]; mcap = q?.marketCap || 0; name = q?.longName || q?.shortName || name; }
    } catch {}
    const commodity = classifyCommodity(name);
    const stage = classifyStage(mcap);
    const existing = DB.prepare('SELECT ticker FROM mining_companies WHERE ticker = ?').get(ticker);
    if (existing) { updateMining.run(mcap, commodity, stage, name, ticker); updated++; }
    else { insertMining.run(ticker, name, commodity, stage, mcap); inserted++; }
    insertSym.run(ticker, name);
    if (i % 20 === 0) process.stdout.write(`\r${i + 1}/${tickers.length} NEW:${inserted} UPD:${updated}`);
    await new Promise(r => setTimeout(r, 150));
  }
  console.log(`\nASX: ${inserted} new, ${updated} updated. Total: ${DB.prepare("SELECT COUNT(*) as n FROM mining_companies WHERE exchange='ASX'").get().n}`);
  DB.close();
}
main().catch(console.error);
