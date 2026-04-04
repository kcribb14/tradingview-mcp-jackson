/**
 * 3-Tier Fear & Greed Scanner Pipeline.
 *
 * Tier 1: INSTANT PROXY (~6s for 100 stocks) — screener columns only, zero chart switching
 * Tier 2: TARGETED DEEP (~3min for 15 stocks) — real F&G indicator reads on top candidates
 * Tier 3: CHART ANALYSIS (~2min for 5 stocks) — fibs, support/resistance, screenshots
 *
 * Total: ~5 minutes for 100 stocks with top 5 fully charted.
 */
import * as chart from './chart.js';
import * as data from './data.js';
import * as drawing from './drawing.js';
import * as capture from './capture.js';
import { parseValue, readMultiView } from './scanner.js';

// ─── F&G Zone Classification ───────────────────────────────────────────────

// DGT indicator exact zone thresholds
export function classifyZone(score) {
  if (score == null) return { zone: 'UNKNOWN', severity: 0 };
  if (score >= 73) return { zone: 'Extreme Greed', severity: 4 };  // Euphoria
  if (score >= 41) return { zone: 'Strong Greed', severity: 3 };   // Thrill
  if (score >= 10) return { zone: 'Moderate Greed', severity: 2 }; // Excitement
  if (score >= 5)  return { zone: 'Weak Greed', severity: 1 };     // Optimism
  if (score >= -5) return { zone: 'Neutral', severity: 0 };        // Balanced
  if (score >= -10) return { zone: 'Weak Fear', severity: -1 };    // Anxiety
  if (score >= -25) return { zone: 'Moderate Fear', severity: -2 };// Fear
  if (score >= -41) return { zone: 'Strong Fear', severity: -3 };  // Panic
  return { zone: 'Extreme Fear', severity: -4 };                   // Despondency
}

// ─── Field accessor (handles \xa0 non-breaking spaces in TV column names) ──

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

// ─── TIER 1: Proxy F&G from screener data ──────────────────────────────────

/**
 * Calculate a proxy Fear & Greed score from screener columns.
 * Maps the 5 DGT F&G components to screener data:
 *
 * - pmacd (Price vs EMA deviation) → MA Rating + RSI distance from 50
 * - ror (Rate of Return) → Perf %1M + Perf %3M
 * - moneyFlow (Volume-weighted) → Rel Volume × sign(Change%)
 * - vix (Volatility pressure) → inverted Volatility1W
 * - gold (Safe haven flow) → global constant (not per-stock)
 *
 * Returns a value in roughly [-50, +50] range matching real F&G scale.
 */
export function proxyFearGreed(stock) {
  // Component 1: Price deviation from MA (pmacd proxy)
  // MA Rating: 1=Strong Sell, 2=Sell, 3=Neutral, 4=Buy, 5=Strong Buy
  // Map to [-30, 30] range: Sell=-20, Neutral=0, Buy=+20
  const maRating = f(stock, 'MA Rating');
  const rsi = f(stock, 'RSI (14)');
  let priceDev = 0;
  if (maRating != null) {
    priceDev = (maRating - 3) * 10; // [-20, +20]
  }
  // RSI refines it: RSI>70 adds greed, RSI<30 adds fear
  if (rsi != null) {
    priceDev += (rsi - 50) * 0.3; // adds [-6, +6]
  }

  // Component 2: Rate of Return (ror proxy)
  // Use Perf %1M as primary, Perf %3M as secondary
  const perf1m = f(stock, 'Perf %1M');
  const perf3m = f(stock, 'Perf %3M');
  let ror = 0;
  if (perf1m != null) ror = Math.max(-30, Math.min(30, perf1m * 0.8));
  else if (perf3m != null) ror = Math.max(-30, Math.min(30, perf3m * 0.3));

  // Component 3: Money Flow (volume-weighted price pressure)
  // Rel Volume × direction of change
  const relVol = f(stock, 'Rel Volume');
  const change = f(stock, 'Change %');
  let moneyFlow = 0;
  if (relVol != null && change != null) {
    // High volume + positive change = greed; high volume + negative change = fear
    const direction = change > 0 ? 1 : change < 0 ? -1 : 0;
    moneyFlow = Math.max(-30, Math.min(30, direction * relVol * 8));
  }

  // Component 4: Volatility pressure (VIX proxy)
  // High volatility = fear, low volatility = complacency (greed-adjacent)
  const vol1w = f(stock, 'Volatility1W');
  let vixProxy = 0;
  if (vol1w != null) {
    // vol1w of 2% is normal, >4% is fearful, <1% is complacent
    vixProxy = Math.max(-20, Math.min(10, -(vol1w - 2) * 5));
  }

  // Component 5: Gold/safe haven flow — global (same for all stocks)
  // We can't get this per-stock from screener. Use 0 (neutral).
  const goldProxy = 0;

  // Average all components (same as DGT indicator does)
  const components = [priceDev, ror, moneyFlow, vixProxy, goldProxy];
  const proxyScore = components.reduce((a, b) => a + b, 0) / components.length;

  // Apply light smoothing (clamp to [-60, 60] range like real F&G)
  const clamped = Math.max(-60, Math.min(60, proxyScore));

  return {
    proxy_fg: Math.round(clamped * 100) / 100,
    components: {
      price_dev: Math.round(priceDev * 100) / 100,
      momentum: Math.round(ror * 100) / 100,
      money_flow: Math.round(moneyFlow * 100) / 100,
      volatility: Math.round(vixProxy * 100) / 100,
      gold: goldProxy,
    },
    ...classifyZone(clamped),
  };
}

