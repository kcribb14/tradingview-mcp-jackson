/**
 * Universe-scale F&G scanner — scan hundreds of tokens using unified data.
 *
 * Uses CoinGecko for token discovery + unified data layer for OHLCV.
 * Covers Binance (439 pairs) + CryptoCompare (5000+) + Yahoo (500) + MEXC (2388).
 */
import { fetchBatch, getTopTokens, getSourceStats } from './unified_data.js';
import {
  loadCache, saveCache, loadGlobals, saveGlobals,
  getScanTier, updateCacheEntry, pruneCache, computeFGFromBars,
} from './fg_cache.js';
import { classifyZone } from './fg_scanner.js';
import { fetchOhlcv as fetchYahooOhlcv } from './yahoo_ohlcv.js';

// Stablecoins to exclude
const STABLES = new Set([
  'USDT','USDC','DAI','BUSD','TUSD','FDUSD','USDS','USDE','USDG',
  'PYUSD','RLUSD','USD1','USD0','USDY','EUTBL','USTB','OUSG','YLDS',
  'STABLE','JTRSY','USYC','BUIDL',
]);

// ─── Fetch globals ──────────────────────────────────────────────────────────

async function ensureGlobals() {
  const globals = loadGlobals();
  const now = Date.now();
  if (globals.lastFetch && (now - new Date(globals.lastFetch).getTime()) < 3600_000) return globals;

  try {
    const [vixData, goldData] = await Promise.all([
      fetchYahooOhlcv('^VIX', 30, '1d'),
      fetchYahooOhlcv('GC=F', 30, '1d'),
    ]);
    if (vixData?.bars?.length > 0) {
      const closes = vixData.bars.map(b => b.close);
      const last = closes[closes.length - 1];
      const avg = closes.reduce((s, v) => s + v, 0) / closes.length;
      globals.vix = { close: last, ema20: avg, deviation: avg > 0 ? (last / avg - 1) * 100 : 0 };
    }
    if (goldData?.bars?.length > 0) {
      const closes = goldData.bars.map(b => b.close);
      const roc = closes.length > 20
        ? (closes[closes.length - 1] - closes[closes.length - 21]) / closes[closes.length - 21] * 100 : 0;
      globals.gold = Math.max(-15, Math.min(15, roc * 2));
    }
  } catch { /* keep existing */ }

  globals.lastFetch = new Date().toISOString();
  saveGlobals(globals);
  return globals;
}

// ─── Universe scan ──────────────────────────────────────────────────────────

/**
 * Scan the top N crypto tokens by market cap with F&G scoring.
 *
 * @param {number} universe - Number of tokens to scan (default 250)
 * @param {number} top - Return top N results (default 50)
 * @param {string} sort - Sort: 'fear', 'greed', 'composite', 'market_cap' (default 'fear')
 */
export async function universeScan({ universe = 250, top = 50, sort = 'fear' } = {}) {
  const t0 = Date.now();

  // Get token list from CoinGecko
  const tokens = await getTopTokens(universe);
  const discoveryTime = Date.now() - t0;

  // Filter stablecoins
  const tradeable = tokens.filter(t => t.symbol && !STABLES.has(t.symbol));
  const tokenMap = new Map();
  for (const t of tradeable) tokenMap.set(t.symbol, t);

  // Load cache + globals
  const cache = loadCache();
  const globals = await ensureGlobals();
  const now = Date.now();

  // Classify cached vs need-fetch
  const cached = [];
  const needFetch = [];

  for (const t of tradeable) {
    const key = t.symbol + ':D';
    const entry = cache[key];
    const tier = getScanTier(entry, now);
    if (tier === 'INSTANT' && entry) {
      cached.push({ symbol: t.symbol, entry, token: t });
    } else {
      needFetch.push(t.symbol);
    }
  }

  // Fetch OHLCV for uncached tokens
  const fetchStart = Date.now();
  let fetchedCount = 0, fetchErrors = 0;
  const sourceCounts = {};

  if (needFetch.length > 0) {
    const batch = await fetchBatch(needFetch, 200, 20);

    for (const sym of needFetch) {
      const data = batch.results.get(sym);
      if (data && data.bars.length >= 5) {
        const key = sym + ':D';
        const fg = computeFGFromBars(data.bars, cache[key]?._state || {}, globals);
        if (fg) {
          cache[key] = updateCacheEntry(sym, data.bars, cache[key], globals);
          fetchedCount++;
          sourceCounts[data.source] = (sourceCounts[data.source] || 0) + 1;
        } else {
          fetchErrors++;
        }
      } else {
        fetchErrors++;
      }
    }

    saveCache(pruneCache(cache));
  }

  const fetchTime = Date.now() - fetchStart;

  // Build results
  const results = [];
  for (const t of tradeable) {
    const key = t.symbol + ':D';
    const entry = cache[key];
    if (!entry || entry.fgScore == null) continue;

    results.push({
      symbol: t.symbol,
      name: t.name,
      fg_score: entry.fgScore,
      zone: entry.zone,
      severity: entry.severity,
      components: entry.components,
      rsi: entry.rsi,
      price: t.current_price,
      change_24h: t.price_change_24h,
      market_cap: t.market_cap,
      rank: t.market_cap_rank,
      volume_24h: t.total_volume,
      scan_tier: cached.find(c => c.symbol === t.symbol) ? 'INSTANT' : 'FETCHED',
    });
  }

  // Sort
  switch (sort) {
    case 'greed':      results.sort((a, b) => b.fg_score - a.fg_score); break;
    case 'composite':  results.sort((a, b) => Math.abs(b.fg_score) - Math.abs(a.fg_score)); break;
    case 'market_cap': results.sort((a, b) => (b.market_cap || 0) - (a.market_cap || 0)); break;
    default:           results.sort((a, b) => a.fg_score - b.fg_score); break;
  }

  const totalTime = Date.now() - t0;

  // Distribution
  const dist = { extreme_fear: 0, fear: 0, neutral: 0, greed: 0, extreme_greed: 0 };
  for (const r of results) {
    if (r.severity === -2) dist.extreme_fear++;
    else if (r.severity === -1) dist.fear++;
    else if (r.severity === 0) dist.neutral++;
    else if (r.severity === 1) dist.greed++;
    else if (r.severity === 2) dist.extreme_greed++;
  }

  return {
    success: true,
    scan_type: 'universe',
    timing: {
      discovery_ms: discoveryTime,
      fetch_ms: fetchTime,
      total_ms: totalTime,
      total_readable: (totalTime / 1000).toFixed(1) + 's',
    },
    coverage: {
      requested: universe,
      tradeable: tradeable.length,
      scored: results.length,
      cached: cached.length,
      fetched: fetchedCount,
      errors: fetchErrors,
      sources: sourceCounts,
      coverage_pct: Math.round(results.length / tradeable.length * 100),
    },
    results: results.slice(0, top),
    fear_opportunities: results.filter(r => r.severity <= -1).slice(0, 20),
    greed_warnings: [...results].sort((a, b) => b.fg_score - a.fg_score).filter(r => r.severity >= 1).slice(0, 10),
    distribution: dist,
  };
}

/**
 * Warm the universe cache.
 */
export async function warmUniverse({ universe = 500 } = {}) {
  return universeScan({ universe, top: 0, sort: 'market_cap' });
}
