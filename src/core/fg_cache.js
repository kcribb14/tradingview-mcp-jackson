/**
 * Incremental F&G cache — file-backed, EMA/RMA state-persistent.
 *
 * Cache tiers:
 *   INSTANT    (0ms)  — scanned <1hr ago, market closed → return cached
 *   MICRO      (5ms)  — scanned <4hrs ago → fetch 1-5 new bars, update EMA
 *   PARTIAL   (50ms)  — scanned >4hrs ago → fetch 20-50 new bars, update state
 *   FULL     (200ms)  — never scanned → fetch 200 bars, full calc, save state
 *
 * EMA(144) is recursive: ema_new = alpha * close + (1 - alpha) * ema_prev
 * So updating with 1 new bar is a single multiply — no need to recalculate 144 bars.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { classifyZone } from './fg_scanner.js';

// ─── Cache paths ────────────────────────────────────────────────────────────

const CACHE_DIR = join(homedir(), '.tradingview-mcp', 'cache');
const SCORES_FILE = join(CACHE_DIR, 'fg_scores.json');
const GLOBALS_FILE = join(CACHE_DIR, 'fg_globals.json');
const MAX_ENTRIES = 20000; // symbols × timeframes
const EXPIRE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Build a cache key for symbol + timeframe.
 * e.g., "AAPL:D", "AAPL:60", "AAPL:240", "AAPL:15"
 */
export function cacheKey(symbol, tf = 'D') {
  return `${symbol}:${tf}`;
}

// ─── EMA / RMA math ────────────────────────────────────────────────────────

/**
 * Update a single EMA value with one new data point.
 * EMA is recursive: ema = alpha * value + (1 - alpha) * prevEma
 */
export function updateEMA(prevEma, newValue, period) {
  if (prevEma == null) return newValue;
  const alpha = 2 / (period + 1);
  return alpha * newValue + (1 - alpha) * prevEma;
}

/**
 * Update a single RMA (Wilder's smoothing) value with one new data point.
 * RMA = (prevRma * (period - 1) + newValue) / period
 */
export function updateRMA(prevRma, newValue, period) {
  if (prevRma == null) return newValue;
  return (prevRma * (period - 1) + newValue) / period;
}

/**
 * Calculate EMA from scratch over a full array of values.
 * Returns the final EMA value.
 */
export function calcEMA(values, period) {
  if (!values || values.length === 0) return null;
  let ema = values[0];
  const alpha = 2 / (period + 1);
  for (let i = 1; i < values.length; i++) {
    ema = alpha * values[i] + (1 - alpha) * ema;
  }
  return ema;
}

/**
 * Calculate RMA from scratch over a full array of values.
 */
export function calcRMA(values, period) {
  if (!values || values.length === 0) return null;
  let rma = values[0];
  for (let i = 1; i < values.length; i++) {
    rma = (rma * (period - 1) + values[i]) / period;
  }
  return rma;
}

/**
 * Calculate RSI from cached gains/losses RMA state + new bars.
 */
