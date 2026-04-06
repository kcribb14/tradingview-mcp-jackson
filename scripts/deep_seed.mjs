// Computes FULL F&G history from range=max OHLCV for key symbols in each sector
// This gives 2-10 years of fgHistory for the sector comparison chart

import fs from 'fs';

const BASE = 'http://localhost:3000';
const CACHE_PATH = process.env.HOME + '/.tradingview-mcp/cache/fg_scores.json';

// Representative symbols per sector — these MUST have long history
const SECTOR_REPS = {
  'Crypto': ['BTC','ETH','SOL','BNB','XRP','ADA','DOGE','LTC','LINK','AVAX'],
  'US Stocks': ['AAPL','MSFT','GOOGL','AMZN','TSLA','NVDA','META','JPM','V','JNJ','SPY','QQQ','DIA'],
  'ASX Mining': ['NST.AX','EVN.AX','BHP.AX','RIO.AX','FMG.AX','RMS.AX','SFR.AX','MIN.AX','S32.AX','IGO.AX'],
  'ASX Blue Chip': ['CBA.AX','CSL.AX','NAB.AX','WBC.AX','WES.AX','MQG.AX','TLS.AX','WOW.AX','COL.AX','QBE.AX'],
  'Commodities': ['GC=F','SI=F','CL=F','HG=F','PL=F','NG=F'],
  'Bonds/Safety': ['TLT','IEF','SHY','AGG','LQD','HYG'],
  'ETFs': ['SPY','QQQ','IWM','GLD','SLV','USO','VNQ','EFA','EEM','XLE','XLF','XLK'],
  'International': ['ABX.TO','GLEN.L','0700.HK','7203.T','RELIANCE.NS','SAP.DE','ANG.JO']
};

async function seedSymbol(sym) {
  try {
    const r = await fetch(BASE + '/api/seed-history/' + encodeURIComponent(sym) + '?force=1', {
      signal: AbortSignal.timeout(30000)
    });
    const d = await r.json();
    return { sym, points: d.historyLength || 0, years: ((d.historyLength || 0) / 365).toFixed(1), skipped: d.skipped };
  } catch(e) {
    return { sym, points: 0, years: '0', error: e.message };
  }
}

async function main() {
  console.log('═══ DEEP F&G HISTORY SEEDER ═══');
  console.log('Computing full F&G time series from range=max OHLCV bars\n');

  const startTime = Date.now();
  let totalSeeded = 0;

  for (const [sector, symbols] of Object.entries(SECTOR_REPS)) {
    console.log(`\n▸ ${sector} (${symbols.length} symbols):`);

    for (const sym of symbols) {
      const result = await seedSymbol(sym);
      if (result.points > 0) {
        console.log(`  ✓ ${sym.padEnd(14)} ${String(result.points).padStart(5)} points (${result.years} yr)${result.skipped ? ' [cached]' : ''}`);
        totalSeeded++;
      } else {
        console.log(`  ✗ ${sym.padEnd(14)} FAILED ${result.error || ''}`);
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }

  const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log(`\n═══ DONE: ${totalSeeded} symbols seeded in ${elapsed} minutes ═══`);

  // Verify the sector comparison will now have deep data
  // Wait for disk write
  await new Promise(r => setTimeout(r, 12000));
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH));
  console.log('\nSector history depth:');
  for (const [sector, symbols] of Object.entries(SECTOR_REPS)) {
    const depths = symbols.map(s => cache[s+':D']?.fgHistory?.length || 0).filter(d => d > 0);
    const avgDepth = depths.length > 0 ? Math.round(depths.reduce((s,v)=>s+v,0) / depths.length) : 0;
    const maxDepth = Math.max(0, ...depths);
    console.log(`  ${sector.padEnd(15)} avg: ${avgDepth} pts (${(avgDepth/365).toFixed(1)}yr) | max: ${maxDepth} pts (${(maxDepth/365).toFixed(1)}yr) | ${depths.length}/${symbols.length} symbols`);
  }
}

main().catch(console.error);
