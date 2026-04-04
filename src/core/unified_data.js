/**
 * Unified crypto data layer — auto-selects best source per symbol.
 *
 * Priority waterfall:
 *   1. Binance  (439 USDT pairs, fastest, most reliable)
 *   2. CryptoCompare (5000+ coins, broadest OHLCV coverage)
 *   3. Yahoo Finance (stocks, ETFs, forex, ~500 crypto)
 *   4. MEXC (2388 pairs, highest small-cap coverage)
 *   5. DexScreener (DEX-only tokens, no OHLCV but has price data)
 *
 * Source mapping is cached so we don't re-discover on every call.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const CACHE_DIR = join(homedir(), '.tradingview-mcp', 'cache');
const SOURCE_MAP_FILE = join(CACHE_DIR, 'source_map.json');

// ─── Source implementations ─────────────────────────────────────────────────

async function fetchJSON(url, timeout = 5000) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    signal: AbortSignal.timeout(timeout),
  });
  if (!resp.ok) return null;
  return resp.json();
}

function normalizeBar(time, o, h, l, c, v) {
  return {
    time: typeof time === 'number' && time > 1e12 ? Math.floor(time / 1000) : time,
    open: Number(o), high: Number(h), low: Number(l), close: Number(c),
    volume: Number(v) || 0,
  };
}

// Binance: [openTime, open, high, low, close, volume, ...]
async function fetchBinance(symbol, bars = 200) {
  let pair = symbol.replace(/[-\/]/g, '').toUpperCase();
  // Ensure USDT suffix for crypto
  if (!pair.endsWith('USDT') && !pair.endsWith('USD') && !pair.endsWith('BTC')) {
    pair = pair + 'USDT';
  }
  const d = await fetchJSON(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d&limit=${bars}`);
  if (!d || !Array.isArray(d) || d.length === 0) return null;
  return d.map(b => normalizeBar(b[0], b[1], b[2], b[3], b[4], b[5]));
}

// CryptoCompare: { Data: { Data: [{ time, open, high, low, close, volumefrom, volumeto }] } }
async function fetchCryptoCompare(symbol, bars = 200) {
  // Handle paired symbols like BTC-USD → fsym=BTC, tsym=USD
  let fsym = symbol.toUpperCase().replace(/-USD$/, '').replace(/USDT$/, '').replace(/USD$/, '');
  const d = await fetchJSON(`https://min-api.cryptocompare.com/data/v2/histoday?fsym=${fsym}&tsym=USD&limit=${bars}`);
  if (!d?.Data?.Data) return null;
  const candles = d.Data.Data.filter(b => b.close > 0);
  if (candles.length === 0) return null;
  return candles.map(b => normalizeBar(b.time, b.open, b.high, b.low, b.close, b.volumeto));
}

// MEXC: same format as Binance [openTime, open, high, low, close, volume, ...]
async function fetchMEXC(symbol, bars = 200) {
  const pair = symbol.replace(/[-\/]/g, '').toUpperCase();
  const d = await fetchJSON(`https://api.mexc.com/api/v3/klines?symbol=${pair}&interval=1d&limit=${bars}`);
  if (!d || !Array.isArray(d) || d.length === 0) return null;
  return d.map(b => normalizeBar(b[0], b[1], b[2], b[3], b[4], b[5]));
}

// Yahoo Finance
async function fetchYahoo(symbol, bars = 200) {
  // Convert to Yahoo format
  let ticker = symbol;
  if (!ticker.includes('-') && !ticker.includes('.') && !ticker.startsWith('^')) {
    // Assume crypto if not a stock-like ticker
    if (ticker.match(/^[A-Z]{2,10}(USD|USDT)?$/i)) {
      const base = ticker.replace(/USD[T]?$/i, '');
      ticker = base + '-USD';
    }
  }
  const d = await fetchJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1y&interval=1d&includePrePost=false`);
  const chart = d?.chart?.result?.[0];
  if (!chart?.timestamp) return null;
  const q = chart.indicators.quote[0];
  const result = [];
  for (let i = 0; i < chart.timestamp.length; i++) {
    if (q.open[i] != null && q.close[i] != null) {
      result.push(normalizeBar(chart.timestamp[i], q.open[i], q.high[i], q.low[i], q.close[i], q.volume[i]));
    }
  }
  return result.length > 0 ? result.slice(-bars) : null;
}

// ─── Source registry ────────────────────────────────────────────────────────

const SOURCES = [
  { name: 'binance', fn: fetchBinance, rateLimit: 1200, symbolFormat: sym => sym.replace(/[-\/]/g, '').toUpperCase() + (sym.match(/USDT?$/i) ? '' : 'USDT') },
  { name: 'cryptocompare', fn: fetchCryptoCompare, rateLimit: 50 },
  { name: 'yahoo', fn: fetchYahoo, rateLimit: 30 },
  { name: 'mexc', fn: fetchMEXC, rateLimit: 500, symbolFormat: sym => sym.replace(/[-\/]/g, '').toUpperCase() + (sym.match(/USDT?$/i) ? '' : 'USDT') },
];

// ─── Source mapping cache ───────────────────────────────────────────────────

function loadSourceMap() {
  try { return JSON.parse(readFileSync(SOURCE_MAP_FILE, 'utf8')); }
  catch { return {}; }
}

function saveSourceMap(map) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(SOURCE_MAP_FILE, JSON.stringify(map));
}

// ─── Unified fetch ──────────────────────────────────────────────────────────

/**
 * Fetch OHLCV bars for a symbol from the best available source.
 * Auto-discovers and caches the source mapping.
 *
 * @param {string} symbol - Token symbol (e.g., "BTC", "BONK", "AAPL")
 * @param {number} bars - Number of daily bars (default 200)
 * @returns {{ bars: Array, source: string, symbol: string }} or null
 */
