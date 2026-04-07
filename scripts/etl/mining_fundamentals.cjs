// Enrich mining companies with Yahoo fundamentals (additive updates only)
const Database = require('better-sqlite3');
const DB = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');

// Add columns if missing (idempotent)
const cols = ['pe_ratio REAL','eps REAL','dividend_yield REAL','beta REAL','book_value REAL',
  'profit_margin REAL','revenue REAL','sector_yahoo TEXT','industry_yahoo TEXT',
  'employees INTEGER','country_hq TEXT'];
for (const col of cols) {
  try { DB.exec('ALTER TABLE mining_companies ADD COLUMN ' + col); } catch {}
}

const update = DB.prepare(`
  UPDATE mining_companies SET pe_ratio=?, eps=?, dividend_yield=?, beta=?, book_value=?,
    profit_margin=?, revenue=?, sector_yahoo=?, industry_yahoo=?, employees=?, country_hq=?,
    market_cap_aud=COALESCE(NULLIF(?,0),market_cap_aud), fetched_at=CURRENT_TIMESTAMP
  WHERE ticker=?
`);

async function main() {
  const tickers = DB.prepare('SELECT ticker FROM mining_companies').all().map(r => r.ticker);
  console.log('Enriching', tickers.length, 'miners with fundamentals...');
  let ok = 0, fail = 0;

  for (let i = 0; i < tickers.length; i++) {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(tickers[i])}?modules=summaryDetail,defaultKeyStatistics,financialData,assetProfile,price`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000)
      });
      if (r.ok) {
        const d = await r.json();
        const res = d?.quoteSummary?.result?.[0];
        if (res) {
          const sd = res.summaryDetail || {}, ks = res.defaultKeyStatistics || {};
          const fd = res.financialData || {}, ap = res.assetProfile || {}, pr = res.price || {};
          update.run(
            sd.trailingPE?.raw || ks.trailingPE?.raw || null,
            ks.trailingEps?.raw || null, sd.dividendYield?.raw || null,
            ks.beta?.raw || null, ks.bookValue?.raw || null,
            fd.profitMargins?.raw || null, fd.totalRevenue?.raw || null,
            ap.sector || null, ap.industry || null,
            ap.fullTimeEmployees || null, ap.country || null,
            pr.marketCap?.raw || 0, tickers[i]
          );
          ok++;
        }
      }
    } catch { fail++; }
    if (i % 50 === 0) process.stdout.write(`\r${i + 1}/${tickers.length} OK:${ok} FAIL:${fail}`);
    await new Promise(r => setTimeout(r, 250));
  }

  console.log(`\nEnriched: ${ok}, Failed: ${fail}`);
  const cov = DB.prepare('SELECT SUM(CASE WHEN pe_ratio IS NOT NULL THEN 1 ELSE 0 END) as pe, SUM(CASE WHEN sector_yahoo IS NOT NULL THEN 1 ELSE 0 END) as sec, COUNT(*) as total FROM mining_companies').get();
  console.log('Coverage: P/E:', cov.pe + '/' + cov.total, '| Sector:', cov.sec + '/' + cov.total);
  DB.close();
}
main().catch(console.error);
