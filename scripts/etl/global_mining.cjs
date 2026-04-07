const Database = require('better-sqlite3');
const DB = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
DB.pragma('journal_mode = WAL');

const insertMining = DB.prepare(`INSERT OR IGNORE INTO mining_companies (ticker, name, exchange, country, primary_commodity, stage, market_cap_aud, data_source) VALUES (?, ?, ?, ?, ?, ?, ?, 'curated_global')`);
const insertSym = DB.prepare(`INSERT OR IGNORE INTO symbols (ticker, name, category, asset_class, exchange) VALUES (?, ?, ?, 'equity', ?)`);

const MINERS = {
  TSX: { country: 'CA', suffix: '.TO', cat: 'CANADA_TSX', tickers: {
    'ABX':'Barrick Gold/Gold','AEM':'Agnico Eagle/Gold','FNV':'Franco-Nevada/Gold (Royalty)',
    'WPM':'Wheaton Precious/Silver (Streaming)','K':'Kinross Gold/Gold','AGI':'Alamos Gold/Gold',
    'LUN':'Lundin Mining/Copper','FM':'First Quantum/Copper','HBM':'Hudbay/Copper',
    'CCO':'Cameco/Uranium','NXE':'NexGen Energy/Uranium','ERO':'Ero Copper/Copper',
    'CS':'Capstone Copper/Copper','PAAS':'Pan American Silver/Silver',
    'LAC':'Lithium Americas/Lithium','OR':'Osisko Royalties/Gold (Royalty)',
    'OGC':'OceanaGold/Gold','TXG':'Torex Gold/Gold'
  }},
  LSE: { country: 'GB', suffix: '.L', cat: 'LONDON_LSE', tickers: {
    'AAL':'Anglo American/Diversified','GLEN':'Glencore/Diversified',
    'ANTO':'Antofagasta/Copper','FRES':'Fresnillo/Silver',
    'CEY':'Centamin/Gold','EDV':'Endeavour Mining/Gold','GGP':'Greatland Gold/Gold',
    'YCA':'Yellow Cake/Uranium','HOC':'Hochschild Mining/Silver',
    'ECOR':'Ecora Resources/Royalty'
  }},
  JSE: { country: 'ZA', suffix: '.JO', cat: 'SOUTH_AFRICA', tickers: {
    'AGL':'Anglo American/Diversified','ANG':'AngloGold Ashanti/Gold','GFI':'Gold Fields/Gold',
    'HAR':'Harmony Gold/Gold','IMP':'Impala Platinum/Platinum','SSW':'Sibanye-Stillwater/Platinum',
    'EXX':'Exxaro Resources/Coal','KIO':'Kumba Iron Ore/Iron Ore'
  }},
  NYSE: { country: 'US', suffix: '', cat: 'US_LARGE_CAP', tickers: {
    'NEM':'Newmont/Gold','GOLD':'Barrick Gold/Gold','FCX':'Freeport-McMoRan/Copper',
    'SCCO':'Southern Copper/Copper','VALE':'Vale/Iron Ore','CLF':'Cleveland-Cliffs/Iron Ore',
    'ALB':'Albemarle/Lithium','CCJ':'Cameco/Uranium','UEC':'Uranium Energy/Uranium',
    'UUUU':'Energy Fuels/Uranium','MOS':'Mosaic/Potash','NUE':'Nucor/Steel',
    'BTU':'Peabody Energy/Coal','HL':'Hecla Mining/Silver','AG':'First Majestic/Silver'
  }}
};

async function main() {
  let inserted = 0;
  for (const [exchange, info] of Object.entries(MINERS)) {
    for (const [base, desc] of Object.entries(info.tickers)) {
      const [name, commodity] = desc.split('/');
      const ticker = base + info.suffix;
      const stage = ['Anglo','Glencore','Rio','BHP','Newmont','Barrick','Freeport','Vale','Cameco','Albemarle','Nucor'].some(m => name.includes(m)) ? 'Producer (Major)' : 'Producer (Mid)';
      try {
        const r = DB.prepare('SELECT ticker FROM mining_companies WHERE ticker = ?').get(ticker);
        if (!r) {
          insertMining.run(ticker, name, exchange, info.country, commodity || 'Diversified', stage, 0);
          insertSym.run(ticker, name, info.cat);
          inserted++;
        }
      } catch {}
    }
    console.log(`  ${exchange}: done`);
  }
  console.log(`Global: ${inserted} new miners added. Total: ${DB.prepare('SELECT COUNT(*) as n FROM mining_companies').get().n}`);
  DB.close();
}
main().catch(console.error);
