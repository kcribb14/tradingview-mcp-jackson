/**
 * Exact F&G Scanner with incremental caching.
 *
 * First scan: full 200-bar pull per symbol, calculates everything, saves state.
 * Subsequent scans: only fetches delta bars, updates EMA/RMA incrementally.
 *
 * Scan tiers:
 *   INSTANT  (0ms)  — cached <1hr, return immediately
 *   MICRO    (5ms)  — cached <4hrs, fetch 5 new bars, update EMA
 *   PARTIAL  (50ms) — cached <24hrs, fetch 50 new bars
 *   FULL    (200ms) — no cache, fetch 200 bars, full calculation
 */
import * as chart from './chart.js';
import * as data from './data.js';
import { classifyZone, proxyFearGreed } from './fg_scanner.js';
import { readMultiView } from './scanner.js';
import {
  loadCache, saveCache, loadGlobals,
  getScanTier, getBarsForTier, updateCacheEntry,
  fetchGlobals, pruneCache, getCacheStats, clearCache,
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

// ─── Exact cached scan ──────────────────────────────────────────────────────

/**
 * Run an exact F&G scan with incremental caching.
 *
 * @param {number} universe - Total stocks to consider (default 50)
 * @param {number} top - Return top N results (default 20)
 * @param {boolean} skipGlobals - Skip VIX/Gold fetch (default true for speed)
 * @param {string} sort - Sort: 'fear', 'greed', 'composite' (default 'fear')
 */
export async function fgExactScan({ universe = 50, top = 20, skip_globals = true, sort = 'fear' } = {}) {
  const t0 = Date.now();
  const cache = loadCache();
  const globals = loadGlobals();

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 1: Screener read → get symbol list + proxy scores
  // ═══════════════════════════════════════════════════════════════════════════

  const stocks = await readMultiView({
    views: ['Overview', 'Technicals', 'Performance'],
    maxRows: universe,
  });
  const screenerTime = Date.now() - t0;

  // Score via proxy for all stocks
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

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 2: Determine scan tier per symbol, batch by tier
  // ═══════════════════════════════════════════════════════════════════════════

  const now = Date.now();
  const tierCounts = { INSTANT: 0, MICRO: 0, PARTIAL: 0, FULL: 0 };
  const results = [];
  const chartSwitchStart = Date.now();

  // Fetch globals if needed (VIX + Gold)
  let globalsUsed = globals;
  if (!skip_globals) {
    const currentState = await chart.getState?.() ?? {};
    globalsUsed = await fetchGlobals(
      (opts) => data.getOhlcv(opts),
      (opts) => chart.setSymbol(opts),
      currentState.symbol || proxyScores[0]?.symbol || 'AAPL',
    );
  }

  for (const stock of proxyScores) {
    const sym = stock.symbol;
    if (!sym) continue;

    const cached = cache[sym];
    const tier = getScanTier(cached, now);
    tierCounts[tier]++;

    if (tier === 'INSTANT' && cached) {
      // Return cached score immediately — no chart interaction
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
      continue;
    }

    // Need to fetch bars — switch chart
    const barCount = getBarsForTier(tier);
    try {
      await chart.setSymbol({ symbol: sym });
      // Minimal wait — OHLCV is available quickly, don't need full chart render
      await new Promise(r => setTimeout(r, tier === 'FULL' ? 500 : 300));

      const ohlcv = await data.getOhlcv({ count: barCount, summary: false });
      const bars = ohlcv?.bars || [];

      if (bars.length < 5) {
        // Not enough data — use proxy score
        results.push({
          symbol: sym,
          fg_score: stock.proxy.proxy_fg,
          zone: stock.proxy.zone,
          severity: stock.proxy.severity,
          components: stock.proxy.components,
          rsi: stock.rsi,
          price: stock.price,
          change_pct: stock.change_pct,
          proxy_fg: stock.proxy.proxy_fg,
          scan_tier: tier,
          error: `Only ${bars.length} bars available`,
          sector: stock.sector,
          analyst_rating: stock.analyst_rating,
        });
        continue;
      }

      // Compute F&G from bars with cached EMA state
      const fg = computeFGFromBars(bars, cached?._state || {}, globalsUsed);
      if (!fg) {
        results.push({
          symbol: sym,
          fg_score: stock.proxy.proxy_fg,
          zone: stock.proxy.zone,
          severity: stock.proxy.severity,
          components: stock.proxy.components,
          proxy_fg: stock.proxy.proxy_fg,
          scan_tier: tier,
          error: 'Computation failed',
          sector: stock.sector,
          analyst_rating: stock.analyst_rating,
        });
        continue;
      }

      // Update cache
      cache[sym] = updateCacheEntry(sym, bars, cached, globalsUsed);

      results.push({
        symbol: sym,
        fg_score: fg.fgScore,
        zone: fg.zone,
        severity: fg.severity,
        components: fg.components,
        rsi: fg.rsi,
        price: stock.price,
        change_pct: stock.change_pct,
        proxy_fg: stock.proxy.proxy_fg,
        proxy_error: Math.round(Math.abs(stock.proxy.proxy_fg - fg.fgScore) * 100) / 100,
        scan_tier: tier,
        bar_count: bars.length,
        sector: stock.sector,
        analyst_rating: stock.analyst_rating,
      });
    } catch (err) {
      results.push({
        symbol: sym,
        fg_score: stock.proxy.proxy_fg,
        zone: stock.proxy.zone,
        severity: stock.proxy.severity,
        components: stock.proxy.components,
        proxy_fg: stock.proxy.proxy_fg,
        scan_tier: tier,
        error: err.message,
        sector: stock.sector,
        analyst_rating: stock.analyst_rating,
      });
    }
  }

  const chartSwitchTime = Date.now() - chartSwitchStart;

  // Save cache (pruned)
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
    scan_type: 'fg-exact',
    timing: {
      screener_ms: screenerTime,
      chart_switch_ms: chartSwitchTime,
      total_ms: totalTime,
      total_readable: (totalTime / 1000).toFixed(1) + 's',
    },
    cache_stats: {
      ...tierCounts,
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

// ─── Cache warming ──────────────────────────────────────────────────────────

/**
 * Pre-calculate F&G for all symbols so next scan is instant.
 * Iterates through every symbol, fetching 200 bars and computing from scratch.
 */
export async function warmCache({ universe = 100 } = {}) {
  const t0 = Date.now();
  const cache = loadCache();
  const globals = loadGlobals();

  const stocks = await readMultiView({
    views: ['Overview'],
    maxRows: universe,
  });
  const screenerTime = Date.now() - t0;

  let warmed = 0, skipped = 0, errors = 0;
  const now = Date.now();

  for (const stock of stocks) {
    const sym = stock.Symbol;
    if (!sym) continue;

    // Skip if already fresh (<1hr)
    const cached = cache[sym];
    if (cached && getScanTier(cached, now) === 'INSTANT') {
      skipped++;
      continue;
    }

    try {
      await chart.setSymbol({ symbol: sym });
      await new Promise(r => setTimeout(r, 800));

      const ohlcv = await data.getOhlcv({ count: 200, summary: false });
      const bars = ohlcv?.bars || [];
      if (bars.length >= 5) {
        cache[sym] = updateCacheEntry(sym, bars, cached, globals);
        warmed++;
      } else {
        errors++;
      }
    } catch {
      errors++;
    }
  }

  saveCache(pruneCache(cache));
  const totalTime = Date.now() - t0;

  return {
    success: true,
    warmed,
    skipped,
    errors,
    total_symbols: stocks.length,
    timing: {
      screener_ms: screenerTime,
      total_ms: totalTime,
      total_readable: (totalTime / 1000).toFixed(1) + 's',
    },
  };
}

// ─── Re-exports for CLI ─────────────────────────────────────────────────────

export { getCacheStats, clearCache };
