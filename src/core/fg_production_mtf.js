/**
 * Multi-Timeframe Full-Universe Production Scanner.
 *
 * Fetches 15m bars ONCE per symbol, derives 1H/4H in JS.
 * Reads Daily from warm cache. One fetch = four timeframes.
 *
 * 4000+ symbols × 4 TFs = 16,000+ F&G scores.
 */
import {
  loadCache, saveCache, pruneCache, computeFGFromBars,
  updateCacheEntry, loadGlobals, saveGlobals, getScanTier, cacheKey,
} from './fg_cache.js';
import { computeTimeSeries } from './fg_backtest.js';
import { detectAssetClass, classifyCalibratedZone } from './fg_calibrated.js';
import { getUSStocks, getASXStocks, getCryptoTokens } from './universes.js';
import { fetchOhlcv as fetchYahooOhlcv } from './yahoo_ohlcv.js';
import { fetchOhlcv } from './unified_data.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const r2 = v => Math.round(v * 100) / 100;
const SCORES_FILE = join(homedir(), '.tradingview-mcp', 'config', 'symbol_scores.json');

// ─── Tier config ────────────────────────────────────────────────────────────

const TIER_1 = new Set(['US_LARGE_CAP', 'ASX_MINING_MID', 'ASX_MINING_MICRO', 'COMMODITIES']);
const TIER_2 = new Set(['US_MID_SMALL', 'ETFS', 'ASX_TOP50', 'CRYPTO_MAJOR']);
function getTier(cls) { return TIER_1.has(cls) ? 1 : TIER_2.has(cls) ? 2 : 3; }

const TIER_STATS = {
  US_LARGE_CAP: { wr: 56, ret: 2.65 }, US_MID_SMALL: { wr: 52, ret: 7.52 },
  ASX_TOP50: { wr: 59, ret: 1.49 }, ASX_MINING_MID: { wr: 49, ret: 6.44 },
  ASX_MINING_MICRO: { wr: 49, ret: 6.44 }, CRYPTO_MAJOR: { wr: 47, ret: 3.51 },
  CRYPTO_MID: { wr: 36, ret: -0.75 }, COMMODITIES: { wr: 57, ret: 2.21 },
  ETFS: { wr: 57, ret: 1.85 },
};

// ─── Batch 15m fetcher ──────────────────────────────────────────────────────

async function fetchYahoo15m(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=15m&range=60d&includePrePost=false`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const d = await r.json();
    const chart = d?.chart?.result?.[0];
    if (!chart?.timestamp) return null;
    const q = chart.indicators.quote[0];
    const bars = [];
    for (let i = 0; i < chart.timestamp.length; i++) {
      if (q.open?.[i] != null && q.close?.[i] != null && q.high?.[i] != null && q.low?.[i] != null) {
        bars.push({ time: chart.timestamp[i], open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume?.[i] || 0 });
      }
    }
    return bars.length >= 150 ? bars : null;
  } catch { return null; }
}

async function fetchBinance15m(sym) {
  const pair = sym.replace(/-/g, '') + 'USDT';
  let all = [];
  let st = Date.now() - 60 * 86400000;
  for (let i = 0; i < 7; i++) {
    try {
      const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=15m&limit=1000&startTime=${st}`, { signal: AbortSignal.timeout(5000) });
      const d = await r.json();
      if (!Array.isArray(d) || !d.length) break;
      all.push(...d.map(b => ({ time: Math.floor(b[0] / 1000), open: +b[1], high: +b[2], low: +b[3], close: +b[4], volume: +b[5] })));
      st = d[d.length - 1][0] + 900000;
      if (st > Date.now()) break;
    } catch { break; }
  }
  return all.length >= 150 ? all : null;
}

function aggregate(bars, n) {
  const result = [];
  for (let i = 0; i < bars.length; i += n) {
    const g = bars.slice(i, i + n);
    if (!g.length) continue;
    result.push({
      time: g[0].time, open: g[0].open,
      high: Math.max(...g.map(b => b.high)),
      low: Math.min(...g.map(b => b.low)),
      close: g[g.length - 1].close,
      volume: g.reduce((s, b) => s + b.volume, 0),
    });
  }
  return result;
}

// ─── Compute F&G on last N bars (quick, no full series needed) ──────────────

