'use strict';
// Enrich ALL mining companies missing fundamentals via yahoo-finance2
// Uses .cjs (CommonJS) — require() throughout
const Database = require('better-sqlite3');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const DB_PATH = process.env.HOME + '/.tradingview-mcp/db/fg.db';
const DB = new Database(DB_PATH);

// Ensure all columns exist (idempotent)
const extraCols = [
  'pe_ratio REAL', 'eps REAL', 'dividend_yield REAL', 'beta REAL',
  'book_value REAL', 'profit_margin REAL', 'revenue REAL',
  'sector_yahoo TEXT', 'industry_yahoo TEXT',
  'employees INTEGER', 'country_hq TEXT',
  'market_cap_aud REAL'
];
for (const col of extraCols) {
  try { DB.exec('ALTER TABLE mining_companies ADD COLUMN ' + col); } catch (_) {}
}

// Prepared update — only overwrites a field if the new value is non-null
const updateStmt = DB.prepare(`
  UPDATE mining_companies SET
    pe_ratio      = COALESCE(?, pe_ratio),
    eps           = COALESCE(?, eps),
    dividend_yield= COALESCE(?, dividend_yield),
    beta          = COALESCE(?, beta),
    book_value    = COALESCE(?, book_value),
    profit_margin = COALESCE(?, profit_margin),
    revenue       = COALESCE(?, revenue),
    sector_yahoo  = COALESCE(?, sector_yahoo),
    industry_yahoo= COALESCE(?, industry_yahoo),
    employees     = COALESCE(?, employees),
    country_hq    = COALESCE(?, country_hq),
    market_cap_aud= COALESCE(NULLIF(?,0), market_cap_aud),
    fetched_at    = CURRENT_TIMESTAMP
  WHERE ticker = ?
`);

// Build the Yahoo Finance symbol for a row.
// If the stored ticker already has a dot (suffix already embedded), use it as-is.
// Otherwise append the exchange-based suffix.
const EXCHANGE_SUFFIX = {
  ASX: '.AX',
  TSX: '.TO',
  LSE: '.L',
  JSE: '.JO',
};

function toYahooSymbol(ticker, exchange) {
  if (ticker.includes('.')) return ticker;        // already has suffix
  const suffix = EXCHANGE_SUFFIX[exchange] || ''; // NYSE/NASDAQ/etc — no suffix
  return ticker + suffix;
}

function safeNum(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'object' ? (v.raw ?? v) : v;
  return typeof n === 'number' && isFinite(n) ? n : null;
}

async function enrichOne(ticker, exchange) {
  const symbol = toYahooSymbol(ticker, exchange);
  const result = await yahooFinance.quoteSummary(symbol, {
    modules: ['summaryDetail', 'defaultKeyStatistics', 'financialData', 'assetProfile', 'price'],
  }, { validateResult: false });

  const sd = result.summaryDetail || {};
  const ks = result.defaultKeyStatistics || {};
  const fd = result.financialData || {};
  const ap = result.assetProfile || {};
  const pr = result.price || {};

  const pe       = safeNum(sd.trailingPE) ?? safeNum(ks.trailingPE);
  const eps      = safeNum(ks.trailingEps);
  const divYield = safeNum(sd.dividendYield);
  const beta     = safeNum(ks.beta);
  const bookVal  = safeNum(ks.bookValue);
  const margin   = safeNum(fd.profitMargins);
  const revenue  = safeNum(fd.totalRevenue);
  const sector   = ap.sector || null;
  const industry = ap.industry || null;
  const employees= ap.fullTimeEmployees || null;
  const country  = ap.country || null;
  const mcap     = safeNum(pr.marketCap) || safeNum(sd.marketCap);

  updateStmt.run(
    pe, eps, divYield, beta, bookVal, margin, revenue,
    sector, industry, employees, country,
    mcap,
    ticker  // WHERE clause uses the original stored ticker
  );

  return { pe, eps, revenue, beta, sector, symbol };
}

async function main() {
  const rows = DB.prepare(`
    SELECT ticker, exchange FROM mining_companies
    WHERE pe_ratio IS NULL OR eps IS NULL OR revenue IS NULL
       OR beta IS NULL OR sector_yahoo IS NULL OR industry_yahoo IS NULL
    ORDER BY exchange, ticker
  `).all();

  const total = rows.length;
  console.log(`Enriching ${total} mining companies with Yahoo Finance fundamentals...`);
  console.log('');

  const BATCH = 5;
  const DELAY_MS = 500;

  let updated = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);

    await Promise.allSettled(
      batch.map(async ({ ticker, exchange }) => {
        try {
          const r = await enrichOne(ticker, exchange);
          updated++;
          const idx = i + batch.indexOf(batch.find(b => b.ticker === ticker)) + 1;
          const peStr   = r.pe      != null ? r.pe.toFixed(1)    : 'n/a';
          const epsStr  = r.eps     != null ? r.eps.toFixed(3)   : 'n/a';
          const revStr  = r.revenue != null ? (r.revenue / 1e6).toFixed(1) + 'M' : 'n/a';
          const betaStr = r.beta    != null ? r.beta.toFixed(2)  : 'n/a';
          const secStr  = r.sector  || 'n/a';
          console.log(`${idx}/${total} - ${ticker} (${r.symbol}): pe=${peStr} eps=${epsStr} rev=${revStr} beta=${betaStr} sector=${secStr}`);
        } catch (err) {
          skipped++;
          const sym = toYahooSymbol(ticker, exchange);
          console.log(`  SKIP ${ticker} (${sym}): ${err.message?.split('\n')[0]}`);
        }
      })
    );

    if (i + BATCH < rows.length) {
      await new Promise(res => setTimeout(res, DELAY_MS));
    }
  }

  console.log('');
  console.log('════════════════════════════════════════');
  console.log(`DONE: ${updated} updated, ${skipped} skipped / ${total} total`);

  // Coverage report
  const cov = DB.prepare(`
    SELECT
      SUM(CASE WHEN pe_ratio IS NOT NULL THEN 1 ELSE 0 END)      AS pe,
      SUM(CASE WHEN eps IS NOT NULL THEN 1 ELSE 0 END)           AS eps,
      SUM(CASE WHEN revenue IS NOT NULL THEN 1 ELSE 0 END)       AS rev,
      SUM(CASE WHEN beta IS NOT NULL THEN 1 ELSE 0 END)          AS beta,
      SUM(CASE WHEN sector_yahoo IS NOT NULL THEN 1 ELSE 0 END)  AS sector,
      COUNT(*) AS total
    FROM mining_companies
  `).get();

  console.log(`Coverage after run:`);
  console.log(`  P/E:     ${cov.pe}/${cov.total}`);
  console.log(`  EPS:     ${cov.eps}/${cov.total}`);
  console.log(`  Revenue: ${cov.rev}/${cov.total}`);
  console.log(`  Beta:    ${cov.beta}/${cov.total}`);
  console.log(`  Sector:  ${cov.sector}/${cov.total}`);
  console.log('════════════════════════════════════════');

  DB.close();
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
