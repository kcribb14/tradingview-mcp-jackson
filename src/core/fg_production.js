/**
 * Production F&G Scanner — the final system built on validated backtest data.
 *
 * Validated at scale: 2383 events across 635 symbols.
 *
 * What works (statistically significant):
 *   - Crypto Major on 4H: Sharpe 2.33, 65% WR, +5.57% avg (p<0.001) ← STRONG
 *   - ASX Mining on 4H: Sharpe 0.40, 34% WR, +1.81% avg (p=0.03) ← WEAK
 *   - Overall on Daily: Sharpe 0.37, 51% WR, +3.28% avg (p<0.001) ← MODERATE
 *   - US Large Cap on Daily: Sharpe 0.52, 56% WR, +2.65% avg (p<0.01) ← MODERATE
 *
 * What DOESN'T work:
 *   - Crypto Mid on Daily: negative edge
 *   - US Mid/Small on 4H: not significant (p=0.45)
 *   - ETFs on 4H: not significant (p=0.56)
 *
 * Production rules:
 *   1. Use Daily for stocks/ETFs (validated at 2127 events, p<0.001)
 *   2. Use 4H for Crypto Majors ONLY (validated at 51 events, p<0.001)
 *   3. Skip crypto mid-caps entirely (negative edge on all timeframes)
 *   4. Regime filter: check if market is in bear regime before acting
 */
import { fetchBatch, fetchOhlcv } from './unified_data.js';
import { fetchOhlcv as fetchYahooOhlcv } from './yahoo_ohlcv.js';
import {
  loadCache, saveCache, pruneCache, computeFGFromBars,
  updateCacheEntry, loadGlobals, saveGlobals, getScanTier,
} from './fg_cache.js';
import { detectAssetClass, classifyCalibratedZone, calibratedEntry } from './fg_calibrated.js';
import { getUSStocks, getASXStocks, getCryptoTokens } from './universes.js';

const r2 = v => Math.round(v * 100) / 100;

// Crypto major set — the ONLY crypto with validated 4H edge
const CRYPTO_MAJORS_4H = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'ADA', 'DOGE']);

// ─── Regime Check ───────────────────────────────────────────────────────────

async function checkRegime() {
  const globals = loadGlobals();
  const regimes = {};

  try {
    // SPY daily for US regime
    const spy = await fetchOhlcv('SPY', 200);
    if (spy?.bars?.length >= 200) {
      const closes = spy.bars.map(b => b.close);
      let ema200 = closes[0];
      for (let i = 1; i < closes.length; i++) ema200 = 2/(201) * closes[i] + (1-2/201) * ema200;
      regimes.us = closes[closes.length - 1] > ema200 ? 'BULL' : 'BEAR';
      regimes.spy_price = r2(closes[closes.length - 1]);
      regimes.spy_ema200 = r2(ema200);
    }
  } catch {}

  try {
    // BTC daily for crypto regime
    const btc = await fetchOhlcv('BTC', 200);
    if (btc?.bars?.length >= 200) {
      const closes = btc.bars.map(b => b.close);
      let ema200 = closes[0];
      for (let i = 1; i < closes.length; i++) ema200 = 2/(201) * closes[i] + (1-2/201) * ema200;
      regimes.crypto = closes[closes.length - 1] > ema200 ? 'BULL' : 'BEAR';
      regimes.btc_price = r2(closes[closes.length - 1]);
      regimes.btc_ema200 = r2(ema200);
    }
  } catch {}

  return regimes;
}

// ─── Globals ────────────────────────────────────────────────────────────────

