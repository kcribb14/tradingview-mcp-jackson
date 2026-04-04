/**
 * Full-Universe Production Scanner — scans EVERYTHING, tiers by confidence.
 *
 * Tier 1 — PROVEN EDGE (validated p<0.01):
 *   Crypto Major 4H: Sharpe 2.33, 65% WR
 *   US Large Cap Daily: Sharpe 0.52, 56% WR
 *   ASX Mining Daily: Sharpe 0.53, 49% WR
 *   Commodities Daily: Sharpe 0.73, 57% WR
 *
 * Tier 2 — WEAK EDGE (p<0.10):
 *   US Mid/Small Daily, ETFs Daily, ASX Top 50, Crypto Major Daily
 *
 * Tier 3 — UNPROVEN (no trade recommendation, information only):
 *   Crypto mid-caps, all other symbols
 *
 * Shows EVERYTHING. The user decides what to act on.
 */
import { fetchBatch, fetchOhlcv } from './unified_data.js';
import { fetchOhlcv as fetchYahooOhlcv } from './yahoo_ohlcv.js';
import {
  loadCache, saveCache, pruneCache, computeFGFromBars,
  updateCacheEntry, loadGlobals, saveGlobals, getScanTier,
} from './fg_cache.js';
import { detectAssetClass, classifyCalibratedZone, calibratedEntry } from './fg_calibrated.js';
import { getUSStocks, getASXStocks, getCryptoTokens } from './universes.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const r2 = v => Math.round(v * 100) / 100;
const CONFIG_DIR = join(homedir(), '.tradingview-mcp', 'config');

// ─── Tier classification ────────────────────────────────────────────────────

const TIER_1_CLASSES = new Set(['US_LARGE_CAP', 'ASX_MINING_MID', 'ASX_MINING_MICRO', 'COMMODITIES']);
const TIER_2_CLASSES = new Set(['US_MID_SMALL', 'ETFS', 'ASX_TOP50', 'CRYPTO_MAJOR']);
// Everything else = Tier 3

const TIER_STATS = {
  US_LARGE_CAP:     { sharpe: 0.52, wr: 56, avgRet: 2.65, posSize: '3-5%', tier: 1 },
  ASX_MINING_MID:   { sharpe: 0.53, wr: 49, avgRet: 6.44, posSize: '3-5%', tier: 1 },
  ASX_MINING_MICRO: { sharpe: 0.53, wr: 49, avgRet: 6.44, posSize: '3-5%', tier: 1 },
  COMMODITIES:      { sharpe: 0.73, wr: 57, avgRet: 2.21, posSize: '3-5%', tier: 1 },
  US_MID_SMALL:     { sharpe: 0.36, wr: 52, avgRet: 7.52, posSize: '1-2%', tier: 2 },
  ETFS:             { sharpe: 0.53, wr: 57, avgRet: 1.85, posSize: '1-2%', tier: 2 },
  ASX_TOP50:        { sharpe: 0.39, wr: 59, avgRet: 1.49, posSize: '1-2%', tier: 2 },
  CRYPTO_MAJOR:     { sharpe: 0.32, wr: 47, avgRet: 3.51, posSize: '1-2%', tier: 2 },
  CRYPTO_MID:       { sharpe: -0.07, wr: 36, avgRet: -0.75, posSize: '0%', tier: 3 },
};

function getTier(cls) {
  if (TIER_1_CLASSES.has(cls)) return 1;
  if (TIER_2_CLASSES.has(cls)) return 2;
  return 3;
}

function getTierLabel(tier) {
  if (tier === 1) return 'PROVEN EDGE';
  if (tier === 2) return 'WEAK EDGE';
  return 'UNPROVEN';
}

// ─── Symbol scores (per-symbol historical adjustment) ───────────────────────

const SYMBOL_SCORES_FILE = join(CONFIG_DIR, 'symbol_scores.json');

function loadSymbolScores() {
  try { return JSON.parse(readFileSync(SYMBOL_SCORES_FILE, 'utf8')); }
  catch { return {}; }
}

// ─── Regime Check ───────────────────────────────────────────────────────────

async function checkRegime() {
  const regimes = {};
  const checks = [
    ['SPY', 'us'], ['BTC', 'crypto'], ['^AXJO', 'asx'], ['GC=F', 'gold'], ['HG=F', 'copper'],
  ];
  await Promise.all(checks.map(async ([sym, key]) => {
    try {
      const data = await fetchOhlcv(sym, 200);
      if (data?.bars?.length >= 200) {
        const closes = data.bars.map(b => b.close);
        let ema200 = closes[0];
        for (let i = 1; i < closes.length; i++) ema200 = 2/201 * closes[i] + (1-2/201) * ema200;
        const last = closes[closes.length - 1];
        regimes[key] = { regime: last > ema200 ? 'BULL' : 'BEAR', price: r2(last), ema200: r2(ema200) };
      }
    } catch {}
  }));
  return regimes;
}

