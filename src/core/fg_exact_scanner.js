/**
 * Exact F&G Scanner with incremental caching + Yahoo Finance OHLCV.
 *
 * Uses Yahoo Finance for batch OHLCV (26ms/symbol) instead of chart switching
 * (13s/symbol). Combined with file-backed EMA/RMA state persistence, this
 * enables scanning 200+ stocks in under 30 seconds cold, <5 seconds warm.
 *
 * Scan tiers:
 *   INSTANT  (0ms)  — cached <1hr, return immediately
 *   MICRO    (5ms)  — cached <4hrs, fetch 5 new bars, update EMA
 *   PARTIAL  (50ms) — cached <24hrs, fetch 50 new bars
 *   FULL    (200ms) — no cache, fetch 200 bars, full calculation
 */
import { classifyZone, proxyFearGreed } from './fg_scanner.js';
import { readMultiView } from './scanner.js';
import { fetchBatchOhlcv, fetchOhlcv } from './yahoo_ohlcv.js';
import {
  loadCache, saveCache, loadGlobals, saveGlobals,
  getScanTier, getBarsForTier, updateCacheEntry,
  pruneCache, getCacheStats, clearCache,
  computeFGFromBars,
} from './fg_cache.js';

// ─── Field accessor (handles non-breaking spaces) ──────────────────────────

function f(stock, key) {
  let v = stock[key];
  if (v === undefined) {
    const nbspKey = key.replace(/ /g, '\xa0');
    v = stock[nbspKey];
  }
  if (v === undefined) {
    const normKey = key.replace(/\s+/g, ' ');
    for (const k of Object.keys(stock)) {
      if (k.replace(/[\s\xa0]+/g, ' ') === normKey) { v = stock[k]; break; }
    }
  }
  return (typeof v === 'number') ? v : null;
}

// ─── Fetch globals via Yahoo (VIX + Gold) ───────────────────────────────────

