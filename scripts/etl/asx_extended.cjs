// Extended ASX mining tickers beyond the original 112
// All manually verified ASX miners not in the initial list
const Database = require('better-sqlite3');
const DB = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
DB.pragma('journal_mode = WAL');

const insertMining = DB.prepare(`INSERT OR IGNORE INTO mining_companies (ticker, name, exchange, country, primary_commodity, stage, market_cap_aud, data_source) VALUES (?, ?, 'ASX', 'AU', ?, ?, ?, 'asx_extended')`);
const insertSym = DB.prepare(`INSERT OR IGNORE INTO symbols (ticker, name, category, asset_class, exchange) VALUES (?, ?, 'ASX_MINING', 'equity', 'ASX')`);

function classifyStage(mcap) {
  if (!mcap || mcap < 5e6) return 'Shell'; if (mcap < 50e6) return 'Explorer';
  if (mcap < 250e6) return 'Developer'; if (mcap < 2e9) return 'Producer (Mid)';
  return 'Producer (Major)';
}

// Extended ASX miners organized by commodity
const EXTENDED = {
  'Gold': ['RMS','GCY','MML','GNX','AQX','OBM','FAU','PCK','NML','SVT','PSC','MAT','ASM','AIV','BDC','GBZ','GML','APC','SSR','TG6','M24','MEI','BCN','ADT','TRY','RXL','TBA','DGO','BCD','MKR','GTE','NXS','GLN','AAR','BRR','DYL','CAE','VRX','A8G','IRD','CTP','DCM','EXR','GAL','VIC','AIS','WMG','PHL'],
  'Lithium': ['PLS','AKE','LTR','CXO','GL1','LKE','VUL','AGY','SYA','EMH','LRS','ASN','LEL','FFX','LLL','LPD','TYX','INR','LIT','PSC','PMT','ESS','AVZ','CDT','NVX','GN8','MVL','AZL','MLS','CYM','NMT','PCL','ASS','IXR','LI3','LIS','MRC','AZS','RDT'],
  'Copper': ['SFR','29M','HCH','AIS','C29','MAC','CMR','XAM','RDM','CYM','AUC','OD6','CUE','OXX','LOT','BHP','RIO','STO','MGA','OZL'],
  'Nickel': ['WSA','MCR','POS','CTM','PAN','GAL','BSX','LNR','CZR','TNG','C6C','MNB','NIS','NKL','NIC','MN8','HMX','CMM','ARN','MEU'],
  'Uranium': ['PDN','BOE','DYL','LOT','BMN','EL8','AGE','DEV','HAR','BSN','ALX','URM','TOE','SLX','GTR','PEN','ACB','VMY','NXG','92E','MHC','ERA','VAL','KNI','DLC','THR','EME','CUP'],
  'Rare Earths': ['LYC','ARU','ARR','VML','HAS','RNU','PEK','MLX','ABX','REE','IXR','ASM','NTU','OAR','ATC','RR1','HRE','MEQ'],
  'Coal': ['WHC','NHC','YAL','BRL','BCB','TER','AQC','SMR','JAL','CRN','MCC'],
  'Iron Ore': ['FMG','MGX','GRR','TI1','CIA','MAU','MMI','HAV','FEX','MGT','IRD','ACS','ADY','AIR','VMS','ABC','GEN','DCN','RHI'],
  'Zinc': ['PEM','TZN','ROM','HZR','AKM','RUM','KZR','TGM','GGG','VMC','CDT','ZMI','NML'],
  'Silver': ['SVL','SIH'],
  'Oil & Gas': ['WDS','STO','ORG','BPT','KAR','CVN','SXY','HZN','AKM','EMR','RNE','EOL','SEN','WEL','BRK','AMO','INP','ADX','GAP','BUR','NBR','GDY','UNI','NRD','TAO','MNY'],
  'Cobalt': ['COB','SGQ','ACR','TMT','C6C','GEL','JVS'],
  'Graphite': ['SYR','EGR','TLG','MNS','BAT','EV1','HXG','BKT','MBC','TNG','BMG','TEL'],
  'Vanadium': ['VR8','TNG','AVL','KIN'],
  'Mineral Sands': ['ILU','MZZ','STK','BCL','MRL','KMS','DRX','SYR','ACF','STI','WAK'],
  'Manganese': ['JMS','MNM','OMH','EMN','FME'],
  'PGMs': ['CZN','S32','CHN'],
  'Potash/Phosphate': ['SO4','HPR','MMP','APC','BCI','KLL','EME','RNU'],
  'Tin': ['TIN','MLT','KAS'],
  'Tungsten': ['MLX','KNB'],
  'Diamonds': ['AKI','LCT','MER','NVA'],
  'Antimony': ['SAM','LAR','VTI'],
  'Aluminium': ['AWC','S32','CAP'],
  'Helium': ['HE8','RLT','NOB'],
  'Hydrogen': ['FMG','PRL','PH2','H2G','QUE'],
};

async function main() {
  console.log('Extended ASX mining tickers (additive)...\n');
  let inserted = 0, skipped = 0;

  for (const [commodity, tickers] of Object.entries(EXTENDED)) {
    for (const base of tickers) {
      const ticker = base + '.AX';
      // Skip if already in mining_companies
      const exists = DB.prepare('SELECT ticker FROM mining_companies WHERE ticker = ?').get(ticker);
      if (exists) { skipped++; continue; }

      // Fetch from Yahoo for name + mcap
      let name = base, mcap = 0;
      try {
        const r = await fetch(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ticker}`, {
          headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000)
        });
        if (r.ok) {
          const d = await r.json();
          const q = d?.quoteResponse?.result?.[0];
          if (q) { name = q.longName || q.shortName || base; mcap = q.marketCap || 0; }
        }
      } catch {}

      const stage = classifyStage(mcap);
      try {
        insertMining.run(ticker, name, commodity, stage, mcap);
        insertSym.run(ticker, name);
        inserted++;
      } catch {}

      if (inserted % 25 === 0 && inserted > 0) process.stdout.write(`\r  ${commodity}: +${inserted} (skip:${skipped})`);
      await new Promise(r => setTimeout(r, 200));
    }
    console.log(`  ${commodity.padEnd(20)} done`);
  }

  console.log(`\nInserted: ${inserted}, Skipped: ${skipped}`);
  const total = DB.prepare("SELECT COUNT(*) as n FROM mining_companies WHERE exchange='ASX'").get();
  console.log('Total ASX miners:', total.n);

  const byCom = DB.prepare("SELECT primary_commodity, COUNT(*) as n FROM mining_companies WHERE exchange='ASX' GROUP BY primary_commodity ORDER BY n DESC").all();
  console.log('\nASX by commodity:');
  byCom.forEach(c => console.log('  ' + (c.primary_commodity || '?').padEnd(22) + c.n));
  DB.close();
}
main().catch(console.error);