// ─── Globals ────────────────────────────────────────────────────────────────

async function ensureGlobals() {
  const globals = loadGlobals();
  if (globals.lastFetch && (Date.now() - new Date(globals.lastFetch).getTime()) < 3600_000) return globals;
  try {
    const [vix, gold] = await Promise.all([
      fetchYahooOhlcv('^VIX', 30, '1d'), fetchYahooOhlcv('GC=F', 30, '1d'),
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

// ─── Full Universe Production Scan ──────────────────────────────────────────

export async function universeProduction({ us = 2000, asx = 2000, crypto = 200, top = 20 } = {}) {
  const t0 = Date.now();

  // Parallel: regime check + globals + symbol lists
  const [regime, globals] = await Promise.all([checkRegime(), ensureGlobals()]);

  const usStocks = (await getUSStocks()).slice(0, us).map(s => s.symbol);
  const asxStocks = (await getASXStocks()).slice(0, asx).map(s => s.symbol);
  const cryptoTokens = (await getCryptoTokens()).slice(0, crypto).map(t => t.symbol);

  const allSymbols = [...new Set([...usStocks, ...asxStocks, ...cryptoTokens])];
  const cache = loadCache();
  const symbolScores = loadSymbolScores();
  const now = Date.now();

  // Separate cached vs need-fetch
  const results = [];
  const needFetch = [];

  for (const sym of allSymbols) {
    const key = sym.toUpperCase() + ':D';
    const entry = cache[key];
    if (entry && getScanTier(entry, now) === 'INSTANT') {
      results.push(buildResult(sym, entry, symbolScores, regime));
    } else {
      needFetch.push(sym);
    }
  }

  // Batch fetch uncached
  if (needFetch.length > 0) {
    const batch = await fetchBatch(needFetch, 200, 25);
    for (const sym of needFetch) {
      const data = batch.results.get(sym);
      if (data && data.bars.length >= 5) {
        const key = sym.toUpperCase() + ':D';
        const fg = computeFGFromBars(data.bars, cache[key]?._state || {}, globals);
        if (fg) {
          cache[key] = updateCacheEntry(sym, data.bars, cache[key], globals);
          results.push(buildResult(sym, cache[key], symbolScores, regime));
        }
      }
    }
    saveCache(pruneCache(cache));
  }

  const totalTime = Date.now() - t0;

  // Classify into tiers
  const tier1 = [], tier2 = [], tier3 = [];
  const allFear = [];

  for (const r of results) {
    if (r.calibrated_severity <= -2) { // RARE FEAR
      if (r.tier === 1) tier1.push(r);
      else if (r.tier === 2) tier2.push(r);
      else tier3.push(r);
      allFear.push(r);
    } else if (r.calibrated_severity <= -1) { // FEAR (not rare)
      if (r.tier <= 2) tier2.push(r); else tier3.push(r);
    }
  }

  // Sort each tier by depth below threshold
  for (const arr of [tier1, tier2, tier3, allFear]) {
    arr.sort((a, b) => a.fg_score - b.fg_score);
  }

  // Top 20 most extreme (any class)
  const mostExtreme = [...allFear].sort((a, b) => a.distance_to_rare_fear - b.distance_to_rare_fear).slice(0, top);

  // Distribution
  const dist = { extreme_fear: 0, fear: 0, neutral: 0, greed: 0, extreme_greed: 0 };
  for (const r of results) {
    if (r.calibrated_severity === -2) dist.extreme_fear++;
    else if (r.calibrated_severity === -1) dist.fear++;
    else if (r.calibrated_severity === 0) dist.neutral++;
    else if (r.calibrated_severity === 1) dist.greed++;
    else if (r.calibrated_severity === 2) dist.extreme_greed++;
  }

  return {
    success: true,
    scan_type: 'universe-production',
    date: new Date().toISOString().slice(0, 10),
    timing: { total_ms: totalTime, total_readable: (totalTime / 1000).toFixed(1) + 's' },
    regime,
    coverage: {
      total: allSymbols.length,
      scored: results.length,
      in_rare_fear: allFear.length,
    },
    summary: {
      tier1_signals: tier1.length,
      tier2_signals: tier2.length,
      tier3_signals: tier3.length,
    },
    distribution: dist,
    tier1_proven: tier1.slice(0, 15),
    tier2_weak: tier2.slice(0, 15),
    tier3_unproven: tier3.slice(0, 20),
    most_extreme: mostExtreme,
    greed_warnings: [...results].sort((a, b) => b.fg_score - a.fg_score).filter(r => r.calibrated_severity >= 1).slice(0, 10),
  };
}

function buildResult(sym, entry, symbolScores, regime) {
  const cls = detectAssetClass(sym);
  const cal = classifyCalibratedZone(sym, entry.fgScore);
  const tier = getTier(cls);
  const stats = TIER_STATS[cls] || { sharpe: 0, wr: 50, avgRet: 0, posSize: '0%', tier: 3 };
  const symScore = symbolScores[sym.toUpperCase()];

  // Confidence: base from class stats, adjusted by symbol score and regime
  let confidence = Math.round(stats.wr * (tier === 1 ? 1.1 : tier === 2 ? 0.8 : 0.3));
  if (symScore?.wr && symScore.n >= 3) {
    if (symScore.wr > 60) confidence = Math.min(95, confidence + 15);
    else if (symScore.wr < 35) confidence = Math.max(5, confidence - 15);
  }

  // Regime adjustment
  const isUS = cls.startsWith('US_') || cls === 'ETFS';
  const isCrypto = cls.startsWith('CRYPTO');
  if (isUS && regime.us?.regime === 'BEAR') confidence = Math.round(confidence * 0.6);
  if (isCrypto && regime.crypto?.regime === 'BEAR') confidence = Math.round(confidence * 0.6);

  return {
    symbol: sym,
    fg_score: entry.fgScore,
    zone: entry.zone,
    calibrated_zone: cal.zone,
    calibrated_severity: cal.severity,
    class: cls,
    tier,
    tier_label: getTierLabel(tier),
    confidence,
    position_size: cal.severity <= -2 ? stats.posSize : '0%',
    expected_return: stats.avgRet + '% avg 30d',
    sharpe: stats.sharpe,
    win_rate: stats.wr + '%',
    distance_to_rare_fear: cal.distance_to_rare_fear,
    is_rare_fear: cal.is_triggered,
    rsi: entry.rsi,
    components: entry.components,
    symbol_score: symScore || null,
  };
}

// ─── Watch List ─────────────────────────────────────────────────────────────

export async function watchList() {
  const cache = loadCache();
  const approaching = [];

  for (const [key, entry] of Object.entries(cache)) {
    if (!key.endsWith(':D') || !entry.fgScore) continue;
    const sym = key.replace(':D', '');
    const cal = classifyCalibratedZone(sym, entry.fgScore);
    if (cal.distance_to_rare_fear > 0 && cal.distance_to_rare_fear <= 5) {
      approaching.push({
        symbol: sym, fg_score: entry.fgScore, class: cal.class,
        tier: getTier(cal.class), distance: r2(cal.distance_to_rare_fear),
        threshold: cal.thresholds.extreme_fear, zone: cal.zone,
      });
    }
  }

  approaching.sort((a, b) => a.distance - b.distance);
  return { success: true, approaching_fear: approaching.slice(0, 50), total: approaching.length };
}

// ─── Historical Outperformers ───────────────────────────────────────────────

export async function analyzeOutperformers() {
  const resultsFile = '/tmp/4h_massive_results.json';
  if (!existsSync(resultsFile)) return { error: 'Run tv scan backtest first to generate data' };

  const { allEvents, perSymbol } = JSON.parse(readFileSync(resultsFile, 'utf8'));

  // Group events by symbol, compute per-symbol stats
  const bySymbol = {};
  for (const e of allEvents) {
    if (!e.ret || !isFinite(e.ret) || Math.abs(e.ret) > 300) continue;
    if (!bySymbol[e.sym]) bySymbol[e.sym] = { sym: e.sym, cls: e.cls, events: [] };
    bySymbol[e.sym].events.push(e);
  }

  const scored = [];
  for (const [sym, data] of Object.entries(bySymbol)) {
    const rets = data.events.map(e => e.ret);
    const n = rets.length;
    if (n < 1) continue;
    const avg = r2(rets.reduce((s, v) => s + v, 0) / n);
    const wr = Math.round(rets.filter(v => v > 0).length / n * 100);
    const best = r2(Math.max(...rets));
    const worst = r2(Math.min(...rets));
    scored.push({ symbol: sym, class: data.cls, n, avg, wr, best, worst });
  }

  // Rank by avg return
  scored.sort((a, b) => b.avg - a.avg);

  // Save symbol scores for production use
  const symbolScores = {};
  for (const s of scored) {
    if (s.n >= 2) {
      symbolScores[s.symbol.toUpperCase()] = { n: s.n, avg: s.avg, wr: s.wr };
    }
  }
  if (!existsSync(CONFIG_DIR)) { const { mkdirSync } = await import('fs'); mkdirSync(CONFIG_DIR, { recursive: true }); }
  writeFileSync(SYMBOL_SCORES_FILE, JSON.stringify(symbolScores, null, 2));

  return {
    success: true,
    total_symbols: scored.length,
    symbols_scored: Object.keys(symbolScores).length,
    top_50: scored.slice(0, 50),
    bottom_50: scored.slice(-50).reverse(),
    saved_to: SYMBOL_SCORES_FILE,
  };
}