function quickFG(bars) {
  if (!bars || bars.length < 150) return null;
  // Use last 200 bars max
  const use = bars.slice(-200);
  const series = computeTimeSeries(use);
  if (series.length === 0) return null;
  const last = series[series.length - 1];
  return { fg: last.fg_score, zone: last.zone, severity: last.severity };
}

// ─── Main scanner ───────────────────────────────────────────────────────────

const CRYPTO_SET = new Set([
  'BTC','ETH','SOL','XRP','BNB','ADA','DOGE','AVAX','DOT','LINK',
  'SHIB','UNI','AAVE','LTC','NEAR','ATOM','FTM','ALGO','SAND','HBAR',
  'APT','ARB','OP','SUI','SEI','TIA','INJ','PEPE','WLD','FET','RNDR',
  'GRT','MKR','CRV','COMP','SNX','LDO','BONK','WIF','JUP','ENA',
  'PENDLE','ETHFI','STRK','ZK','EIGEN','GRASS','ONDO','MANA','AXS','IMX',
]);

export async function productionMTF({ us = 2000, asx = 2000, crypto = 500, top = 30 } = {}) {
  const t0 = Date.now();

  // Load daily cache + globals + symbol scores
  const cache = loadCache();
  const globals = loadGlobals();
  const now = Date.now();
  let symbolScores = {};
  try { symbolScores = JSON.parse(readFileSync(SCORES_FILE, 'utf8')); } catch {}

  // Build symbol list
  const usStocks = (await getUSStocks()).slice(0, us).map(s => s.symbol);
  const asxStocks = (await getASXStocks()).slice(0, asx).map(s => s.symbol);
  const cryptoTokens = (await getCryptoTokens()).slice(0, crypto).map(t => t.symbol);
  const extras = [
    'GC=F','SI=F','CL=F','HG=F','PL=F','NG=F',
    'SPY','QQQ','DIA','IWM','GDX','GDXJ','URA','LIT','GLD','SLV','TLT','XLE','XLF','XLK',
    'AUDUSD=X','EURUSD=X','GBPUSD=X','^VIX','^GSPC','^AXJO',
  ];
  const allSymbols = [...new Set([...usStocks, ...asxStocks, ...cryptoTokens, ...extras])];

  const listTime = Date.now() - t0;

  // ── Phase 1: Read daily from cache ──
  const dailyScores = new Map();
  for (const sym of allSymbols) {
    const key = sym.toUpperCase() + ':D';
    const entry = cache[key];
    if (entry?.fgScore != null) {
      dailyScores.set(sym, { fg: entry.fgScore, zone: entry.zone, severity: entry.severity });
    }
  }

  // ── Phase 2: Fetch 15m bars for all symbols, derive 1H/4H ──
  const t15 = Date.now();
  const mtfScores = new Map(); // sym → { '15m': {fg,zone}, '1H': {}, '4H': {} }
  let fetched15m = 0, failed15m = 0;

  // Batch fetch
  for (let i = 0; i < allSymbols.length; i += 50) {
    const batch = allSymbols.slice(i, i + 50);
    const promises = batch.map(async (sym) => {
      try {
        const isCrypto = CRYPTO_SET.has(sym.toUpperCase());
        const bars15m = isCrypto ? await fetchBinance15m(sym) : await fetchYahoo15m(sym);
        if (!bars15m || bars15m.length < 150) { failed15m++; return; }

        const bars1H = aggregate(bars15m, 4);
        const bars4H = aggregate(bars15m, 16);

        const fg15 = quickFG(bars15m);
        const fg1H = quickFG(bars1H);
        const fg4H = quickFG(bars4H);

        if (fg15 || fg1H || fg4H) {
          mtfScores.set(sym, { '15m': fg15, '1H': fg1H, '4H': fg4H });
          fetched15m++;
        } else { failed15m++; }
      } catch { failed15m++; }
    });
    await Promise.all(promises);
  }
  const fetchTime = Date.now() - t15;

  // ── Phase 3: Merge all TFs + classify signals ──
  const results = [];
  const aligned = [], earlyWarnings = [], recoveries = [], divergences = [];

  for (const sym of allSymbols) {
    const daily = dailyScores.get(sym);
    const mtf = mtfScores.get(sym);
    if (!daily && !mtf) continue;

    const cls = detectAssetClass(sym);
    const tier = getTier(cls);
    const cal = daily ? classifyCalibratedZone(sym, daily.fg) : null;
    const stats = TIER_STATS[cls] || { wr: 50, ret: 0 };
    const symScore = symbolScores[sym.toUpperCase()];

    const fg15 = mtf?.['15m']?.fg ?? null;
    const fg1H = mtf?.['1H']?.fg ?? null;
    const fg4H = mtf?.['4H']?.fg ?? null;
    const fgD = daily?.fg ?? null;

    // Confidence
    let conf = Math.round(stats.wr * (tier === 1 ? 1.1 : tier === 2 ? 0.8 : 0.3));
    if (symScore?.wr && symScore.n >= 3) {
      if (symScore.wr > 60) conf = Math.min(95, conf + 15);
      else if (symScore.wr < 35) conf = Math.max(5, conf - 15);
    }

    const entry = {
      symbol: sym, class: cls, tier,
      fg_15m: fg15, fg_1H: fg1H, fg_4H: fg4H, fg_D: fgD,
      calibrated_zone: cal?.zone || null,
      calibrated_severity: cal?.severity ?? 0,
      is_rare_fear: cal?.is_triggered || false,
      rare_fear_threshold: cal?.thresholds?.extreme_fear ?? null,
      distance_to_rare_fear: cal?.distance_to_rare_fear ?? null,
      confidence: conf,
      expected_return: stats.ret + '%',
      win_rate: stats.wr + '%',
      symbol_score: symScore || null,
      signal_type: null,
    };

    // Classify signal type
    const fearTFs = [fg15, fg1H, fg4H, fgD].filter(v => v != null && v <= (cal?.thresholds?.fear ?? -10));
    const allFear = fearTFs.length === 4 && fg15 != null && fg1H != null && fg4H != null && fgD != null;
    const dailyFear = fgD != null && cal?.severity <= -1;
    const intraDayFear = (fg15 != null && fg15 <= -15) || (fg1H != null && fg1H <= -15);
    const intraDayRecovering = fg15 != null && fg1H != null && fg15 > fg1H;

    // Backtest-validated signal stats (from 10,667-event large-scale backtest)
    const SIGNAL_STATS = {
      FULL_ALIGNMENT: { ret: 1.13, wr: 38, sharpe: 0.2, p: 1.06, validated: false, note: 'NOT significant — 38% WR' },
      EARLY_WARNING:  { ret: 0.1, wr: 41, sharpe: 0.02, p: 1.81, validated: false, note: 'NOT profitable — 41% WR' },
      RECOVERY:       { ret: 5.48, wr: 49, sharpe: 0.93, p: 0.15, validated: false, note: 'High return but NOT significant (p=0.15, N=80)' },
      DIVERGENCE_BULL:{ ret: 1.61, wr: 49, sharpe: 0.5, p: 0.001, validated: true, note: 'Significant — 6745 events at scale' },
    };

    if (allFear) {
      entry.signal_type = 'FULL_ALIGNMENT';
      entry.signal_stats = SIGNAL_STATS.FULL_ALIGNMENT;
      aligned.push(entry);
    } else if (intraDayFear && !dailyFear) {
      entry.signal_type = 'EARLY_WARNING';
      entry.signal_stats = SIGNAL_STATS.EARLY_WARNING;
      earlyWarnings.push(entry);
    } else if (dailyFear && intraDayRecovering) {
      entry.signal_type = 'RECOVERY';
      entry.signal_stats = SIGNAL_STATS.RECOVERY;
      // No confidence boost — Recovery NOT validated at scale (p=0.15)
      recoveries.push(entry);
    }

    // Divergence
    if (fg15 != null && fgD != null && Math.abs(fg15 - fgD) > 15) {
      entry.signal_type = entry.signal_type || 'DIVERGENCE';
      divergences.push(entry);
    }

    results.push(entry);
  }

  // Sort various lists
  aligned.sort((a, b) => (a.fg_D ?? 0) - (b.fg_D ?? 0));
  earlyWarnings.sort((a, b) => (a.fg_15m ?? 0) - (b.fg_15m ?? 0));
  recoveries.sort((a, b) => (a.fg_D ?? 0) - (b.fg_D ?? 0));
  divergences.sort((a, b) => Math.abs((b.fg_15m ?? 0) - (b.fg_D ?? 0)) - Math.abs((a.fg_15m ?? 0) - (a.fg_D ?? 0)));

  // Tiered fear signals (from daily calibrated)
  const tier1 = results.filter(r => r.is_rare_fear && r.tier === 1);
  const tier2 = results.filter(r => r.is_rare_fear && r.tier === 2);
  const tier3 = results.filter(r => r.is_rare_fear && r.tier === 3);
  tier1.sort((a, b) => (a.fg_D ?? 0) - (b.fg_D ?? 0));
  tier2.sort((a, b) => (a.fg_D ?? 0) - (b.fg_D ?? 0));
  tier3.sort((a, b) => (a.fg_D ?? 0) - (b.fg_D ?? 0));

  // Most extreme (any TF)
  const mostExtreme = [...results]
    .filter(r => r.distance_to_rare_fear != null)
    .sort((a, b) => a.distance_to_rare_fear - b.distance_to_rare_fear)
    .slice(0, top);

  // Outperformers in fear
  const outperformersInFear = results
    .filter(r => r.symbol_score && r.symbol_score.wr > 60 && r.calibrated_severity <= -1)
    .sort((a, b) => (b.symbol_score?.avg || 0) - (a.symbol_score?.avg || 0))
    .slice(0, 15);

  // Regime
  const regime = {};
  for (const [sym, key] of [['SPY','us'],['BTC','crypto'],['^AXJO','asx'],['GC=F','gold'],['HG=F','copper']]) {
    const d = dailyScores.get(sym);
    if (!d) continue;
    const entry = cache[sym.toUpperCase() + ':D'];
    if (!entry) continue;
    const ema = entry._state?.ema144;
    const price = entry.lastClose;
    if (ema && price) regime[key] = { regime: price > ema ? 'BULL' : 'BEAR', price: r2(price), ema: r2(ema) };
  }

  const totalTime = Date.now() - t0;

  // Distribution
  const dist = { rare_fear: 0, fear: 0, neutral: 0, greed: 0, rare_greed: 0 };
  for (const r of results) {
    const s = r.calibrated_severity;
    if (s <= -2) dist.rare_fear++;
    else if (s === -1) dist.fear++;
    else if (s === 0) dist.neutral++;
    else if (s === 1) dist.greed++;
    else if (s >= 2) dist.rare_greed++;
  }

  return {
    success: true,
    scan_type: 'production-mtf',
    date: new Date().toISOString().slice(0, 10),
    timing: {
      list_ms: listTime, fetch_15m_ms: fetchTime, total_ms: totalTime,
      total_readable: (totalTime / 1000).toFixed(1) + 's',
    },
    regime,
    coverage: {
      total_symbols: allSymbols.length,
      daily_cached: dailyScores.size,
      fetched_15m: fetched15m,
      failed_15m: failed15m,
      total_fg_scores: dailyScores.size + fetched15m * 3,
    },
    summary: {
      full_alignment: aligned.length,
      early_warnings: earlyWarnings.length,
      recoveries: recoveries.length,
      divergences: divergences.length,
      tier1_signals: tier1.length,
      tier2_signals: tier2.length,
      tier3_signals: tier3.length,
    },
    distribution: dist,
    full_alignment: aligned.slice(0, top),
    early_warnings: earlyWarnings.slice(0, top),
    recoveries: recoveries.slice(0, top),
    divergences: divergences.slice(0, top),
    tier1_proven: tier1.slice(0, 15),
    tier2_weak: tier2.slice(0, 15),
    tier3_unproven: tier3.slice(0, 15),
    most_extreme: mostExtreme,
    outperformers_in_fear: outperformersInFear,
    greed_exits: [...results].sort((a, b) => (b.fg_D ?? 0) - (a.fg_D ?? 0)).filter(r => r.calibrated_severity >= 1).slice(0, 10).map(r => ({
      ...r,
      greed_note: 'TAKE PROFIT — do NOT short. Backtest: greed signals produce +1.4% forward (market keeps going up). Use as EXIT signal for swing positions.',
    })),
  };
}