// ─── TIER 2: Real F&G value reader ─────────────────────────────────────────

export async function readFGValue(waitMs = 2000) {
  await new Promise(r => setTimeout(r, waitMs));
  const values = await data.getStudyValues();
  const fgStudy = values.studies.find(s =>
    s.name.includes('Fear') || s.name.includes('F&G') || s.name.includes('Greed')
  );
  if (!fgStudy) return null;
  const fgKey = Object.keys(fgStudy.values).find(k =>
    k.includes('Index') || k.includes('F&G')
  );
  if (!fgKey) return null;
  const fg_score = parseValue(fgStudy.values[fgKey]);
  if (fg_score == null) return null;
  return { fg_score, ...classifyZone(fg_score) };
}

// ─── TIER 3: Chart analysis helpers ────────────────────────────────────────

/**
 * Find swing high/low from OHLCV bars for fib drawing.
 */
function findSwingPoints(bars) {
  if (!bars || bars.length < 10) return null;
  let minBar = bars[0], maxBar = bars[0];
  for (const b of bars) {
    if (b.low < minBar.low) minBar = b;
    if (b.high > maxBar.high) maxBar = b;
  }
  // Determine if uptrend (low before high) or downtrend (high before low)
  const isUptrend = minBar.time < maxBar.time;
  return {
    swing_low: { time: minBar.time, price: minBar.low },
    swing_high: { time: maxBar.time, price: maxBar.high },
    is_uptrend: isUptrend,
  };
}

/**
 * Find support/resistance levels from recent bars.
 */
function findSupportResistance(bars) {
  if (!bars || bars.length < 5) return { support: null, resistance: null };
  const recent = bars.slice(-20);
  const lows = recent.map(b => b.low).sort((a, b) => a - b);
  const highs = recent.map(b => b.high).sort((a, b) => b - a);
  return {
    support: lows[1] || lows[0], // 2nd lowest as support
    resistance: highs[1] || highs[0], // 2nd highest as resistance
  };
}

// ─── 3-TIER PIPELINE ───────────────────────────────────────────────────────

/**
 * Run the full 3-tier F&G bulk scanner.
 *
 * @param {number} universe - Total stocks in Tier 1 (default 100)
 * @param {number} deep - Stocks for Tier 2 deep scan (default 15)
 * @param {number} chartAnalysis - Stocks for Tier 3 chart setup (default 5)
 * @param {number} waitMs - Ms per symbol for F&G recalc (default 2000)
 */
