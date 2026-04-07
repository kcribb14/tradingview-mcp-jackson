/**
 * SEC EDGAR adapter — completely free, official source.
 * Docs: https://www.sec.gov/edgar/sec-api-documentation
 * No API key required. Just User-Agent with email.
 */
const EDGAR_BASE = 'https://data.sec.gov';
const UA = process.env.SEC_USER_AGENT || 'FGScanner kierancribb@example.com';

async function edgarFetch(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) throw new Error(`EDGAR ${r.status}`);
  return r.json();
}

let CIK_MAP = null;
async function loadCIKMap() {
  if (CIK_MAP) return CIK_MAP;
  const r = await fetch('https://www.sec.gov/files/company_tickers.json', {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(15000)
  });
  const d = await r.json();
  CIK_MAP = {};
  for (const v of Object.values(d)) {
    CIK_MAP[v.ticker] = String(v.cik_str).padStart(10, '0');
  }
  return CIK_MAP;
}

async function getCIK(ticker) {
  const map = await loadCIKMap();
  return map[ticker.toUpperCase()];
}

export async function getSubmissions(ticker) {
  const cik = await getCIK(ticker);
  if (!cik) return null;
  return edgarFetch(`${EDGAR_BASE}/submissions/CIK${cik}.json`);
}

export async function getFilings(ticker, types = ['10-K', '10-Q', '8-K']) {
  const sub = await getSubmissions(ticker);
  if (!sub?.filings?.recent) return [];
  const recent = sub.filings.recent;
  const filings = [];
  for (let i = 0; i < recent.form.length && filings.length < 20; i++) {
    if (types.includes(recent.form[i])) {
      filings.push({
        type: recent.form[i],
        date: recent.filingDate[i],
        url: `https://www.sec.gov/Archives/edgar/data/${parseInt(sub.cik)}/${recent.accessionNumber[i].replace(/-/g, '')}/${recent.primaryDocument[i]}`,
        description: recent.primaryDocDescription[i] || ''
      });
    }
  }
  return filings;
}

export async function getInsiderTrades(ticker, limit = 30) {
  const sub = await getSubmissions(ticker);
  if (!sub?.filings?.recent) return [];
  const recent = sub.filings.recent;
  const trades = [];
  for (let i = 0; i < recent.form.length && trades.length < limit; i++) {
    if (recent.form[i] === '4') {
      trades.push({
        date: recent.filingDate[i],
        url: `https://www.sec.gov/Archives/edgar/data/${parseInt(sub.cik)}/${recent.accessionNumber[i].replace(/-/g, '')}/`,
      });
    }
  }
  return trades;
}

export async function getCompanyFacts(ticker) {
  const cik = await getCIK(ticker);
  if (!cik) return null;
  return edgarFetch(`${EDGAR_BASE}/api/xbrl/companyfacts/CIK${cik}.json`);
}

export async function getFundamentals(ticker) {
  const facts = await getCompanyFacts(ticker);
  if (!facts) return null;
  const usGaap = facts.facts?.['us-gaap'] || {};

  const latest = (concept, unit = 'USD') => {
    const data = usGaap[concept]?.units?.[unit];
    if (!data || data.length === 0) return null;
    const sorted = [...data].sort((a, b) => new Date(b.end) - new Date(a.end));
    return sorted[0];
  };

  const revenue = latest('Revenues') || latest('RevenueFromContractWithCustomerExcludingAssessedTax');
  const netIncome = latest('NetIncomeLoss');
  const assets = latest('Assets');
  const liabilities = latest('Liabilities');
  const equity = latest('StockholdersEquity');
  const cash = latest('CashAndCashEquivalentsAtCarryingValue');
  const eps = latest('EarningsPerShareBasic', 'USD/shares');

  return {
    ticker, name: facts.entityName,
    revenue: revenue?.val, revenueDate: revenue?.end,
    netIncome: netIncome?.val,
    assets: assets?.val, liabilities: liabilities?.val, equity: equity?.val,
    cash: cash?.val, eps: eps?.val,
    profitable: (netIncome?.val || 0) > 0,
    debtToEquity: equity?.val ? (liabilities?.val / equity?.val) : null
  };
}

export function isAvailable() { return true; } // No key needed
