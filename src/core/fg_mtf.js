/**
 * Multi-Timeframe Fear & Greed Scanner.
 *
 * Scans 15m, 1H, 4H, Daily simultaneously per symbol using Yahoo Finance.
 * Classifies cross-TF divergence into actionable signals:
 *   FULL_CAPITULATION, REVERSAL_STARTING, PULLBACK_IN_UPTREND, etc.
 *
 * Cache keys: "AAPL:15", "AAPL:60", "AAPL:240", "AAPL:D"
 */
import { readMultiView } from './scanner.js';
import { proxyFearGreed } from './fg_scanner.js';
import { fetchBatchMultiTF, fetchOhlcv } from './yahoo_ohlcv.js';
import {
  loadCache, saveCache, loadGlobals, saveGlobals,
  cacheKey, getScanTier, updateCacheEntry,
  pruneCache, computeFGFromBars,
} from './fg_cache.js';

// ─── Timeframe configuration ────────────────────────────────────────────────

const TF_CONFIG = {
  '15':  { yahoo: '15m', label: '15m', bars: 200 },
  '60':  { yahoo: '1h',  label: '1H',  bars: 200 },
  '240': { yahoo: '4h',  label: '4H',  bars: 200 },
  'D':   { yahoo: '1d',  label: 'Daily', bars: 200 },
};

const DEFAULT_TFS = ['15', '60', '240', 'D'];

// ─── MTF Signal Classification ──────────────────────────────────────────────

/**
 * Classify the multi-timeframe F&G pattern into a signal.
 *
 * @param {{ fg_15m, fg_1H, fg_4H, fg_D }} scores
 * @returns {{ signal: string, description: string, alignment: number }}
 */
export function classifyMTFSignal(zones) {
  const { z15, z1H, z4H, zD } = zones;

  // Map zones to direction: fear=-1, neutral=0, greed=+1
  const dir = (z) => {
    if (z === 'EXTREME FEAR' || z === 'FEAR') return -1;
    if (z === 'EXTREME GREED' || z === 'GREED') return 1;
    return 0;
  };

  const d15 = dir(z15), d1H = dir(z1H), d4H = dir(z4H), dD = dir(zD);
  const dirs = [d15, d1H, d4H, dD];

  // Alignment: what % agree on direction (ignoring neutrals)
  const nonZero = dirs.filter(d => d !== 0);
  const alignment = nonZero.length > 0
    ? Math.round(Math.abs(nonZero.reduce((s, d) => s + d, 0)) / nonZero.length * 100)
    : 50;

  // Full capitulation: all fear
  if (d15 <= -1 && d1H <= -1 && d4H <= -1 && dD <= -1) {
    return { signal: 'FULL_CAPITULATION', description: 'All TFs in fear — strongest buy signal', alignment: 100 };
  }

  // Full euphoria: all greed
  if (d15 >= 1 && d1H >= 1 && d4H >= 1 && dD >= 1) {
    return { signal: 'FULL_EUPHORIA', description: 'All TFs overextended — take profit / sell signal', alignment: 100 };
  }

  // Reversal starting: 15m bouncing while higher TFs still fear
  if (d15 >= 0 && d1H <= -1 && d4H <= -1 && dD <= -1) {
    return { signal: 'REVERSAL_STARTING', description: '15m bouncing while higher TFs still fear — early entry', alignment };
  }

  // Bear rally: lower TFs bouncing but structure bearish
  if (d15 >= 1 && d1H >= 0 && d4H <= -1 && dD <= -1) {
    return { signal: 'BEAR_RALLY', description: 'Lower TFs bouncing but structure still bearish — don\'t chase', alignment };
  }

  // Pullback in uptrend: intraday fear in bullish structure
  if (d15 <= -1 && (d4H >= 1 || dD >= 1)) {
    return { signal: 'PULLBACK_IN_UPTREND', description: 'Intraday fear in bullish structure — buy the dip', alignment };
  }

  // Healthy correction: daily bullish, intraday selling
  if (d15 <= -1 && d1H <= -1 && d4H <= 0 && dD >= 1) {
    return { signal: 'HEALTHY_CORRECTION', description: 'Daily still bullish, intraday selling — reload zone', alignment };
  }

  // Bottoming: short TFs stabilizing while daily still weak
  if (d15 >= 0 && d1H >= 0 && dD <= -1) {
    return { signal: 'BOTTOMING', description: 'Short TFs stabilizing while daily weak — watch for confirmation', alignment };
  }

  // Counter-trend rally: strong bounce but daily still down
  if (d15 >= 1 && d1H >= 1 && dD <= -1) {
    return { signal: 'COUNTER_TREND_RALLY', description: 'Strong bounce but daily trend still down — caution', alignment };
  }

  // Building fear: lower TFs turning fearful
  if (d15 <= -1 && d1H <= -1 && d4H >= 0 && dD >= 0) {
    return { signal: 'BUILDING_FEAR', description: 'Lower TFs turning fearful — potential breakdown starting', alignment };
  }

  // Building greed: lower TFs turning greedy
  if (d15 >= 1 && d1H >= 1 && d4H <= 0 && dD <= 0) {
    return { signal: 'BUILDING_GREED', description: 'Lower TFs turning greedy — potential breakout starting', alignment };
  }

  // Mixed / transitioning
  return { signal: 'MIXED', description: 'Timeframes disagree — no clear signal', alignment };
}