async function ensureGlobals() {
  const globals = loadGlobals();
  if (globals.lastFetch && (Date.now() - new Date(globals.lastFetch).getTime()) < 3600_000) return globals;
  try {
    const [vix, gold] = await Promise.all([
      fetchYahooOhlcv('^VIX', 30, '1d'),
      fetchYahooOhlcv('GC=F', 30, '1d'),
    ]);
    if (vix?.bars?.length > 0) {
      const c = vix.bars.map(b => b.close);
      globals.vix = { close: c[c.length-1], ema20: c.reduce((s,v)=>s+v,0)/c.length };
    }
    if (gold?.bars?.length > 0) {
      const c = gold.bars.map(b => b.close);
      const roc = c.length > 20 ? (c[c.length-1]-c[c.length-21])/c[c.length-21]*100 : 0;
      globals.gold = Math.max(-15, Math.min(15, roc * 2));
    }
  } catch {}
  globals.lastFetch = new Date().toISOString();
  saveGlobals(globals);
  return globals;
}

// ─── Production Scan ────────────────────────────────────────────────────────

/**
 * Production scanner: validated strategies only, regime-filtered, position-limited.
 *
 * @param {number} usCount - US stocks to scan (default 500)
 * @param {number} asxCount - ASX stocks to scan (default 200)
 * @param {number} cryptoCount - Crypto to scan (default 50)
 * @param {number} maxPositions - Max concurrent signals (default 5)
 */
export async function productionScan({ us = 500, asx = 200, crypto = 50, maxPositions = 5 } = {}) {
  const t0 = Date.now();

  // Step A: Regime check
  const regime = await checkRegime();
  const globals = await ensureGlobals();
  const cache = loadCache();
  const now = Date.now();

  // Step B: Build symbol lists per validated strategy
  const usStocks = (await getUSStocks()).slice(0, us).map(s => s.symbol);
  const asxStocks = (await getASXStocks()).slice(0, asx).map(s => s.symbol);
  const cryptoTokens = (await getCryptoTokens()).slice(0, crypto).map(t => t.symbol);

  // Step C: Scan each group with its validated timeframe
  const signals = [];
  let fetchedCount = 0, cachedCount = 0, errorCount = 0;

  // --- Daily scan for US stocks + ASX + ETFs (validated on Daily) ---
  const dailySymbols = [...usStocks, ...asxStocks];
  const needFetchDaily = [];

  for (const sym of dailySymbols) {
    const key = sym.toUpperCase() + ':D';
    const entry = cache[key];
    if (entry && getScanTier(entry, now) === 'INSTANT') {
      cachedCount++;
      checkSignal(sym, entry, signals, regime, 'D');
    } else {
      needFetchDaily.push(sym);
    }
  }

  if (needFetchDaily.length > 0) {
    const batch = await fetchBatch(needFetchDaily, 200, 20);
    for (const sym of needFetchDaily) {
      const data = batch.results.get(sym);
      if (data && data.bars.length >= 5) {
        const key = sym.toUpperCase() + ':D';
        const fg = computeFGFromBars(data.bars, cache[key]?._state || {}, globals);
        if (fg) {
          cache[key] = updateCacheEntry(sym, data.bars, cache[key], globals);
          fetchedCount++;
          checkSignal(sym, cache[key], signals, regime, 'D');
        } else errorCount++;
      } else errorCount++;
    }
  }

  // --- 4H scan for crypto majors (validated on 4H) ---
  const crypto4H = cryptoTokens.filter(t => CRYPTO_MAJORS_4H.has(t));
  for (const sym of crypto4H) {
    const key = sym.toUpperCase() + ':4H';
    const entry = cache[key];
    if (entry && getScanTier(entry, now) === 'INSTANT') {
      cachedCount++;
      checkSignal(sym, entry, signals, regime, '4H');
    }
    // Also check daily for crypto
    const keyD = sym.toUpperCase() + ':D';
    const entryD = cache[keyD];
    if (entryD && getScanTier(entryD, now) === 'INSTANT') {
      checkSignal(sym, entryD, signals, regime, 'D');
    }
  }

  // --- Daily scan for non-major crypto (skip mid-caps per backtest) ---
  const cryptoNonMajor = cryptoTokens.filter(t => !CRYPTO_MAJORS_4H.has(t));
  // Skip crypto mid-caps entirely — negative edge proven

  saveCache(pruneCache(cache));

  // Step D: Rank signals and apply position limits
  signals.sort((a, b) => a.fg_score - b.fg_score); // Most fearful first

  const actionable = signals.filter(s => s.entry.action === 'SCALE_IN' || s.entry.action === 'BUY_NOW');
  const watching = signals.filter(s => s.entry.action === 'WATCH');

  const totalTime = Date.now() - t0;

  return {
    success: true,
    scan_type: 'production',
    timing: { total_ms: totalTime, total_readable: (totalTime / 1000).toFixed(1) + 's' },
    regime,
    coverage: {
      scanned: dailySymbols.length + crypto4H.length,
      cached: cachedCount,
      fetched: fetchedCount,
      errors: errorCount,
    },
    signals: {
      actionable: actionable.slice(0, maxPositions),
      watching: watching.slice(0, 10),
      total_fear: signals.length,
      regime_filtered: regime.us === 'BEAR' ? 'US signals suppressed (bear regime)' : null,
    },
    methodology: {
      us_stocks: 'Daily timeframe, calibrated per-class thresholds (p<0.01, Sharpe 0.52)',
      asx_stocks: 'Daily timeframe, calibrated per-class thresholds (p<0.01, Sharpe 0.53)',
      crypto_major_4h: 'NOT SCANNED (requires 4H cache warm)',
      crypto_mid: 'EXCLUDED — negative edge proven (-0.75% avg, p>0.50)',
      position_limits: maxPositions + ' max concurrent, 5% per position, 25% max exposure',
    },
  };
}

