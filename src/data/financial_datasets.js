/**
 * Financial Datasets API adapter
 * Docs: https://docs.financialdatasets.ai
 *
 * Fills gaps Yahoo can't: fundamentals, insider trades, SEC filings,
 * earnings, news. Free tier: ~1yr prices, full fundamentals.
 */

const API_BASE = 'https://api.financialdatasets.ai';
const API_KEY = process.env.FINANCIAL_DATASETS_API_KEY;

async function fdFetch(endpoint, params = {}) {
  if (!API_KEY) throw new Error('FINANCIAL_DATASETS_API_KEY not set');
  const url = new URL(API_BASE + endpoint);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { 'X-API-KEY': API_KEY },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`FD ${res.status}: ${body.slice(0, 100)}`);
  }
  return res.json();
}

// OHLCV bars — free tier: from 2025-04-07 onward (~1yr)
export async function getPrices(ticker, days = 365) {
  const end = new Date(Date.now() - 86400000).toISOString().split('T')[0]; // yesterday
  const start = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
  const data = await fdFetch('/prices/', {
    ticker, interval: 'day', interval_multiplier: 1, start_date: start, end_date: end
  });
  return (data.prices || []).map(p => ({
    time: Math.floor(new Date(p.time).getTime() / 1000),
    open: p.open, high: p.high, low: p.low, close: p.close, volume: p.volume || 0
  }));
}

// Income statements
export async function getIncomeStatements(ticker, period = 'quarterly', limit = 8) {
  const data = await fdFetch('/financials/income-statements/', { ticker, period, limit });
  return data.income_statements || [];
}

// Balance sheets
export async function getBalanceSheets(ticker, period = 'quarterly', limit = 8) {
  const data = await fdFetch('/financials/balance-sheets/', { ticker, period, limit });
  return data.balance_sheets || [];
}

// Cash flow statements
export async function getCashFlowStatements(ticker, period = 'quarterly', limit = 8) {
  const data = await fdFetch('/financials/cash-flow-statements/', { ticker, period, limit });
  return data.cash_flow_statements || [];
}

// Insider trades — smart money signal
export async function getInsiderTrades(ticker, limit = 50) {
  const data = await fdFetch('/insider-trades/', { ticker, limit });
  return data.insider_trades || [];
}

// SEC filings — catch 8-K material events
export async function getSecFilings(ticker, limit = 20) {
  const data = await fdFetch('/filings/', { ticker, limit });
  return data.filings || [];
}

// Earnings — returns single latest earnings object
export async function getEarnings(ticker) {
  const data = await fdFetch('/earnings/', { ticker });
  return data.earnings || null;
}

// Crypto prices
export async function getCryptoPrices(ticker, days = 365) {
  const end = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const start = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
  const data = await fdFetch('/crypto/prices/', {
    ticker, interval: 'day', interval_multiplier: 1, start_date: start, end_date: end
  });
  return (data.prices || []).map(p => ({
    time: Math.floor(new Date(p.time).getTime() / 1000),
    open: p.open, high: p.high, low: p.low, close: p.close, volume: p.volume || 0
  }));
}

export function isAvailable() {
  return !!API_KEY;
}
