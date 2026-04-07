/**
 * Finnhub adapter — free tier, 60 req/min, no credit card.
 * Get key: https://finnhub.io/register
 */
const FH_BASE = 'https://finnhub.io/api/v1';
const KEY = process.env.FINNHUB_API_KEY;

async function fhFetch(endpoint, params = {}) {
  if (!KEY) throw new Error('FINNHUB_API_KEY not set');
  const url = new URL(FH_BASE + endpoint);
  url.searchParams.set('token', KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`Finnhub ${r.status}`);
  return r.json();
}

export async function getMetrics(symbol) {
  const d = await fhFetch('/stock/metric', { symbol, metric: 'all' });
  return d?.metric || {};
}

export async function getEarningsSurprises(symbol) {
  return fhFetch('/stock/earnings', { symbol });
}

export async function getCompanyNews(symbol, from, to) {
  return fhFetch('/company-news', { symbol, from, to });
}

export async function getRecommendations(symbol) {
  return fhFetch('/stock/recommendation', { symbol });
}

export async function getPriceTarget(symbol) {
  return fhFetch('/stock/price-target', { symbol });
}

export function isAvailable() { return !!KEY; }
