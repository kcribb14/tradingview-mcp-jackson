// 1h price ETL — Yahoo allows 730 days of 1h data. Priority tickers only.
const Database = require('better-sqlite3');
const DB = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
DB.pragma('journal_mode = WAL');

const insert = DB.prepare('INSERT OR IGNORE INTO prices_1h (ticker, ts, open, high, low, close, volume, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

async function fetch1h(ticker) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - 730 * 86400;
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${start}&period2=${now}&interval=1h`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) return [];
    const d = await r.json();
    const result = d?.chart?.result?.[0];
    if (!result?.timestamp) return [];
    const q = result.indicators.quote[0];
    const bars = [];
    for (let i = 0; i < result.timestamp.length; i++) {
      if (q.close?.[i] > 0) bars.push({ ts: result.timestamp[i], o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume?.[i] || 0 });
    }
    return bars;
  } catch { return []; }
}

async function main() {
  // Priority: liquid tickers where 1h matters
  const priority = [
    // Crypto majors
    'BTC-USD','ETH-USD','SOL-USD','BNB-USD','XRP-USD','ADA-USD','DOGE-USD',
    // US large cap
    'AAPL','MSFT','GOOGL','AMZN','NVDA','TSLA','META','JPM','V','JNJ',
    // Key ETFs
    'SPY','QQQ','IWM','GLD','SLV','TLT','USO','XLE','XLF','XLK',
    // Forex majors + AUD
    'EURUSD=X','GBPUSD=X','USDJPY=X','AUDUSD=X','USDCAD=X','NZDUSD=X','USDCHF=X',
    'AUDJPY=X','AUDNZD=X','AUDCAD=X',
    // Commodities
    'GC=F','SI=F','CL=F','HG=F','NG=F','PL=F',
    // ASX majors
    'BHP.AX','RIO.AX','FMG.AX','CSL.AX','CBA.AX','NAB.AX','WBC.AX','NST.AX','EVN.AX','PLS.AX',
    // DXY
    'DX-Y.NYB'
  ];

  console.log('1h ETL for', priority.length, 'priority tickers (730 days)');
  let ok = 0, fail = 0, totalBars = 0;

  for (let i = 0; i < priority.length; i++) {
    const t = priority[i];
    // Check existing
    const existing = DB.prepare('SELECT MAX(ts) as latest FROM prices_1h WHERE ticker = ?').get(t);

    const bars = await fetch1h(t);
    if (bars.length > 0) {
      const tx = DB.transaction(() => {
        for (const b of bars) insert.run(t, b.ts, b.o, b.h, b.l, b.c, b.v, 'yahoo');
      });
      tx();
      ok++; totalBars += bars.length;
    } else { fail++; }

    process.stdout.write(`\r${i + 1}/${priority.length} ${t.padEnd(12)} +${bars.length} | OK:${ok} FAIL:${fail} total:${totalBars}`);
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n');
  const stats = DB.prepare('SELECT COUNT(*) as n, COUNT(DISTINCT ticker) as t FROM prices_1h').get();
  console.log('1h DB:', stats.n.toLocaleString(), 'bars,', stats.t, 'tickers');
  DB.close();
}
main().catch(console.error);
