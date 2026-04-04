/**
 * Universe-scale F&G scanner — scan thousands of instruments across all markets.
 *
 * Supports US stocks (5694), ASX stocks (2020), crypto (1000+).
 * Batch-fetches OHLCV with parallel requests, pipelining, and incremental caching.
 */
import { fetchBatch } from './unified_data.js';
import {
  loadCache, saveCache, loadGlobals, saveGlobals,
  getScanTier, updateCacheEntry, pruneCache, computeFGFromBars,
} from './fg_cache.js';
import { fetchOhlcv as fetchYahooOhlcv } from './yahoo_ohlcv.js';
import { getUSStocks, getASXStocks, getCryptoTokens, getPreset, getUniverseStats } from './universes.js';
import { optimalEntry } from './fg_backtest.js';
import { classifyCalibratedZone, calibratedEntry } from './fg_calibrated.js';

// ─── Globals ────────────────────────────────────────────────────────────────

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
      const roc = closes.length > 20 ? (closes[closes.length - 1] - closes[closes.length - 21]) / closes[closes.length - 21] * 100 : 0;
      globals.gold = Math.max(-15, Math.min(15, roc * 2));
    }
  } catch {}
  globals.lastFetch = new Date().toISOString();
  saveGlobals(globals);
  return globals;
}

// ─── Core batch scan engine ─────────────────────────────────────────────────

/**
 * Scan a list of symbols: check cache, fetch missing, compute F&G, save cache.
 * Processes in batches with periodic cache saves.
 *
 * @param {string[]} symbols - Symbols to scan
 * @param {number} batchSize - OHLCV fetch batch size (default 50)
 * @param {number} concurrency - Parallel fetches (default 20)
 * @returns {{ results: Array, timing: object, coverage: object }}
 */
async function batchScan(symbols, batchSize = 50, concurrency = 20) {
  const t0 = Date.now();
  const cache = loadCache();
  const globals = await ensureGlobals();
  const now = Date.now();

  const results = [];
  let cachedCount = 0, fetchedCount = 0, errorCount = 0;
  const sourceCounts = {};

  // Phase 1: separate cached from need-fetch
  const needFetch = [];
  for (const sym of symbols) {
    const key = sym.toUpperCase() + ':D';
    const entry = cache[key];
    if (entry && getScanTier(entry, now) === 'INSTANT') {
      results.push({ symbol: sym, ...entryToResult(entry, sym), scan_tier: 'INSTANT' });
      cachedCount++;
    } else {
      needFetch.push(sym);
    }
  }

  // Phase 2: fetch and compute in batches
  for (let i = 0; i < needFetch.length; i += batchSize) {
    const batchSyms = needFetch.slice(i, i + batchSize);
    const batch = await fetchBatch(batchSyms, 200, concurrency);

    for (const sym of batchSyms) {
      const data = batch.results.get(sym);
      if (data && data.bars.length >= 5) {
        const key = sym.toUpperCase() + ':D';
        const fg = computeFGFromBars(data.bars, cache[key]?._state || {}, globals);
        if (fg) {
          cache[key] = updateCacheEntry(sym, data.bars, cache[key], globals);
          results.push({ symbol: sym, ...entryToResult(cache[key], sym), scan_tier: 'FETCHED' });
          fetchedCount++;
          sourceCounts[data.source] = (sourceCounts[data.source] || 0) + 1;
        } else { errorCount++; }
      } else { errorCount++; }
    }

    // Save cache periodically (every batch)
    if (fetchedCount > 0) saveCache(pruneCache(cache));
  }

  return {
    results,
    timing: { total_ms: Date.now() - t0 },
    coverage: { cached: cachedCount, fetched: fetchedCount, errors: errorCount, sources: sourceCounts },
  };
}

function entryToResult(entry, symbol) {
  const cal = classifyCalibratedZone(symbol || '', entry.fgScore);
  return {
    fg_score: entry.fgScore,
    zone: entry.zone,
    severity: entry.severity,
    calibrated_zone: cal.zone,
    calibrated_severity: cal.severity,
    asset_class: cal.class,
    rare_fear_threshold: cal.thresholds.extreme_fear,
    distance_to_rare_fear: cal.distance_to_rare_fear,
    is_rare_fear: cal.is_triggered,
    components: entry.components,
    rsi: entry.rsi,
  };
}

// ─── Public scan functions ──────────────────────────────────────────────────

/**
 * Scan stocks (US or ASX) with F&G scoring.
 */