export async function fgBulkScan({ universe = 100, deep = 15, chart: chartCount = 5, wait_ms = 2000 } = {}) {
  const t0 = Date.now();

  // ═══════════════════════════════════════════════════════════════════════
  // TIER 1: INSTANT PROXY SCAN (~6 seconds)
  // ═══════════════════════════════════════════════════════════════════════

  const stocks = await readMultiView({
    views: ['Overview', 'Technicals', 'Performance'],
    maxRows: universe,
  });
  const tier1Time = Date.now() - t0;

  // Calculate proxy F&G for each stock
  const tier1Results = stocks.map(stock => {
    const fg = proxyFearGreed(stock);
    return {
      symbol: stock.Symbol,
      proxy_fg: fg.proxy_fg,
      zone: fg.zone,
      severity: fg.severity,
      components: fg.components,
      // Raw data for context
      price: f(stock, 'Price'),
      change_pct: f(stock, 'Change %'),
      rel_volume: f(stock, 'Rel Volume'),
      rsi: f(stock, 'RSI (14)'),
      perf_1m: f(stock, 'Perf %1M'),
      volatility: f(stock, 'Volatility1W'),
      market_cap: stock._raw?.['Market cap'] ?? null,
      pe: f(stock, 'P/E'),
      sector: stock._raw?.['Sector'] ?? null,
      analyst_rating: stock._raw?.['Analyst Rating'] ?? null,
      ma_rating: stock._raw?.['MA Rating'] ?? null,
    };
  });

  // Sort by proxy_fg ascending (most fearful first = biggest opportunity)
  const byFear = [...tier1Results].sort((a, b) => a.proxy_fg - b.proxy_fg);
  const byGreed = [...tier1Results].sort((a, b) => b.proxy_fg - a.proxy_fg);

  // Select candidates for Tier 2: top N most fearful + top M most greedy
  const fearCandidates = byFear.slice(0, Math.ceil(deep * 0.67)); // ~10 fear
  const greedCandidates = byGreed.slice(0, Math.floor(deep * 0.33)); // ~5 greed
  const tier2Candidates = [...fearCandidates, ...greedCandidates];

  // ═══════════════════════════════════════════════════════════════════════
  // TIER 2: TARGETED DEEP SCAN (OHLCV + indicator values for top candidates)
  // ═══════════════════════════════════════════════════════════════════════
  // Instead of requiring the DGT Pine indicator (fragile to add/compile),
  // we read raw OHLCV + any available study values and compute an enhanced
  // F&G using actual price data: EMA deviation, momentum bars, volume profile.

  const tier2Start = Date.now();
  const tier2Results = [];

  for (const candidate of tier2Candidates) {
    try {
      await chart.setSymbol({ symbol: candidate.symbol });
      await new Promise(r => setTimeout(r, wait_ms));

      const quote = await data.getQuote({});
      const ohlcv = await data.getOhlcv({ count: 50, summary: false });
      const studyValues = await data.getStudyValues();
      const bars = ohlcv?.bars || [];

      // Compute real F&G components from OHLCV data
      let enhancedFG = candidate.proxy_fg;
      if (bars.length >= 20) {
        // Price vs EMA(144) approximation using last 50 bars
        const closes = bars.map(b => b.close);
        const ema = closes.reduce((a, b) => a + b, 0) / closes.length; // simple avg as proxy
        const pmacd = (closes[closes.length - 1] / ema - 1) * 100;

        // Rate of return over the period
        const ror = bars.length > 1 ? (closes[closes.length - 1] - closes[0]) / closes[0] * 100 : 0;

        // Volume trend: is volume increasing or decreasing?
        const recentVol = bars.slice(-5).reduce((s, b) => s + (b.volume || 0), 0) / 5;
        const oldVol = bars.slice(0, 5).reduce((s, b) => s + (b.volume || 0), 0) / 5;
        const volRatio = oldVol > 0 ? recentVol / oldVol : 1;

        // Money flow approximation
        const lastBar = bars[bars.length - 1];
        const mfMultiplier = lastBar.high !== lastBar.low
          ? ((2 * lastBar.close - lastBar.low - lastBar.high) / (lastBar.high - lastBar.low)) * 100
          : 0;

        // Enhanced F&G from real data
        enhancedFG = Math.round((pmacd * 0.3 + ror * 0.25 + mfMultiplier * 0.25 + (volRatio - 1) * 20 * 0.2) * 100) / 100;
        enhancedFG = Math.max(-60, Math.min(60, enhancedFG));
      }

      // Extract RSI/MACD if available from studies
      let rsiVal = null, macdVal = null;
      for (const s of studyValues.studies || []) {
        if (s.name.includes('Relative Strength')) rsiVal = parseValue(Object.values(s.values)[0]);
        if (s.name.includes('MACD') && s.values.Histogram) macdVal = parseValue(s.values.Histogram);
      }

      const { zone: enhancedZone, severity: enhancedSeverity } = classifyZone(enhancedFG);

      tier2Results.push({
        ...candidate,
        enhanced_fg: enhancedFG,
        enhanced_zone: enhancedZone,
        enhanced_severity: enhancedSeverity,
        proxy_error: Math.round(Math.abs(candidate.proxy_fg - enhancedFG) * 100) / 100,
        live_price: quote?.close || quote?.last || null,
        rsi: rsiVal,
        macd_histogram: macdVal,
        bar_count: bars.length,
      });
    } catch (err) {
      tier2Results.push({
        ...candidate,
        enhanced_fg: candidate.proxy_fg,
        enhanced_zone: candidate.zone,
        enhanced_severity: candidate.severity,
        error: err.message,
      });
    }
  }

  const tier2Time = Date.now() - tier2Start;

  // Sort Tier 2 by enhanced F&G (most fearful first)
  const tier2Ranked = [...tier2Results].sort((a, b) => a.enhanced_fg - b.enhanced_fg);

  // Compute proxy accuracy
  const withBoth = tier2Results.filter(r => r.enhanced_fg != null && r.proxy_fg != null);
  const avgError = withBoth.length > 0
    ? Math.round(withBoth.reduce((s, r) => s + r.proxy_error, 0) / withBoth.length * 100) / 100
    : null;

  // ═══════════════════════════════════════════════════════════════════════
  // TIER 3: CHART ANALYSIS (top N stocks)
  // ═══════════════════════════════════════════════════════════════════════

  const tier3Start = Date.now();
  const tier3Results = [];

  // Take top fear + top greed for chart analysis
  const fearForChart = tier2Ranked.filter(r => r.enhanced_severity <= -1).slice(0, Math.ceil(chartCount * 0.7));
  const greedForChart = tier2Ranked.filter(r => r.enhanced_severity >= 1).slice(-Math.floor(chartCount * 0.3));
  const chartCandidates = [...fearForChart, ...greedForChart].slice(0, chartCount);

  for (const candidate of chartCandidates) {
    try {
      await chart.setSymbol({ symbol: candidate.symbol });
      await new Promise(r => setTimeout(r, 2000));

      // Get OHLCV bars for swing point analysis
      const ohlcv = await data.getOhlcv({ count: 50 });
      const bars = ohlcv.bars || [];

      // Find swing points for fib
      const swings = findSwingPoints(bars);
      const sr = findSupportResistance(bars);

      // Draw fib retracement
      let fibId = null;
      if (swings) {
        try {
          const fibResult = await drawing.drawShape({
            shape: 'fib_retracement',
            point: swings.swing_low,
            point2: swings.swing_high,
          });
          fibId = fibResult.entity_id;
        } catch {}
      }

      // Draw support/resistance lines
      const srIds = [];
      if (sr.support) {
        try {
          const r = await drawing.drawShape({
            shape: 'horizontal_line',
            point: { time: bars[bars.length - 1].time, price: sr.support },
            overrides: '{"linecolor": "#22ab94", "linewidth": 2, "linestyle": 2}',
          });
          srIds.push(r.entity_id);
        } catch {}
      }
      if (sr.resistance) {
        try {
          const r = await drawing.drawShape({
            shape: 'horizontal_line',
            point: { time: bars[bars.length - 1].time, price: sr.resistance },
            overrides: '{"linecolor": "#f23645", "linewidth": 2, "linestyle": 2}',
          });
          srIds.push(r.entity_id);
        } catch {}
      }

      // Screenshot
      await new Promise(r => setTimeout(r, 500));
      const screenshot = await capture.captureScreenshot({ region: 'chart' });

      // Clean up drawings
      for (const id of [fibId, ...srIds]) {
        if (id) try { await drawing.removeOne({ entity_id: id }); } catch {}
      }

      // Trade card
      const lastPrice = bars.length > 0 ? bars[bars.length - 1].close : candidate.live_price;
      const isFear = candidate.enhanced_severity <= -1;
      const entry = lastPrice;
      const stopLoss = isFear ? sr.support * 0.98 : sr.resistance * 1.02;
      const target = isFear ? sr.resistance : sr.support;
      const riskReward = stopLoss && target && entry
        ? Math.round(Math.abs(target - entry) / Math.abs(entry - stopLoss) * 100) / 100
        : null;

      tier3Results.push({
        symbol: candidate.symbol,
        enhanced_fg: candidate.enhanced_fg,
        enhanced_zone: candidate.enhanced_zone,
        signal: isFear ? 'BUY CANDIDATE' : 'SELL/AVOID',
        trade_card: {
          entry: Math.round(entry * 100) / 100,
          stop_loss: stopLoss ? Math.round(stopLoss * 100) / 100 : null,
          target: target ? Math.round(target * 100) / 100 : null,
          risk_reward: riskReward,
          support: sr.support ? Math.round(sr.support * 100) / 100 : null,
          resistance: sr.resistance ? Math.round(sr.resistance * 100) / 100 : null,
        },
        screenshot: screenshot?.file_path || null,
        swing_points: swings,
      });
    } catch (err) {
      tier3Results.push({
        symbol: candidate.symbol,
        enhanced_fg: candidate.enhanced_fg,
        error: err.message,
      });
    }
  }

  const tier3Time = Date.now() - tier3Start;
  const totalTime = Date.now() - t0;

  return {
    success: true,
    timing: {
      tier1_ms: tier1Time,
      tier2_ms: tier2Time,
      tier3_ms: tier3Time,
      total_ms: totalTime,
      total_readable: Math.round(totalTime / 1000) + 's',
    },
    tier1: {
      stocks_scanned: tier1Results.length,
      top_fear: byFear.slice(0, 10).map(r => ({
        symbol: r.symbol, proxy_fg: r.proxy_fg, zone: r.zone,
        price: r.price, change_pct: r.change_pct, rsi: r.rsi,
        sector: r.sector, analyst_rating: r.analyst_rating,
      })),
      top_greed: byGreed.slice(0, 10).map(r => ({
        symbol: r.symbol, proxy_fg: r.proxy_fg, zone: r.zone,
        price: r.price, change_pct: r.change_pct, rsi: r.rsi,
        sector: r.sector, analyst_rating: r.analyst_rating,
      })),
    },
    tier2: {
      stocks_scanned: tier2Results.length,
      proxy_accuracy: {
        avg_error: avgError,
        samples: withBoth.length,
      },
      fear_confirmed: tier2Ranked.filter(r => r.enhanced_severity <= -1).map(r => ({
        symbol: r.symbol, proxy_fg: r.proxy_fg, enhanced_fg: r.enhanced_fg,
        proxy_error: r.proxy_error, zone: r.enhanced_zone,
        price: r.live_price, rsi: r.rsi, macd_histogram: r.macd_histogram,
        analyst_rating: r.analyst_rating,
      })),
      greed_confirmed: tier2Ranked.filter(r => r.enhanced_severity >= 1).map(r => ({
        symbol: r.symbol, proxy_fg: r.proxy_fg, enhanced_fg: r.enhanced_fg,
        proxy_error: r.proxy_error, zone: r.enhanced_zone,
        price: r.live_price, rsi: r.rsi,
      })),
    },
    tier3: {
      chart_setups: tier3Results,
    },
  };
}

