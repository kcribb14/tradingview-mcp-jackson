// Extended global mining — TSX juniors, LSE AIM, more NYSE
const Database = require('better-sqlite3');
const DB = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
DB.pragma('journal_mode = WAL');

const insertMining = DB.prepare(`INSERT OR IGNORE INTO mining_companies (ticker, name, exchange, country, primary_commodity, stage, market_cap_aud, data_source) VALUES (?, ?, ?, ?, ?, ?, ?, 'global_extended')`);
const insertSym = DB.prepare(`INSERT OR IGNORE INTO symbols (ticker, name, category, asset_class, exchange) VALUES (?, ?, ?, 'equity', ?)`);

function classifyStage(mcap) {
  if (!mcap || mcap < 5e6) return 'Shell'; if (mcap < 50e6) return 'Explorer';
  if (mcap < 250e6) return 'Developer'; if (mcap < 2e9) return 'Producer (Mid)';
  return 'Producer (Major)';
}

const GLOBAL_EXT = {
  // More TSX gold/silver/copper juniors
  TSX_EXT: { country: 'CA', exchange: 'TSX', suffix: '.TO', cat: 'CANADA_TSX', tickers: {
    'BTO/Gold':'B2Gold','LUG/Gold':'Lundin Gold','CG/Gold':'Centerra Gold',
    'EQX/Gold':'Equinox Gold','SSRM/Gold':'SSR Mining','DPM/Gold':'Dundee Precious',
    'CXB/Gold':'Calibre Mining','GAU/Gold':'Galiano Gold','MOZ/Gold':'Marathon Gold',
    'WG/Gold':'Wesdome Gold','VGCX/Gold':'Victoria Gold','GCM/Gold':'Gran Colombia',
    'SVM/Silver':'Silvercorp','FR/Silver':'First Majestic','AYA/Silver':'Aya Gold Silver',
    'SLI/Lithium':'Standard Lithium','CRE/Lithium':'Critical Elements','PMET/Lithium':'Patriot Battery',
    'GLO/Uranium':'Global Atomic','ISO/Uranium':'IsoEnergy','URC/Uranium':'Uranium Royalty',
    'SLS/Copper':'Solaris Resources','FIL/Copper':'Filo Mining','NGEX/Copper':'NGEx Resources',
    'TKO/Copper':'Taseko Mines','RBX/Gold':'Robex Resources','SBB/Gold':'Sabina Gold',
  }},
  // More LSE miners
  LSE_EXT: { country: 'GB', exchange: 'LSE', suffix: '.L', cat: 'LONDON_LSE', tickers: {
    'JLP/Diversified':'Jubilee Metals','CAML/Copper':'Central Asia Metals','SRB/Gold':'Serabi Gold',
    'SHG/Gold':'Shanta Gold','CORA/Gold':'Cora Gold','HUM/Gold':'Hummingbird Resources',
    'PAF/Gold':'Pan African Resources','CAY/Gold':'Caledonia Mining','HZM/Nickel':'Horizonte Minerals',
    'SAV/Lithium':'Savannah Resources','EMH/Lithium':'European Metals','ATYM/Copper':'Atalaya Mining',
    'BMN/Vanadium':'Bushveld Minerals','KEFI/Gold':'KEFI Gold','ARS/Copper':'Arc Minerals',
    'BKY/Uranium':'Berkeley Energia','PDL/Diamonds':'Petra Diamonds','KMR/Mineral Sands':'Kenmare',
    'RBW/Rare Earths':'Rainbow Rare Earths','BEM/Iron Ore':'Beowulf Mining',
  }},
  // More US miners
  US_EXT: { country: 'US', exchange: 'NYSE', suffix: '', cat: 'US_LARGE_CAP', tickers: {
    'BTG/Gold':'B2Gold','EGO/Gold':'Eldorado Gold','IAG/Gold':'IAMGOLD','NG/Gold':'NovaGold',
    'SBSW/Platinum':'Sibanye Stillwater','EXK/Silver':'Endeavour Silver','FSM/Silver':'Fortuna Silver',
    'CDE/Silver':'Coeur Mining','ASM/Silver':'Avino Silver','TECK/Diversified':'Teck Resources',
    'MT/Steel':'ArcelorMittal','HCC/Coal':'Warrior Met Coal','AMR/Coal':'Alpha Metallurgical',
    'SQM/Lithium':'SQM','MP/Rare Earths':'MP Materials','LEU/Uranium':'Centrus Energy',
    'DNN/Uranium':'Denison Mines','URG/Uranium':'Ur-Energy','EU/Uranium':'enCore Energy',
    'IPI/Potash':'Intrepid Potash','NRP/Coal':'Natural Resource Partners',
    'DVN/Oil & Gas':'Devon Energy','FANG/Oil & Gas':'Diamondback','MRO/Oil & Gas':'Marathon Oil',
    'APA/Oil & Gas':'APA Corp','HES/Oil & Gas':'Hess','MUR/Oil & Gas':'Murphy Oil',
  }}
};

async function main() {
  let inserted = 0;
  for (const [group, info] of Object.entries(GLOBAL_EXT)) {
    for (const [key, name] of Object.entries(info.tickers)) {
      const [base, commodity] = key.split('/');
      const ticker = base + info.suffix;
      const exists = DB.prepare('SELECT ticker FROM mining_companies WHERE ticker = ?').get(ticker);
      if (exists) continue;

      let mcap = 0;
      try {
        const r = await fetch(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(ticker)}`, {
          headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000)
        });
        if (r.ok) { const d = await r.json(); mcap = d?.quoteResponse?.result?.[0]?.marketCap || 0; }
      } catch {}

      try {
        insertMining.run(ticker, name, info.exchange, info.country, commodity || 'Diversified', classifyStage(mcap), mcap);
        insertSym.run(ticker, name, info.cat, info.exchange);
        inserted++;
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    console.log(`  ${group}: done`);
  }
  console.log(`\nInserted: ${inserted}`);
  const total = DB.prepare('SELECT COUNT(*) as n FROM mining_companies').get();
  console.log('Total mining companies:', total.n);
  DB.close();
}
main().catch(console.error);