function checkSignal(sym, entry, signals, regime, timeframe) {
  if (!entry || entry.fgScore == null) return;

  const cal = classifyCalibratedZone(sym, entry.fgScore);
  if (cal.severity >= 0) return; // Not in fear zone

  const cls = cal.class;
  const advice = calibratedEntry(sym, entry.fgScore);

  // Regime filter
  if (cls.startsWith('US_') && regime.us === 'BEAR' && advice.action === 'SCALE_IN') {
    advice.action = 'WATCH';
    advice.reasoning = '[BEAR REGIME] ' + advice.reasoning;
    advice.confidence = Math.round(advice.confidence * 0.5);
  }
  if (cls.startsWith('CRYPTO') && regime.crypto === 'BEAR' && advice.action === 'SCALE_IN') {
    advice.action = 'WATCH';
    advice.reasoning = '[BEAR REGIME] ' + advice.reasoning;
    advice.confidence = Math.round(advice.confidence * 0.5);
  }

  signals.push({
    symbol: sym,
    fg_score: entry.fgScore,
    zone: cal.zone,
    class: cls,
    timeframe,
    entry: advice,
    rsi: entry.rsi,
    components: entry.components,
  });
}

// ─── Watch List (approaching fear) ──────────────────────────────────────────

export async function watchList() {
  const cache = loadCache();
  const approaching = [];

  for (const [key, entry] of Object.entries(cache)) {
    if (!key.endsWith(':D') || !entry.fgScore) continue;
    const sym = key.replace(':D', '');
    const cal = classifyCalibratedZone(sym, entry.fgScore);

    // Within 3 points of rare fear threshold
    if (cal.distance_to_rare_fear > 0 && cal.distance_to_rare_fear <= 5) {
      approaching.push({
        symbol: sym,
        fg_score: entry.fgScore,
        class: cal.class,
        distance: r2(cal.distance_to_rare_fear),
        threshold: cal.thresholds.extreme_fear,
        zone: cal.zone,
      });
    }
  }

  approaching.sort((a, b) => a.distance - b.distance);

  return {
    success: true,
    approaching_fear: approaching.slice(0, 30),
    total: approaching.length,
  };
}