export async function stockScan({ market = 'us', universe = 100, top = 50, sort = 'fear', preset } = {}) {
  const t0 = Date.now();
  let symbolList;

  if (preset) {
    const p = await getPreset(preset);
    symbolList = p.symbols;
  } else if (market === 'asx') {
    const stocks = await getASXStocks();
    symbolList = stocks.slice(0, universe).map(s => s.symbol);
  } else {
    const stocks = await getUSStocks();
    symbolList = stocks.slice(0, universe).map(s => s.symbol);
  }

  const { results, timing, coverage } = await batchScan(symbolList);
  return formatOutput('stock', market, results, timing, coverage, top, sort, Date.now() - t0);
}

/**
 * Scan crypto tokens with F&G scoring.
 */
export async function universeScan({ universe = 250, top = 50, sort = 'fear', preset } = {}) {
  const t0 = Date.now();
  let symbolList;

  if (preset) {
    const p = await getPreset(preset);
    symbolList = p.symbols;
  } else {
    const tokens = await getCryptoTokens();
    symbolList = tokens.slice(0, universe).map(t => t.symbol);
  }

  const { results, timing, coverage } = await batchScan(symbolList);
  return formatOutput('crypto', 'crypto', results, timing, coverage, top, sort, Date.now() - t0);
}

/**
 * Scan ALL markets combined.
 */
export async function scanAll({ us = 500, asx = 200, crypto = 250, top = 50, sort = 'fear' } = {}) {
  const t0 = Date.now();

  // Build combined symbol list
  const usStocks = (await getUSStocks()).slice(0, us).map(s => s.symbol);
  const asxStocks = (await getASXStocks()).slice(0, asx).map(s => s.symbol);
  const cryptoTokens = (await getCryptoTokens()).slice(0, crypto).map(t => t.symbol);

  const allSymbols = [...usStocks, ...asxStocks, ...cryptoTokens];
  const { results, timing, coverage } = await batchScan(allSymbols, 100, 20);

  // Tag each result with its market
  const usSet = new Set(usStocks.map(s => s.toUpperCase()));
  const asxSet = new Set(asxStocks.map(s => s.toUpperCase()));
  for (const r of results) {
    const u = r.symbol.toUpperCase();
    r.market = asxSet.has(u) ? 'ASX' : usSet.has(u) ? 'US' : 'CRYPTO';
  }

  return formatOutput('all', 'combined', results, timing, coverage, top, sort, Date.now() - t0);
}

/**
 * Daily scan: update all cached symbols + full scan + report.
 */
export async function dailyScan({ top = 30, save_report = true } = {}) {
  const t0 = Date.now();

  // Get moderate-sized universe from each market
  const usStocks = (await getUSStocks()).slice(0, 500).map(s => s.symbol);
  const asxStocks = (await getASXStocks()).slice(0, 300).map(s => s.symbol);
  const cryptoTokens = (await getCryptoTokens()).slice(0, 250).map(t => t.symbol);

  const allSymbols = [...usStocks, ...asxStocks, ...cryptoTokens];
  const { results, timing, coverage } = await batchScan(allSymbols, 100, 20);

  // Tag markets
  const usSet = new Set(usStocks.map(s => s.toUpperCase()));
  const asxSet = new Set(asxStocks.map(s => s.toUpperCase()));
  for (const r of results) {
    const u = r.symbol.toUpperCase();
    r.market = asxSet.has(u) ? 'ASX' : usSet.has(u) ? 'US' : 'CRYPTO';
  }

  // Sort by fear
  results.sort((a, b) => a.fg_score - b.fg_score);

  const totalTime = Date.now() - t0;
  const dist = getDist(results);

  // Per-market distribution
  const marketDist = {};
  for (const market of ['US', 'ASX', 'CRYPTO']) {
    const m = results.filter(r => r.market === market);
    marketDist[market] = { count: m.length, ...getDist(m) };
  }

  const output = {
    success: true,
    scan_type: 'daily',
    date: new Date().toISOString().slice(0, 10),
    timing: {
      total_ms: totalTime,
      total_readable: (totalTime / 1000).toFixed(1) + 's',
    },
    coverage: {
      total: allSymbols.length,
      scored: results.length,
      ...coverage,
      coverage_pct: Math.round(results.length / allSymbols.length * 100),
    },
    distribution: dist,
    market_breakdown: marketDist,
    top_fear_buys: results.filter(r => r.severity <= -1).slice(0, top),
    top_greed_sells: [...results].sort((a, b) => b.fg_score - a.fg_score).filter(r => r.severity >= 1).slice(0, 15),
    results: results.slice(0, top),
  };

  // Save report
  if (save_report) {
    try {
      const { writeFileSync } = await import('fs');
      const date = new Date().toISOString().slice(0, 10);
      const reportPath = join(process.cwd(), 'reports', `daily-scan-${date}.md`);
      const report = buildDailyReport(output);
      writeFileSync(reportPath, report);
      output.report_path = reportPath;
    } catch {}
  }

  return output;
}

