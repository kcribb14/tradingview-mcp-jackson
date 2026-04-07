const Database = require('better-sqlite3');
const DB_PATH = process.env.HOME + '/.tradingview-mcp/db/fg.db';
const UA = process.env.SEC_USER_AGENT || 'FGScanner kierancribb@example.com';
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const insertFiling = db.prepare('INSERT OR REPLACE INTO filings (accession, ticker, filing_type, filing_date, url, description) VALUES (?, ?, ?, ?, ?, ?)');
const insertInsider = db.prepare('INSERT OR REPLACE INTO insider_trades (id, ticker, filed_at, source) VALUES (?, ?, ?, ?)');
const insertFund = db.prepare('INSERT OR REPLACE INTO fundamentals (ticker, period_end, period_type, revenue, net_income, total_assets, total_liabilities, equity, eps, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');

let CIK_MAP = null;
async function loadCIKMap() {
  if (CIK_MAP) return CIK_MAP;
  const r = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: { 'User-Agent': UA } });
  CIK_MAP = {};
  for (const v of Object.values(await r.json())) CIK_MAP[v.ticker] = String(v.cik_str).padStart(10, '0');
  return CIK_MAP;
}

async function processTicker(ticker) {
  const map = await loadCIKMap();
  const cik = map[ticker.toUpperCase()];
  if (!cik) return { skipped: true };

  const subRes = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (!subRes?.ok) return {};
  const sub = await subRes.json();
  const recent = sub.filings?.recent;

  let filings = 0, insider = 0;
  const batchFilings = db.transaction(() => {
    for (let i = 0; i < (recent?.form?.length || 0); i++) {
      const form = recent.form[i], acc = recent.accessionNumber[i];
      if (['10-K','10-Q','8-K'].includes(form)) {
        insertFiling.run(acc, ticker, form, recent.filingDate[i],
          `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${acc.replace(/-/g,'')}/${recent.primaryDocument[i]}`,
          recent.primaryDocDescription[i] || '');
        filings++;
      } else if (form === '4') {
        insertInsider.run(acc, ticker, recent.filingDate[i], 'sec_edgar');
        insider++;
      }
    }
  });
  batchFilings();

  await new Promise(r => setTimeout(r, 200));
  const factsRes = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (factsRes?.ok) {
    const facts = await factsRes.json();
    const ug = facts.facts?.['us-gaap'] || {};
    const gl = (c, u = 'USD') => { const d = ug[c]?.units?.[u]; return d?.length ? [...d].sort((a,b) => new Date(b.end) - new Date(a.end))[0] : null; };
    const rev = gl('Revenues') || gl('RevenueFromContractWithCustomerExcludingAssessedTax');
    const ni = gl('NetIncomeLoss');
    if (rev || ni) {
      insertFund.run(ticker, rev?.end || ni?.end, 'quarterly',
        rev?.val, ni?.val, gl('Assets')?.val, gl('Liabilities')?.val,
        gl('StockholdersEquity')?.val, gl('EarningsPerShareBasic', 'USD/shares')?.val, 'sec_edgar');
    }
  }
  return { filings, insider };
}

async function main() {
  const us = db.prepare("SELECT ticker FROM symbols WHERE category IN ('US_LARGE_CAP','US_MID_SMALL') ORDER BY ticker").all().map(r => r.ticker);
  console.log('SEC ETL:', us.length, 'US stocks');
  for (let i = 0; i < us.length; i++) {
    try { await processTicker(us[i]); } catch {}
    if (i % 25 === 0) process.stdout.write(`\r${i+1}/${us.length}`);
    await new Promise(r => setTimeout(r, 150));
  }
  const s = db.prepare('SELECT COUNT(*) as f FROM filings').get();
  const ins = db.prepare('SELECT COUNT(*) as i FROM insider_trades').get();
  const fund = db.prepare('SELECT COUNT(*) as f FROM fundamentals').get();
  console.log(`\nDone: ${s.f} filings, ${ins.i} insider trades, ${fund.f} fundamentals`);
}
main().catch(console.error).finally(() => db.close());