// ─── Fetch globals ──────────────────────────────────────────────────────────

async function ensureGlobals() {
  const globals = loadGlobals();
  const now = Date.now();
  if (globals.lastFetch && (now - new Date(globals.lastFetch).getTime()) < 3600_000) return globals;

  try {
    const [vixData, goldData] = await Promise.all([
      fetchOhlcv('^VIX', 30, '1d'),
      fetchOhlcv('GC=F', 30, '1d'),
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
    }
  } catch { /* keep existing */ }

  globals.lastFetch = new Date().toISOString();
  saveGlobals(globals);
  return globals;
}

// ─── Field accessor ─────────────────────────────────────────────────────────

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

// ─── MTF Scan ───────────────────────────────────────────────────────────────

/**
 * Run a multi-timeframe F&G scan.
 *
 * @param {number} universe - Stocks to scan (default 50)
 * @param {number} top - Return top N (default 20)
 * @param {string[]} timeframes - TFs to scan (default ['15','60','240','D'])
 * @param {string[]} symbols - Explicit symbol list (overrides screener)
 */
export async function mtfScan({ universe = 50, top = 20, timeframes = DEFAULT_TFS, symbols: explicitSymbols } = {}) {
  const t0 = Date.now();
  const cache = loadCache();
  const globals = await ensureGlobals();
  const now = Date.now();

  // Get symbol list
  let symbolList;
  let screenerTime = 0;
  let proxyMap = new Map();

  if (explicitSymbols && explicitSymbols.length > 0) {
    symbolList = explicitSymbols;
  } else {
    const stocks = await readMultiView({ views: ['Overview', 'Technicals'], maxRows: universe });
    screenerTime = Date.now() - t0;
    symbolList = stocks.map(s => s.Symbol).filter(Boolean);
    for (const stock of stocks) {
      if (stock.Symbol) {
        proxyMap.set(stock.Symbol, {
          proxy: proxyFearGreed(stock),
          price: f(stock, 'Price'),
          change_pct: f(stock, 'Change %'),
          sector: stock._raw?.['Sector'] ?? null,
          analyst_rating: stock._raw?.['Analyst Rating'] ?? null,
        });
      }
    }
  }

  // Determine which symbol+TF combos need fetching
  const needFetch = []; // { sym, tf }
  const cachedResults = new Map(); // sym → Map(tf → entry)

  for (const sym of symbolList) {
    if (!cachedResults.has(sym)) cachedResults.set(sym, new Map());
    for (const tf of timeframes) {
      const key = cacheKey(sym, tf);
      const entry = cache[key];
      const tier = getScanTier(entry, now);
      if (tier === 'INSTANT' && entry) {
        cachedResults.get(sym).set(tf, entry);
      } else {
        needFetch.push({ sym, tf });
      }
    }
  }

  // Build Yahoo fetch list — group by symbol
  const symbolsToFetch = new Map(); // sym → Set(yahooInterval)
  for (const { sym, tf } of needFetch) {
    if (!symbolsToFetch.has(sym)) symbolsToFetch.set(sym, new Set());
    symbolsToFetch.get(sym).add(tf);
  }

  const fetchSymbols = [...symbolsToFetch.keys()];
  const yahooIntervals = [...new Set(needFetch.map(n => TF_CONFIG[n.tf]?.yahoo).filter(Boolean))];

  // Fetch all needed data via Yahoo
  const yahooStart = Date.now();
  let yahooFetched = 0, yahooErrors = 0;

  if (fetchSymbols.length > 0) {
    // Fetch all intervals for all symbols that need data
    const batch = await fetchBatchMultiTF(fetchSymbols, yahooIntervals, 200, 15);

    // Process results and compute F&G per symbol+TF
    for (const { sym, tf } of needFetch) {
      const config = TF_CONFIG[tf];
      if (!config) continue;

      const symData = batch.results.get(sym);
      const ohlcvData = symData?.get(config.yahoo);

      if (!ohlcvData || ohlcvData.bars.length < 5) {
        yahooErrors++;
        continue;
      }

      const bars = ohlcvData.bars.slice(-200);
      const key = cacheKey(sym, tf);
      const existingEntry = cache[key];
      const fg = computeFGFromBars(bars, existingEntry?._state || {}, globals);

      if (fg) {
        cache[key] = updateCacheEntry(sym, bars, existingEntry, globals);
        cachedResults.get(sym).set(tf, cache[key]);
        yahooFetched++;
      }
    }
  }

  const yahooTime = Date.now() - yahooStart;

  // Save cache
  saveCache(pruneCache(cache));

  // Build results
  const results = [];
  for (const sym of symbolList) {
    const tfData = cachedResults.get(sym);
    if (!tfData || tfData.size === 0) continue;

    const scores = {};
    const zones = {};
    for (const tf of timeframes) {
      const entry = tfData.get(tf);
      const label = TF_CONFIG[tf]?.label || tf;
      if (entry) {
        scores[`fg_${label}`] = entry.fgScore;
        zones[`zone_${label}`] = entry.zone;
      } else {
        scores[`fg_${label}`] = null;
        zones[`zone_${label}`] = 'UNKNOWN';
      }
    }

    // Classify MTF signal
    const z15 = tfData.get('15')?.zone || 'NEUTRAL';
    const z1H = tfData.get('60')?.zone || 'NEUTRAL';
    const z4H = tfData.get('240')?.zone || 'NEUTRAL';
    const zD  = tfData.get('D')?.zone || 'NEUTRAL';
    const mtf = classifyMTFSignal({ z15, z1H, z4H, zD });

    const proxy = proxyMap.get(sym);

    results.push({
      symbol: sym,
      ...scores,
      ...zones,
      mtf_signal: mtf.signal,
      mtf_description: mtf.description,
      mtf_alignment: mtf.alignment,
      price: proxy?.price ?? null,
      change_pct: proxy?.change_pct ?? null,
      sector: proxy?.sector ?? null,
      analyst_rating: proxy?.analyst_rating ?? null,
      tfs_available: tfData.size,
    });
  }

  // Sort by alignment desc (most aligned = strongest signal)
  results.sort((a, b) => b.mtf_alignment - a.mtf_alignment);

  const totalTime = Date.now() - t0;

  // Signal distribution
  const signals = {};
  for (const r of results) {
    signals[r.mtf_signal] = (signals[r.mtf_signal] || 0) + 1;
  }

  // Tier stats
  const tierStats = {
    instant: needFetch.length === 0 ? symbolList.length * timeframes.length : (symbolList.length * timeframes.length - needFetch.length),
    fetched: yahooFetched,
    errors: yahooErrors,
  };

  return {
    success: true,
    scan_type: 'mtf',
    timing: {
      screener_ms: screenerTime,
      yahoo_ms: yahooTime,
      total_ms: totalTime,
      total_readable: (totalTime / 1000).toFixed(1) + 's',
    },
    cache_stats: {
      ...tierStats,
      summary: `${results.length} stocks × ${timeframes.length} TFs: ${tierStats.instant} instant, ${tierStats.fetched} fetched — total ${(totalTime / 1000).toFixed(1)}s`,
    },
    stocks_scanned: results.length,
    timeframes: timeframes.map(tf => TF_CONFIG[tf]?.label || tf),
    results: results.slice(0, top),
    signals,
    // Highlight key signals
    capitulation: results.filter(r => r.mtf_signal === 'FULL_CAPITULATION'),
    euphoria: results.filter(r => r.mtf_signal === 'FULL_EUPHORIA'),
    reversal_starting: results.filter(r => r.mtf_signal === 'REVERSAL_STARTING'),
    pullback: results.filter(r => r.mtf_signal === 'PULLBACK_IN_UPTREND'),
  };
}

// ─── MTF Cache Warming ──────────────────────────────────────────────────────

/**
 * Warm the cache across multiple timeframes.
 */
export async function warmMTF({ universe = 50, timeframes = DEFAULT_TFS, symbols: explicitSymbols } = {}) {
  const t0 = Date.now();
  const cache = loadCache();
  const globals = await ensureGlobals();

  let symbolList;
  let screenerTime = 0;

  if (explicitSymbols && explicitSymbols.length > 0) {
    symbolList = explicitSymbols;
  } else {
    const stocks = await readMultiView({ views: ['Overview'], maxRows: universe });
    screenerTime = Date.now() - t0;
    symbolList = stocks.map(s => s.Symbol).filter(Boolean);
  }

  // Filter out already-fresh entries
  const now = Date.now();
  const stale = new Map(); // sym → Set(tf)
  let skipped = 0;

  for (const sym of symbolList) {
    for (const tf of timeframes) {
      const key = cacheKey(sym, tf);
      const entry = cache[key];
      if (entry && getScanTier(entry, now) === 'INSTANT') {
        skipped++;
      } else {
        if (!stale.has(sym)) stale.set(sym, new Set());
        stale.get(sym).add(tf);
      }
    }
  }

  const fetchSymbols = [...stale.keys()];
  const yahooIntervals = [...new Set(
    timeframes.map(tf => TF_CONFIG[tf]?.yahoo).filter(Boolean)
  )];

  // Fetch all data
  const yahooStart = Date.now();
  let warmed = 0, errors = 0;

  if (fetchSymbols.length > 0) {
    const batch = await fetchBatchMultiTF(fetchSymbols, yahooIntervals, 200, 15);

    for (const [sym, tfs] of stale) {
      for (const tf of tfs) {
        const config = TF_CONFIG[tf];
        if (!config) continue;
        const symData = batch.results.get(sym);
        const ohlcvData = symData?.get(config.yahoo);
        if (!ohlcvData || ohlcvData.bars.length < 5) { errors++; continue; }

        const bars = ohlcvData.bars.slice(-200);
        const key = cacheKey(sym, tf);
        const fg = computeFGFromBars(bars, cache[key]?._state || {}, globals);
        if (fg) {
          cache[key] = updateCacheEntry(sym, bars, cache[key], globals);
          warmed++;
        } else {
          errors++;
        }
      }
    }

    saveCache(pruneCache(cache));
  }

  const yahooTime = Date.now() - yahooStart;
  const totalTime = Date.now() - t0;

  return {
    success: true,
    total_symbols: symbolList.length,
    timeframes: timeframes.map(tf => TF_CONFIG[tf]?.label || tf),
    warmed,
    skipped,
    errors,
    timing: {
      screener_ms: screenerTime,
      yahoo_ms: yahooTime,
      total_ms: totalTime,
      total_readable: (totalTime / 1000).toFixed(1) + 's',
    },
  };
}