export async function fetchOhlcv(symbol, bars = 200) {
  const key = symbol.toUpperCase().replace(/[-\/]USD[T]?$/i, '');
  const sourceMap = loadSourceMap();

  // If we have a cached source, try it first
  if (sourceMap[key]) {
    const cached = SOURCES.find(s => s.name === sourceMap[key]);
    if (cached) {
      const data = await cached.fn(symbol, bars).catch(() => null);
      if (data && data.length >= 5) {
        return { bars: data.slice(-bars), source: cached.name, symbol };
      }
    }
  }

  // Waterfall through sources
  for (const source of SOURCES) {
    try {
      const data = await source.fn(symbol, bars);
      if (data && data.length >= 5) {
        // Cache the source mapping
        sourceMap[key] = source.name;
        saveSourceMap(sourceMap);
        return { bars: data.slice(-bars), source: source.name, symbol };
      }
    } catch { /* try next */ }
  }

  return null;
}

/**
 * Fetch OHLCV for multiple symbols in parallel batches.
 *
 * @param {string[]} symbols - Array of symbols
 * @param {number} bars - Bars per symbol (default 200)
 * @param {number} concurrency - Parallel requests (default 15)
 */
export async function fetchBatch(symbols, bars = 200, concurrency = 15) {
  const t0 = Date.now();
  const results = new Map();
  const errors = [];
  const sourceCounts = {};

  for (let i = 0; i < symbols.length; i += concurrency) {
    const batch = symbols.slice(i, i + concurrency);
    const promises = batch.map(async (sym) => {
      const data = await fetchOhlcv(sym, bars);
      if (data) {
        results.set(sym, data);
        sourceCounts[data.source] = (sourceCounts[data.source] || 0) + 1;
      } else {
        errors.push(sym);
      }
    });
    await Promise.all(promises);
  }

  return {
    results,
    errors,
    fetched: results.size,
    failed: errors.length,
    sources: sourceCounts,
    timing_ms: Date.now() - t0,
  };
}

/**
 * Get the top N tokens by market cap from CoinGecko.
 */
export async function getTopTokens(count = 250) {
  const tokens = [];
  const perPage = 250;
  const pages = Math.ceil(count / perPage);

  for (let page = 1; page <= pages; page++) {
    const d = await fetchJSON(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=${page}`, 10000);
    if (!d || !Array.isArray(d)) break;
    for (const coin of d) {
      tokens.push({
        id: coin.id,
        symbol: coin.symbol?.toUpperCase(),
        name: coin.name,
        market_cap: coin.market_cap,
        market_cap_rank: coin.market_cap_rank,
        current_price: coin.current_price,
        price_change_24h: coin.price_change_percentage_24h,
        total_volume: coin.total_volume,
      });
    }
    if (tokens.length >= count) break;
    // CoinGecko rate limit: wait between pages
    if (page < pages) await new Promise(r => setTimeout(r, 1500));
  }

  return tokens.slice(0, count);
}

/**
 * Get the source mapping stats.
 */
export function getSourceStats() {
  const map = loadSourceMap();
  const counts = {};
  for (const source of Object.values(map)) {
    counts[source] = (counts[source] || 0) + 1;
  }
  return {
    total_mapped: Object.keys(map).length,
    by_source: counts,
  };
}