export function calcRSI(avgGain, avgLoss) {
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ─── F&G calculation from OHLCV + state ─────────────────────────────────────

/**
 * Compute the 5 F&G components from OHLCV data and cached EMA state.
 *
 * Components:
 *   pmacd      — price deviation from EMA(144)
 *   ror        — rate of return (close vs close[N] ago)
 *   moneyFlow  — volume-weighted price pressure
 *   vix        — volatility (inverted high-low range)
 *   gold       — safe-haven flow (from global cache)
 */
export function computeFGFromBars(bars, state = {}, globals = {}) {
  if (!bars || bars.length < 5) return null;

  const closes = bars.map(b => b.close);
  const lastClose = closes[closes.length - 1];
  const lastBar = bars[bars.length - 1];

  // ── pmacd: price vs EMA(144) ──
  // DGT uses: (close / ema144 - 1) * 100, then applies RMA smoothing
  let ema144 = state.ema144 ?? null;
  if (ema144 == null) {
    ema144 = calcEMA(closes, 144);
  } else {
    for (const c of closes) {
      ema144 = updateEMA(ema144, c, 144);
    }
  }
  const pmacdRaw = ema144 > 0 ? (lastClose / ema144 - 1) * 100 : 0;
  // Scale: 1% deviation = ~3 points, no hard clamp (let extremes show)
  const pmacd = pmacdRaw * 3;

  // ── ror: rate of return over 20 bars ──
  const refClose = bars.length > 20 ? closes[closes.length - 21] : closes[0];
  const rorRaw = refClose > 0 ? (lastClose - refClose) / refClose * 100 : 0;
  const ror = rorRaw * 2;

  // ── moneyFlow: MFI-style calculation over 14 bars ──
  // DGT uses Money Flow Index: cumulative positive/negative flow ratio
  const mfPeriod = Math.min(14, bars.length - 1);
  const mfBars = bars.slice(-mfPeriod - 1);
  let posFlow = 0, negFlow = 0;
  for (let i = 1; i < mfBars.length; i++) {
    const tp = (mfBars[i].high + mfBars[i].low + mfBars[i].close) / 3;
    const prevTp = (mfBars[i-1].high + mfBars[i-1].low + mfBars[i-1].close) / 3;
    const rawMf = tp * (mfBars[i].volume || 0);
    if (tp > prevTp) posFlow += rawMf;
    else if (tp < prevTp) negFlow += rawMf;
  }
  const mfi = negFlow > 0 ? 100 - 100 / (1 + posFlow / negFlow) : (posFlow > 0 ? 100 : 50);
  // MFI 50 = neutral, >70 = overbought (greed), <30 = oversold (fear)
  const moneyFlow = (mfi - 50) * 1.2;

  // ── vix: volatility proxy from ATR-style calculation ──
  // DGT uses VIX-relative measure; we approximate with ATR/close ratio
  const atrPeriod = Math.min(14, bars.length - 1);
  const atrBars = bars.slice(-atrPeriod);
  let atrSum = 0;
  for (const b of atrBars) {
    atrSum += (b.high - b.low);
  }
  const atr = atrSum / atrBars.length;
  const atrPct = lastClose > 0 ? (atr / lastClose) * 100 : 0;
  // ATR% of 1.5% is normal; higher = fear, lower = complacency
  const vixProxy = -(atrPct - 1.5) * 10;

  // ── gold: from global cache ──
  const goldProxy = globals.gold ?? 0;

  // ── RSI from state or bars ──
  let rsi = state.rsi ?? null;
  let avgGain = state.avgGain ?? null;
  let avgLoss = state.avgLoss ?? null;
  if (avgGain == null || avgLoss == null) {
    // Calculate from scratch
    let gains = 0, losses = 0;
    for (let i = 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff > 0) gains += diff; else losses += Math.abs(diff);
    }
    avgGain = gains / (closes.length - 1);
    avgLoss = losses / (closes.length - 1);
  } else {
    // Update incrementally
    for (const c of closes) {
      if (state._lastClose != null) {
        const diff = c - state._lastClose;
        avgGain = updateRMA(avgGain, diff > 0 ? diff : 0, 14);
        avgLoss = updateRMA(avgLoss, diff < 0 ? Math.abs(diff) : 0, 14);
      }
      state._lastClose = c;
    }
  }
  rsi = calcRSI(avgGain, avgLoss);

  // ── Composite F&G score ──
  // DGT averages all 5 components equally, then applies RMA smoothing
  const components = { pmacd, ror, moneyFlow, vix: vixProxy, gold: goldProxy };
  const raw = (pmacd + ror + moneyFlow + vixProxy + goldProxy) / 5;
  // Soft compression: linear within [-60,60], compressed beyond (no hard clamp)
  // This preserves differentiation at extremes while keeping the scale readable
  const fgScore = Math.round(softCompress(raw) * 100) / 100;
  const { zone, severity } = classifyZone(fgScore);

  return {
    fgScore,
    zone,
    severity,
    components: {
      pmacd: round(pmacd),
      ror: round(ror),
      moneyFlow: round(moneyFlow),
      vix: round(vixProxy),
      gold: round(goldProxy),
    },
    rsi: round(rsi),
    // State to persist for incremental updates
    _state: {
      ema144,
      avgGain,
      avgLoss,
      rsi,
      lastClose,
      lastBarTime: lastBar.time,
    },
  };
}