async function fetchGlobalsYahoo() {
  const globals = loadGlobals();
  const now = Date.now();

  if (globals.lastFetch && (now - new Date(globals.lastFetch).getTime()) < 3600_000) {
    return globals;
  }

  try {
    const [vixData, goldData] = await Promise.all([
      fetchOhlcv('^VIX', 30),
      fetchOhlcv('GC=F', 30),
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
        ? (closes[closes.length - 1] - closes[closes.length - 21]) / closes[closes.length - 21] * 100
        : 0;
      globals.gold = Math.max(-15, Math.min(15, roc * 2));
      globals.goldClose = closes[closes.length - 1];
    }
  } catch { /* keep existing */ }

  globals.lastFetch = new Date().toISOString();
  saveGlobals(globals);
  return globals;
}

// ─── Exact cached scan ──────────────────────────────────────────────────────

/**
 * Run an exact F&G scan with incremental caching.
 * Uses Yahoo Finance for OHLCV — zero TradingView chart switching.
 *
 * @param {number} universe - Total stocks to consider (default 100)
 * @param {number} top - Return top N results (default 20)
 * @param {boolean} skip_globals - Skip VIX/Gold fetch (default false)
 * @param {string} sort - Sort: 'fear', 'greed', 'composite' (default 'fear')
 */
export async function fgExactScan({ universe = 100, top = 20, skip_globals = false, sort = 'fear' } = {}) {
  const t0 = Date.now();
  const cache = loadCache();

  // ═══════════════════════════════════════════════════════════════════════════
  // SCREENER: get symbol list + proxy scores
  // ═══════════════════════════════════════════════════════════════════════════

  const stocks = await readMultiView({
    views: ['Overview', 'Technicals', 'Performance'],
    maxRows: universe,
  });
  const screenerTime = Date.now() - t0;

  const proxyScores = stocks.map(stock => ({
    symbol: stock.Symbol,
    proxy: proxyFearGreed(stock),
    price: f(stock, 'Price'),
    change_pct: f(stock, 'Change %'),
    rel_volume: f(stock, 'Rel Volume'),
    rsi: f(stock, 'RSI (14)'),
    perf_1m: f(stock, 'Perf %1M'),
    volatility: f(stock, 'Volatility1W'),
    sector: stock._raw?.['Sector'] ?? null,
    analyst_rating: stock._raw?.['Analyst Rating'] ?? null,
  }));

  // Fetch globals (VIX + Gold) via Yahoo
  const globals = skip_globals ? loadGlobals() : await fetchGlobalsYahoo();

  // ═══════════════════════════════════════════════════════════════════════════
  // CLASSIFY: determine scan tier per symbol
  // ═══════════════════════════════════════════════════════════════════════════

  const now = Date.now();
  const tierCounts = { INSTANT: 0, MICRO: 0, PARTIAL: 0, FULL: 0 };
  const results = [];
  const needFetch = []; // symbols that need OHLCV from Yahoo

  for (const stock of proxyScores) {
    const sym = stock.symbol;
    if (!sym) continue;

    const cached = cache[sym];
    const tier = getScanTier(cached, now);
    tierCounts[tier]++;

    if (tier === 'INSTANT' && cached) {
      results.push({
        symbol: sym,
        fg_score: cached.fgScore,
        zone: cached.zone,
        severity: cached.severity,
        components: cached.components,
        rsi: cached.rsi,
        price: stock.price,
        change_pct: stock.change_pct,
        proxy_fg: stock.proxy.proxy_fg,
        scan_tier: 'INSTANT',
        cached_age_min: Math.round((now - new Date(cached.lastScanTime).getTime()) / 60000),
        sector: stock.sector,
        analyst_rating: stock.analyst_rating,
      });
    } else {
      needFetch.push({ stock, tier, cached, barCount: getBarsForTier(tier) });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // YAHOO BATCH: fetch OHLCV for all non-cached symbols in parallel
  // ═══════════════════════════════════════════════════════════════════════════

  const yahooStart = Date.now();
  let yahooFetched = 0, yahooErrors = 0;

  if (needFetch.length > 0) {
    const symbols = needFetch.map(n => n.stock.symbol);
    const maxBars = Math.max(...needFetch.map(n => n.barCount));
    const batch = await fetchBatchOhlcv(symbols, maxBars, 15);

    for (const item of needFetch) {
      const sym = item.stock.symbol;
      const ohlcvData = batch.results.get(sym);

      if (!ohlcvData || ohlcvData.bars.length < 5) {
        yahooErrors++;
        // Fall back to proxy score
        results.push({
          symbol: sym,
          fg_score: item.stock.proxy.proxy_fg,
          zone: item.stock.proxy.zone,
          severity: item.stock.proxy.severity,
          components: item.stock.proxy.components,
          rsi: item.stock.rsi,
          price: item.stock.price,
          change_pct: item.stock.change_pct,
          proxy_fg: item.stock.proxy.proxy_fg,
          scan_tier: item.tier,
          error: 'Yahoo fetch failed',
          sector: item.stock.sector,
          analyst_rating: item.stock.analyst_rating,
        });
        continue;
      }

      // Trim bars to the needed count for this tier
      const bars = ohlcvData.bars.slice(-item.barCount);
      const fg = computeFGFromBars(bars, item.cached?._state || {}, globals);

      if (!fg) {
        results.push({
          symbol: sym,
          fg_score: item.stock.proxy.proxy_fg,
          zone: item.stock.proxy.zone,
          severity: item.stock.proxy.severity,
          components: item.stock.proxy.components,
          proxy_fg: item.stock.proxy.proxy_fg,
          scan_tier: item.tier,
          error: 'Computation failed',
          sector: item.stock.sector,
          analyst_rating: item.stock.analyst_rating,
        });
        continue;
      }

      // Update cache
      cache[sym] = updateCacheEntry(sym, bars, item.cached, globals);
      yahooFetched++;

      results.push({
        symbol: sym,
        fg_score: fg.fgScore,
        zone: fg.zone,
        severity: fg.severity,
        components: fg.components,
        rsi: fg.rsi,
        price: item.stock.price,
        change_pct: item.stock.change_pct,
        proxy_fg: item.stock.proxy.proxy_fg,
        proxy_error: Math.round(Math.abs(item.stock.proxy.proxy_fg - fg.fgScore) * 100) / 100,
        scan_tier: item.tier,
        bar_count: bars.length,
        sector: item.stock.sector,
        analyst_rating: item.stock.analyst_rating,
      });
    }
  }

  const yahooTime = Date.now() - yahooStart;

  // Save cache
  saveCache(pruneCache(cache));

  // ═══════════════════════════════════════════════════════════════════════════
  // SORT & RETURN
  // ═══════════════════════════════════════════════════════════════════════════

  let sorted;
  switch (sort) {
    case 'greed':     sorted = [...results].sort((a, b) => b.fg_score - a.fg_score); break;
    case 'composite': sorted = [...results].sort((a, b) => Math.abs(b.fg_score) - Math.abs(a.fg_score)); break;
    default:          sorted = [...results].sort((a, b) => a.fg_score - b.fg_score); break;
  }

  const totalTime = Date.now() - t0;

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
    scan_type: 'fg-exact',
    timing: {
      screener_ms: screenerTime,
      yahoo_ms: yahooTime,
      total_ms: totalTime,
      total_readable: (totalTime / 1000).toFixed(1) + 's',
    },
    cache_stats: {
      ...tierCounts,
      yahoo_fetched: yahooFetched,
      yahoo_errors: yahooErrors,
      summary: `${results.length} stocks: ${tierCounts.INSTANT} instant, ${tierCounts.MICRO} micro, ${tierCounts.PARTIAL} partial, ${tierCounts.FULL} full — total ${(totalTime / 1000).toFixed(1)}s`,
    },
    stocks_scanned: results.length,
    sort_by: sort,
    results: sorted.slice(0, top),
    fear_opportunities: sorted.filter(r => r.severity <= -1).slice(0, 10),
    greed_warnings: [...results].sort((a, b) => b.fg_score - a.fg_score).filter(r => r.severity >= 1).slice(0, 10),
    distribution: dist,
  };
}

// ─── Cache warming (Yahoo-powered) ─────────────────────────────────────────

/**
 * Warm the F&G cache using Yahoo Finance for batch OHLCV.
 * No chart switching — fetches all data externally in parallel.
 *
 * @param {number} universe - Stocks to warm (default 100)
 * @param {string[]} symbols - Explicit symbol list (overrides screener)
 */
export async function warmCache({ universe = 100, symbols: explicitSymbols } = {}) {
  const t0 = Date.now();
  const cache = loadCache();
  const globals = await fetchGlobalsYahoo();
  const now = Date.now();

  let symbolList;
  let screenerTime = 0;

  if (explicitSymbols && explicitSymbols.length > 0) {
    symbolList = explicitSymbols;
  } else {
    const stocks = await readMultiView({ views: ['Overview'], maxRows: universe });
    screenerTime = Date.now() - t0;
    symbolList = stocks.map(s => s.Symbol).filter(Boolean);
  }

  // Filter out already-fresh symbols
  const stale = [];
  let skipped = 0;
  for (const sym of symbolList) {
    const cached = cache[sym];
    if (cached && getScanTier(cached, now) === 'INSTANT') {
      skipped++;
    } else {
      stale.push(sym);
    }
  }

  // Batch fetch all stale symbols via Yahoo
  const yahooStart = Date.now();
  let warmed = 0, errors = 0;

  if (stale.length > 0) {
    const batch = await fetchBatchOhlcv(stale, 200, 15);

    for (const sym of stale) {
      const ohlcvData = batch.results.get(sym);
      if (ohlcvData && ohlcvData.bars.length >= 5) {
        cache[sym] = updateCacheEntry(sym, ohlcvData.bars, cache[sym], globals);
        warmed++;
      } else {
        errors++;
      }
    }

    // Save every batch
    saveCache(pruneCache(cache));
  }

  const yahooTime = Date.now() - yahooStart;
  const totalTime = Date.now() - t0;

  return {
    success: true,
    warmed,
    skipped,
    errors,
    total_symbols: symbolList.length,
    timing: {
      screener_ms: screenerTime,
      yahoo_ms: yahooTime,
      total_ms: totalTime,
      total_readable: (totalTime / 1000).toFixed(1) + 's',
    },
  };
}

// ─── Daily incremental update ───────────────────────────────────────────────

/**
 * Update all cached symbols with just the latest bar.
 * For daily updates after initial warm-up.
 */
export async function updateCache() {
  const t0 = Date.now();
  const cache = loadCache();
  const globals = await fetchGlobalsYahoo();

  const symbols = Object.keys(cache);
  if (symbols.length === 0) {
    return { success: true, updated: 0, message: 'Cache is empty. Run cache-warm first.' };
  }

  // Fetch 5 bars for each (enough for incremental EMA update)
  const batch = await fetchBatchOhlcv(symbols, 5, 15);

  let updated = 0, errors = 0;
  for (const sym of symbols) {
    const ohlcvData = batch.results.get(sym);
    if (ohlcvData && ohlcvData.bars.length > 0) {
      cache[sym] = updateCacheEntry(sym, ohlcvData.bars, cache[sym], globals);
      updated++;
    } else {
      errors++;
    }
  }

  saveCache(cache);
  const totalTime = Date.now() - t0;

  return {
    success: true,
    updated,
    errors,
    total_symbols: symbols.length,
    timing: {
      total_ms: totalTime,
      total_readable: (totalTime / 1000).toFixed(1) + 's',
      per_symbol_ms: symbols.length > 0 ? Math.round(totalTime / symbols.length) : 0,
    },
  };
}

// ─── Re-exports for CLI ─────────────────────────────────────────────────────

export { getCacheStats, clearCache };