function buildDailyReport(d) {
  const lines = [
    `# Daily F&G Scan — ${d.date}`,
    '',
    `## Summary`,
    `- **${d.coverage.scored}** instruments scored in **${d.timing.total_readable}**`,
    `- Coverage: ${d.coverage.coverage_pct}% of ${d.coverage.total} attempted`,
    `- Cached: ${d.coverage.cached} | Fetched: ${d.coverage.fetched} | Errors: ${d.coverage.errors}`,
    '',
    '## Distribution',
    `| Zone | Count |`,
    `|------|-------|`,
  ];
  for (const [k, v] of Object.entries(d.distribution)) {
    lines.push(`| ${k.replace('_', ' ')} | ${v} |`);
  }
  lines.push('', '## Market Breakdown');
  for (const [m, data] of Object.entries(d.market_breakdown)) {
    lines.push(`- **${m}**: ${data.count} scored — ${data.fear + data.extreme_fear} fear, ${data.neutral} neutral, ${data.greed + data.extreme_greed} greed`);
  }
  lines.push('', '## Top 30 Fear Opportunities (Buy Candidates)', '',
    '| # | Symbol | Market | F&G | Zone |',
    '|---|--------|--------|-----|------|');
  for (let i = 0; i < Math.min(30, d.top_fear_buys.length); i++) {
    const r = d.top_fear_buys[i];
    lines.push(`| ${i + 1} | ${r.symbol} | ${r.market || '?'} | ${r.fg_score.toFixed(1)} | ${r.zone} |`);
  }
  lines.push('', '## Top 15 Greed Warnings (Sell/Caution)', '',
    '| # | Symbol | Market | F&G | Zone |',
    '|---|--------|--------|-----|------|');
  for (let i = 0; i < Math.min(15, d.top_greed_sells.length); i++) {
    const r = d.top_greed_sells[i];
    lines.push(`| ${i + 1} | ${r.symbol} | ${r.market || '?'} | +${r.fg_score.toFixed(1)} | ${r.zone} |`);
  }
  return lines.join('\n');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getDist(results) {
  const d = { extreme_fear: 0, fear: 0, neutral: 0, greed: 0, extreme_greed: 0 };
  for (const r of results) {
    if (r.severity === -2) d.extreme_fear++;
    else if (r.severity === -1) d.fear++;
    else if (r.severity === 0) d.neutral++;
    else if (r.severity === 1) d.greed++;
    else if (r.severity === 2) d.extreme_greed++;
  }
  return d;
}

// Backtest aggregate stats (loaded once, cached)
const BACKTEST_STATS = {
  timing: { avg_days_to_bottom: 18.5, median_days_to_bottom: 11, avg_additional_drawdown: -17.3, pct_bottom_within_10d: 47 },
  returns: { avg_30d: 1.8, avg_60d: -3.9, avg_90d: 1.3, win_rate_30d: 41, win_rate_60d: 36, win_rate_90d: 38 },
};

function formatOutput(scanType, market, results, timing, coverage, top, sort, totalMs) {
  switch (sort) {
    case 'greed':      results.sort((a, b) => b.fg_score - a.fg_score); break;
    case 'composite':  results.sort((a, b) => Math.abs(b.fg_score) - Math.abs(a.fg_score)); break;
    case 'market_cap': break;
    default:           results.sort((a, b) => a.fg_score - b.fg_score); break;
  }

  // Enrich fear opportunities: use CALIBRATED thresholds (severity based on asset class)
  const fearOpps = results.filter(r => r.calibrated_severity <= -1).slice(0, 20).map(r => {
    const advice = calibratedEntry(r.symbol, r.fg_score);
    return { ...r, entry: advice };
  });

  return {
    success: true,
    scan_type: scanType,
    market,
    timing: {
      fetch_ms: timing.total_ms,
      total_ms: totalMs,
      total_readable: (totalMs / 1000).toFixed(1) + 's',
    },
    coverage: {
      scored: results.length,
      ...coverage,
      coverage_pct: results.length > 0 ? Math.round((coverage.cached + coverage.fetched) / (coverage.cached + coverage.fetched + coverage.errors) * 100) : 0,
    },
    results: top > 0 ? results.slice(0, top) : [],
    fear_opportunities: fearOpps,
    greed_warnings: [...results].sort((a, b) => b.fg_score - a.fg_score).filter(r => r.calibrated_severity >= 1).slice(0, 10),
    distribution: getDist(results),
  };
}

// Re-export universe stats
export { getUniverseStats } from './universes.js';