function round(v) { return v != null ? Math.round(v * 100) / 100 : null; }

/**
 * Soft compression: linear within [-60, 60], logarithmically compressed beyond.
 * Maps (-∞,∞) → (~-100, ~100) while preserving full differentiation.
 */
function softCompress(v) {
  const limit = 60;
  if (Math.abs(v) <= limit) return v;
  const sign = v > 0 ? 1 : -1;
  const excess = Math.abs(v) - limit;
  // Log compression: 60 + 20*ln(1 + excess/20) — approaches ~100 asymptotically
  return sign * (limit + 20 * Math.log(1 + excess / 20));
}

// ─── Cache I/O ──────────────────────────────────────────────────────────────

function ensureDir() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

export function loadCache() {
  try {
    return JSON.parse(readFileSync(SCORES_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function saveCache(cache) {
  ensureDir();
  writeFileSync(SCORES_FILE, JSON.stringify(cache, null, 2));
}

export function loadGlobals() {
  try {
    return JSON.parse(readFileSync(GLOBALS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function saveGlobals(globals) {
  ensureDir();
  writeFileSync(GLOBALS_FILE, JSON.stringify(globals, null, 2));
}

// ─── Cache entry management ─────────────────────────────────────────────────

/**
 * Determine the scan tier for a cached symbol.
 *
 *   INSTANT  — <1hr old, market closed
 *   MICRO    — <4hrs old
 *   PARTIAL  — <24hrs old
 *   FULL     — no cache or >24hrs old
 */
export function getScanTier(entry, now = Date.now()) {
  if (!entry || !entry.lastScanTime) return 'FULL';

  const age = now - new Date(entry.lastScanTime).getTime();
  const hours = age / (1000 * 60 * 60);

  if (hours < 1) return 'INSTANT';
  if (hours < 4) return 'MICRO';
  if (hours < 24) return 'PARTIAL';
  return 'FULL';
}

/**
 * Get the number of new bars to fetch based on scan tier.
 */
export function getBarsForTier(tier) {
  switch (tier) {
    case 'INSTANT': return 0;
    case 'MICRO':   return 5;
    case 'PARTIAL': return 50;
    case 'FULL':    return 200;
    default:        return 200;
  }
}

/**
 * Build or update a cache entry from new OHLCV bars.
 */
export function updateCacheEntry(symbol, bars, existingEntry, globals = {}) {
  const state = existingEntry?._state || {};
  const result = computeFGFromBars(bars, state, globals);
  if (!result) return existingEntry; // no change if computation failed

  return {
    lastScanTime: new Date().toISOString(),
    lastBarTime: result._state.lastBarTime,
    ema144: result._state.ema144,
    avgGain: result._state.avgGain,
    avgLoss: result._state.avgLoss,
    rsi: result.rsi,
    lastClose: result._state.lastClose,
    fgScore: result.fgScore,
    components: result.components,
    zone: result.zone,
    severity: result.severity,
    barCount: bars.length,
    _state: result._state,
  };
}

/**
 * Prune cache: remove expired entries and enforce size limit.
 */
export function pruneCache(cache) {
  const now = Date.now();
  const entries = Object.entries(cache);

  // Remove expired (>7 days)
  const valid = entries.filter(([, v]) => {
    if (!v.lastScanTime) return false;
    return (now - new Date(v.lastScanTime).getTime()) < EXPIRE_MS;
  });

  // Sort by lastScanTime desc, keep only MAX_ENTRIES
  valid.sort((a, b) => new Date(b[1].lastScanTime) - new Date(a[1].lastScanTime));
  const pruned = valid.slice(0, MAX_ENTRIES);

  const result = {};
  for (const [k, v] of pruned) result[k] = v;
  return result;
}

// ─── Global components (VIX, Gold) ──────────────────────────────────────────

/**
 * Fetch VIX and Gold values via chart data.
 * Called once per scan session, results cached for all symbols.
 */
export async function fetchGlobals(getOhlcvFn, setSymbolFn, currentSymbol) {
  const globals = loadGlobals();
  const now = Date.now();

  // Only refresh if >1hr stale
  if (globals.lastFetch && (now - new Date(globals.lastFetch).getTime()) < 3600_000) {
    return globals;
  }

  try {
    // Fetch VIX
    await setSymbolFn({ symbol: 'CBOE:VIX' });
    await new Promise(r => setTimeout(r, 1500));
    const vixBars = await getOhlcvFn({ count: 30, summary: false });
    if (vixBars?.bars?.length > 0) {
      const vixClose = vixBars.bars[vixBars.bars.length - 1].close;
      const vixEma = calcEMA(vixBars.bars.map(b => b.close), 20);
      globals.vix = {
        close: vixClose,
        ema20: vixEma,
        deviation: vixEma > 0 ? (vixClose / vixEma - 1) * 100 : 0,
      };
    }
  } catch { /* VIX fetch failed — use cached or 0 */ }

  try {
    // Fetch Gold
    await setSymbolFn({ symbol: 'COMEX:GC1!' });
    await new Promise(r => setTimeout(r, 1500));
    const goldBars = await getOhlcvFn({ count: 30, summary: false });
    if (goldBars?.bars?.length > 0) {
      const closes = goldBars.bars.map(b => b.close);
      const goldRoc = closes.length > 20
        ? (closes[closes.length - 1] - closes[closes.length - 21]) / closes[closes.length - 21] * 100
        : 0;
      globals.gold = Math.max(-15, Math.min(15, goldRoc * 2));
      globals.goldClose = closes[closes.length - 1];
    }
  } catch { /* Gold fetch failed — use cached or 0 */ }

  // Restore original symbol
  try { await setSymbolFn({ symbol: currentSymbol }); } catch {}

  globals.lastFetch = new Date().toISOString();
  saveGlobals(globals);
  return globals;
}

// ─── Cache stats ────────────────────────────────────────────────────────────

export function getCacheStats() {
  const cache = loadCache();
  const globals = loadGlobals();
  const symbols = Object.keys(cache);
  const now = Date.now();

  const tiers = { INSTANT: 0, MICRO: 0, PARTIAL: 0, FULL: 0 };
  let totalAge = 0;
  let oldest = null, newest = null;

  for (const sym of symbols) {
    const entry = cache[sym];
    const tier = getScanTier(entry, now);
    tiers[tier]++;
    if (entry.lastScanTime) {
      const t = new Date(entry.lastScanTime).getTime();
      totalAge += now - t;
      if (!oldest || t < oldest) oldest = t;
      if (!newest || t > newest) newest = t;
    }
  }

  const zones = { EXTREME_FEAR: 0, FEAR: 0, NEUTRAL: 0, GREED: 0, EXTREME_GREED: 0 };
  for (const sym of symbols) {
    const z = cache[sym].zone?.replace(' ', '_') || 'NEUTRAL';
    if (zones[z] !== undefined) zones[z]++;
  }

  return {
    success: true,
    total_symbols: symbols.length,
    staleness: tiers,
    zones,
    avg_age_hours: symbols.length > 0 ? round(totalAge / symbols.length / 3600_000) : 0,
    oldest: oldest ? new Date(oldest).toISOString() : null,
    newest: newest ? new Date(newest).toISOString() : null,
    globals: {
      vix: globals.vix ?? null,
      gold: globals.gold ?? null,
      lastFetch: globals.lastFetch ?? null,
    },
    cache_file: SCORES_FILE,
  };
}

export function clearCache() {
  const cache = loadCache();
  const count = Object.keys(cache).length;
  saveCache({});
  saveGlobals({});
  return { success: true, cleared: count };
}