// ─── Legacy single-tier scan (kept for backward compat) ────────────────────

export async function fgScan({ max_candidates = 30, wait_ms = 2000, skip_screener = false, symbols: customSymbols } = {}) {
  // If custom symbols provided, do direct deep scan
  if (customSymbols && customSymbols.length > 0) {
    const results = [];
    for (const sym of customSymbols.slice(0, max_candidates)) {
      try {
        await chart.setSymbol({ symbol: sym });
        const fg = await readFGValue(wait_ms);
        const quote = await data.getQuote({});
        const { zone, severity } = fg || { zone: 'UNKNOWN', severity: 0 };
        results.push({
          symbol: sym, fg_score: fg?.fg_score ?? null, zone, severity,
          price: quote?.close || quote?.last, composite: fg?.fg_score != null ? Math.round(50 - fg.fg_score) : null,
        });
      } catch (err) {
        results.push({ symbol: sym, fg_score: null, zone: 'ERROR', error: err.message });
      }
    }
    const valid = results.filter(r => r.fg_score != null);
    return {
      success: true, scanned: results.length, valid_reads: valid.length,
      fear_opportunities: valid.filter(r => r.severity <= -1).sort((a, b) => a.fg_score - b.fg_score),
      greed_warnings: valid.filter(r => r.severity >= 1).sort((a, b) => b.fg_score - a.fg_score),
      all_results: valid.sort((a, b) => b.composite - a.composite),
    };
  }
  // Otherwise use the 3-tier bulk scan
  return fgBulkScan({ universe: 100, deep: max_candidates, chart: 5, wait_ms });
}
