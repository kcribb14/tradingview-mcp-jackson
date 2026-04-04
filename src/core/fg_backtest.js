/**
 * F&G Backtesting Engine — historical analysis of fear signal outcomes.
 *
 * Calculates the FULL F&G time series over 500 daily bars, identifies every
 * fear event (F&G < -25), and tracks: days to bottom, drawdown after signal,
 * 30/60/90-day returns, and optimal entry timing.
 */
import { fetchOhlcv } from './unified_data.js';
import { calcEMA, updateEMA, calcRSI, updateRMA } from './fg_cache.js';
import { classifyZone } from './fg_scanner.js';

const r2 = v => Math.round(v * 100) / 100;

// ─── Rolling F&G time series ────────────────────────────────────────────────

/**
 * Calculate F&G score at every bar using a rolling window.
 * Needs 144+ bars for EMA warm-up; scores start from bar 150 onward.
 *
 * @param {Array} bars - Full OHLCV bar array (500+ bars ideal)
 * @returns {Array} [{date, close, fg_score, zone, severity, ema144}, ...]
 */
export function computeTimeSeries(bars) {
  if (!bars || bars.length < 150) return [];

  const series = [];
  const closes = bars.map(b => b.close);

  // Warm up EMA(144) on first 144 bars
  let ema144 = closes[0];
  for (let i = 1; i < 144 && i < closes.length; i++) {
    ema144 = updateEMA(ema144, closes[i], 144);
  }

  // Warm up RSI(14) state
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < Math.min(15, closes.length); i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
  }
  avgGain /= 14;
  avgLoss /= 14;

  // Calculate F&G at each bar from position 144 onward
  for (let i = 144; i < bars.length; i++) {
    ema144 = updateEMA(ema144, closes[i], 144);

    // RSI update
    const rsiDiff = closes[i] - closes[i - 1];
    avgGain = updateRMA(avgGain, rsiDiff > 0 ? rsiDiff : 0, 14);
    avgLoss = updateRMA(avgLoss, rsiDiff < 0 ? Math.abs(rsiDiff) : 0, 14);

    // pmacd
    const pmacdRaw = ema144 > 0 ? (closes[i] / ema144 - 1) * 100 : 0;
    const pmacd = Math.max(-40, Math.min(40, pmacdRaw * 3));

    // ror (20-bar)
    const refIdx = Math.max(0, i - 20);
    const rorRaw = closes[refIdx] > 0 ? (closes[i] - closes[refIdx]) / closes[refIdx] * 100 : 0;
    const ror = Math.max(-50, Math.min(50, rorRaw * 2));

    // moneyFlow (MFI 14-bar)
    const mfStart = Math.max(0, i - 14);
    let posFlow = 0, negFlow = 0;
    for (let j = mfStart + 1; j <= i; j++) {
      const tp = (bars[j].high + bars[j].low + bars[j].close) / 3;
      const prevTp = (bars[j-1].high + bars[j-1].low + bars[j-1].close) / 3;
      const rawMf = tp * (bars[j].volume || 0);
      if (tp > prevTp) posFlow += rawMf;
      else if (tp < prevTp) negFlow += rawMf;
    }
    const mfi = negFlow > 0 ? 100 - 100 / (1 + posFlow / negFlow) : (posFlow > 0 ? 100 : 50);
    const moneyFlow = Math.max(-50, Math.min(50, (mfi - 50) * 1.2));

    // vix (ATR 14-bar)
    let atrSum = 0;
    for (let j = Math.max(0, i - 13); j <= i; j++) {
      atrSum += bars[j].high - bars[j].low;
    }
    const atr = atrSum / 14;
    const atrPct = closes[i] > 0 ? (atr / closes[i]) * 100 : 0;
    const vixProxy = Math.max(-50, Math.min(20, -(atrPct - 1.5) * 10));

    // Composite (equal weight, gold=0 for historical)
    const fgScore = Math.max(-60, Math.min(60, r2((pmacd + ror + moneyFlow + vixProxy + 0) / 5)));
    const { zone, severity } = classifyZone(fgScore);

    series.push({
      date: new Date(bars[i].time * 1000).toISOString().slice(0, 10),
      close: r2(closes[i]),
      fg_score: fgScore,
      zone,
      severity,
    });
  }

  return series;
}

// ─── Fear event detection ───────────────────────────────────────────────────

const FEAR_ENTRY = -25;  // F&G threshold to enter fear event
const FEAR_EXIT = -10;   // F&G threshold to exit fear event

/**
 * Identify every fear event in the time series.
 */
export function findFearEvents(series) {
  const events = [];
  let inFear = false;
  let current = null;

  for (let i = 0; i < series.length; i++) {
    const bar = series[i];

    if (!inFear && bar.fg_score <= FEAR_ENTRY) {
      // Enter fear event
      inFear = true;
      current = {
        entry_idx: i,
        entry_date: bar.date,
        entry_price: bar.close,
        entry_fg: bar.fg_score,
        lowest_fg: bar.fg_score,
        lowest_fg_idx: i,
        lowest_fg_date: bar.date,
        bottom_price: bar.close,
        bottom_idx: i,
        bottom_date: bar.date,
      };
    } else if (inFear) {
      // Track deepest fear
      if (bar.fg_score < current.lowest_fg) {
        current.lowest_fg = bar.fg_score;
        current.lowest_fg_idx = i;
        current.lowest_fg_date = bar.date;
      }
      // Track price bottom
      if (bar.close < current.bottom_price) {
        current.bottom_price = bar.close;
        current.bottom_idx = i;
        current.bottom_date = bar.date;
      }

      if (bar.fg_score > FEAR_EXIT) {
        // Exit fear event
        inFear = false;
        current.exit_idx = i;
        current.exit_date = bar.date;
        current.exit_price = bar.close;

        // Calculate metrics
        current.days_entry_to_bottom = current.bottom_idx - current.entry_idx;
        current.drawdown_after_signal = r2((current.bottom_price - current.entry_price) / current.entry_price * 100);
        current.recovery_pct = r2((current.exit_price - current.bottom_price) / current.bottom_price * 100);
        current.days_bottom_to_exit = current.exit_idx - current.bottom_idx;
        current.days_total = current.exit_idx - current.entry_idx;

        // Forward returns from entry
        const p30 = i + 30 < series.length ? series[current.entry_idx + 30]?.close : null;
        const p60 = current.entry_idx + 60 < series.length ? series[current.entry_idx + 60]?.close : null;
        const p90 = current.entry_idx + 90 < series.length ? series[current.entry_idx + 90]?.close : null;
        current.return_30d = p30 ? r2((p30 - current.entry_price) / current.entry_price * 100) : null;
        current.return_60d = p60 ? r2((p60 - current.entry_price) / current.entry_price * 100) : null;
        current.return_90d = p90 ? r2((p90 - current.entry_price) / current.entry_price * 100) : null;

        // Forward returns from bottom
        const bp30 = current.bottom_idx + 30 < series.length ? series[current.bottom_idx + 30]?.close : null;
        current.return_from_bottom_30d = bp30 ? r2((bp30 - current.bottom_price) / current.bottom_price * 100) : null;

        events.push(current);
        current = null;
      }
    }
  }

  // Handle still-in-fear at end of data
  if (inFear && current) {
    const last = series[series.length - 1];
    current.exit_date = null;
    current.exit_price = last.close;
    current.days_entry_to_bottom = current.bottom_idx - current.entry_idx;
    current.drawdown_after_signal = r2((current.bottom_price - current.entry_price) / current.entry_price * 100);
    current.days_total = series.length - 1 - current.entry_idx;
    current.still_in_fear = true;

    const p30 = current.entry_idx + 30 < series.length ? series[current.entry_idx + 30]?.close : null;
    current.return_30d = p30 ? r2((p30 - current.entry_price) / current.entry_price * 100) : null;
    events.push(current);
  }

  return events;
}

// ─── Strategy simulations ───────────────────────────────────────────────────

/**
 * Simulate entry strategies on the time series.
 */
export function simulateStrategies(series, events) {
  const strategies = {
    A: { name: 'Buy at F&G < -25 (immediate)', trades: [] },
    B: { name: 'Buy at F&G < -35 (deeper fear)', trades: [] },
    C: { name: 'Buy at F&G < -25 AND rising (3-bar MA)', trades: [] },
    D: { name: 'Buy at F&G < -25 AND price > 5-day low', trades: [] },
    E: { name: 'Scale in: 25% at -20, -25, -30, -35', trades: [] },
  };

  // Strategy A: buy immediately at -25
  for (const ev of events) {
    strategies.A.trades.push({
      entry_date: ev.entry_date,
      entry_price: ev.entry_price,
      return_30d: ev.return_30d,
      return_60d: ev.return_60d,
      return_90d: ev.return_90d,
      drawdown: ev.drawdown_after_signal,
      days_to_bottom: ev.days_entry_to_bottom,
    });
  }

  // Strategy B: buy at -35
  for (let i = 0; i < series.length; i++) {
    if (series[i].fg_score <= -35) {
      // Check we're not already in a trade from this fear event
      const alreadyTraded = strategies.B.trades.some(t =>
        Math.abs(new Date(t.entry_date) - new Date(series[i].date)) < 20 * 86400000
      );
      if (alreadyTraded) continue;

      const p30 = i + 30 < series.length ? series[i + 30].close : null;
      const p60 = i + 60 < series.length ? series[i + 60].close : null;
      const p90 = i + 90 < series.length ? series[i + 90].close : null;

      // Find bottom after this point (within 30 bars)
      let bottom = series[i].close;
      for (let j = i; j < Math.min(i + 30, series.length); j++) {
        if (series[j].close < bottom) bottom = series[j].close;
      }

      strategies.B.trades.push({
        entry_date: series[i].date,
        entry_price: series[i].close,
        entry_fg: series[i].fg_score,
        return_30d: p30 ? r2((p30 - series[i].close) / series[i].close * 100) : null,
        return_60d: p60 ? r2((p60 - series[i].close) / series[i].close * 100) : null,
        return_90d: p90 ? r2((p90 - series[i].close) / series[i].close * 100) : null,
        drawdown: r2((bottom - series[i].close) / series[i].close * 100),
      });
    }
  }

  // Strategy C: F&G < -25 AND fg is rising (current > 3-bar avg of fg)
  for (let i = 3; i < series.length; i++) {
    if (series[i].fg_score > -25) continue;
    const fgAvg3 = (series[i-1].fg_score + series[i-2].fg_score + series[i-3].fg_score) / 3;
    if (series[i].fg_score <= fgAvg3) continue; // Not rising yet

    const alreadyTraded = strategies.C.trades.some(t =>
      Math.abs(new Date(t.entry_date) - new Date(series[i].date)) < 20 * 86400000
    );
    if (alreadyTraded) continue;

    const p30 = i + 30 < series.length ? series[i + 30].close : null;
    const p60 = i + 60 < series.length ? series[i + 60].close : null;
    let bottom = series[i].close;
    for (let j = i; j < Math.min(i + 30, series.length); j++) {
      if (series[j].close < bottom) bottom = series[j].close;
    }

    strategies.C.trades.push({
      entry_date: series[i].date,
      entry_price: series[i].close,
      return_30d: p30 ? r2((p30 - series[i].close) / series[i].close * 100) : null,
      return_60d: p60 ? r2((p60 - series[i].close) / series[i].close * 100) : null,
      drawdown: r2((bottom - series[i].close) / series[i].close * 100),
    });
  }

  // Strategy D: F&G < -25 AND price > 5-day low (bounce confirmation)
  for (let i = 5; i < series.length; i++) {
    if (series[i].fg_score > -25) continue;
    let low5 = Infinity;
    for (let j = i - 5; j < i; j++) low5 = Math.min(low5, series[j].close);
    if (series[i].close <= low5) continue; // Price not above 5-day low

    const alreadyTraded = strategies.D.trades.some(t =>
      Math.abs(new Date(t.entry_date) - new Date(series[i].date)) < 20 * 86400000
    );
    if (alreadyTraded) continue;

    const p30 = i + 30 < series.length ? series[i + 30].close : null;
    const p60 = i + 60 < series.length ? series[i + 60].close : null;
    let bottom = series[i].close;
    for (let j = i; j < Math.min(i + 30, series.length); j++) {
      if (series[j].close < bottom) bottom = series[j].close;
    }

    strategies.D.trades.push({
      entry_date: series[i].date,
      entry_price: series[i].close,
      return_30d: p30 ? r2((p30 - series[i].close) / series[i].close * 100) : null,
      return_60d: p60 ? r2((p60 - series[i].close) / series[i].close * 100) : null,
      drawdown: r2((bottom - series[i].close) / series[i].close * 100),
    });
  }

  // Compute strategy stats
  for (const [key, strat] of Object.entries(strategies)) {
    const trades = strat.trades;
    const with30 = trades.filter(t => t.return_30d != null);
    const with60 = trades.filter(t => t.return_60d != null);

    strat.stats = {
      trade_count: trades.length,
      avg_return_30d: with30.length > 0 ? r2(with30.reduce((s, t) => s + t.return_30d, 0) / with30.length) : null,
      avg_return_60d: with60.length > 0 ? r2(with60.reduce((s, t) => s + t.return_60d, 0) / with60.length) : null,
      win_rate_30d: with30.length > 0 ? r2(with30.filter(t => t.return_30d > 0).length / with30.length * 100) : null,
      win_rate_60d: with60.length > 0 ? r2(with60.filter(t => t.return_60d > 0).length / with60.length * 100) : null,
      avg_drawdown: trades.length > 0 ? r2(trades.reduce((s, t) => s + (t.drawdown || 0), 0) / trades.length) : null,
      max_drawdown: trades.length > 0 ? r2(Math.min(...trades.map(t => t.drawdown || 0))) : null,
    };
  }

  return strategies;
}

// ─── Aggregate analysis ─────────────────────────────────────────────────────

/**
 * Aggregate statistics across all symbols' fear events.
 */
export function aggregateStats(allEvents) {
  const events = allEvents.filter(e => !e.still_in_fear);
  if (events.length === 0) return null;

  const daysToBottom = events.map(e => e.days_entry_to_bottom);
  const drawdowns = events.map(e => e.drawdown_after_signal);
  const ret30 = events.filter(e => e.return_30d != null).map(e => e.return_30d);
  const ret60 = events.filter(e => e.return_60d != null).map(e => e.return_60d);
  const ret90 = events.filter(e => e.return_90d != null).map(e => e.return_90d);

  const sorted = [...daysToBottom].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  return {
    total_events: events.length,
    timing: {
      avg_days_to_bottom: r2(daysToBottom.reduce((s, v) => s + v, 0) / daysToBottom.length),
      median_days_to_bottom: median,
      pct_bottom_within_5d: r2(daysToBottom.filter(d => d <= 5).length / daysToBottom.length * 100),
      pct_bottom_within_10d: r2(daysToBottom.filter(d => d <= 10).length / daysToBottom.length * 100),
      pct_bottom_within_20d: r2(daysToBottom.filter(d => d <= 20).length / daysToBottom.length * 100),
      avg_additional_drawdown: r2(drawdowns.reduce((s, v) => s + v, 0) / drawdowns.length),
    },
    returns: {
      avg_30d: ret30.length > 0 ? r2(ret30.reduce((s, v) => s + v, 0) / ret30.length) : null,
      avg_60d: ret60.length > 0 ? r2(ret60.reduce((s, v) => s + v, 0) / ret60.length) : null,
      avg_90d: ret90.length > 0 ? r2(ret90.reduce((s, v) => s + v, 0) / ret90.length) : null,
      win_rate_30d: ret30.length > 0 ? r2(ret30.filter(v => v > 0).length / ret30.length * 100) : null,
      win_rate_60d: ret60.length > 0 ? r2(ret60.filter(v => v > 0).length / ret60.length * 100) : null,
      win_rate_90d: ret90.length > 0 ? r2(ret90.filter(v => v > 0).length / ret90.length * 100) : null,
    },
  };
}

// ─── Optimal entry advisor ──────────────────────────────────────────────────

/**
 * Given current F&G and historical patterns, recommend entry timing.
 */
export function optimalEntry(symbol, currentFG, assetClass, aggStats) {
  if (!aggStats) return { action: 'NO_DATA', confidence: 0 };

  const timing = aggStats.timing;
  const returns = aggStats.returns;

  if (currentFG > -10) {
    return { action: 'NO_SIGNAL', confidence: 0, reasoning: 'F&G not in fear zone' };
  }

  if (currentFG > -25) {
    return {
      action: 'WAIT',
      confidence: 30,
      reasoning: `F&G at ${currentFG}, approaching fear zone but not actionable yet`,
      suggestedSize: '0%',
    };
  }

  // Deep fear — check if we should buy now or wait
  const deepFear = currentFG <= -35;
  const avgDaysToBottom = timing.avg_days_to_bottom;
  const avgDrawdown = timing.avg_additional_drawdown;
  const winRate = returns.win_rate_30d || 0;

  if (deepFear) {
    return {
      action: 'BUY_NOW',
      confidence: Math.min(95, Math.round(winRate)),
      reasoning: `F&G at ${currentFG} (deep fear). Historically bottoms within ${Math.round(avgDaysToBottom)} days. ${winRate}% win rate at 30d.`,
      suggestedSize: 'full position',
      expectedDrawdown: `${avgDrawdown}% avg after signal`,
      expectedReturn30d: `${returns.avg_30d}% avg`,
      expectedDaysToProfit: Math.round(avgDaysToBottom + 5),
      historicalWinRate: `${winRate}%`,
    };
  }

  // Moderate fear
  return {
    action: 'SCALE_IN',
    confidence: Math.min(80, Math.round(winRate * 0.8)),
    reasoning: `F&G at ${currentFG}. Could drop to -35 (avg ${avgDrawdown}% more drawdown). Scale in recommended.`,
    suggestedSize: '50% position now, 50% if F&G drops below -35',
    expectedDrawdown: `${avgDrawdown}% avg after signal`,
    expectedReturn30d: `${returns.avg_30d}% avg`,
    expectedDaysToProfit: Math.round(avgDaysToBottom + 7),
    historicalWinRate: `${winRate}%`,
  };
}

// ─── Full backtest pipeline ─────────────────────────────────────────────────

/**
 * Run a complete backtest for a single symbol.
 */
export async function backtestSymbol(symbol, years = 2) {
  const bars = Math.min(500, years * 252);
  const data = await fetchOhlcv(symbol, bars);
  if (!data || data.bars.length < 150) {
    return { symbol, error: 'Insufficient data', bars: data?.bars?.length || 0 };
  }

  const series = computeTimeSeries(data.bars);
  const events = findFearEvents(series);
  const strategies = simulateStrategies(series, events);

  return {
    symbol,
    source: data.source,
    type: data.type,
    bar_count: data.bars.length,
    series_length: series.length,
    fear_events: events.length,
    events,
    strategies: Object.fromEntries(
      Object.entries(strategies).map(([k, v]) => [k, { name: v.name, stats: v.stats }])
    ),
    current_fg: series.length > 0 ? series[series.length - 1].fg_score : null,
    current_zone: series.length > 0 ? series[series.length - 1].zone : null,
  };
}

/**
 * Run backtest across multiple symbols and aggregate results.
 */
export async function backtestMultiple(symbols, years = 2, concurrency = 10) {
  const t0 = Date.now();
  const results = [];
  const allEvents = [];
  const byAssetClass = { us: [], asx: [], crypto: [], commodity: [] };

  for (let i = 0; i < symbols.length; i += concurrency) {
    const batch = symbols.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(sym => backtestSymbol(sym, years).catch(e => ({ symbol: sym, error: e.message })))
    );
    for (const r of batchResults) {
      results.push(r);
      if (r.events) {
        for (const ev of r.events) {
          allEvents.push({ ...ev, symbol: r.symbol });
        }
        // Classify asset class
        const sym = r.symbol;
        if (sym.endsWith('.AX')) byAssetClass.asx.push(...r.events.map(e => ({ ...e, symbol: sym })));
        else if (sym.includes('=F')) byAssetClass.commodity.push(...r.events.map(e => ({ ...e, symbol: sym })));
        else if (r.type === 'crypto') byAssetClass.crypto.push(...r.events.map(e => ({ ...e, symbol: sym })));
        else byAssetClass.us.push(...r.events.map(e => ({ ...e, symbol: sym })));
      }
    }
  }

  const totalTime = Date.now() - t0;
  const agg = aggregateStats(allEvents);

  // Per-asset-class stats
  const assetClassStats = {};
  for (const [cls, events] of Object.entries(byAssetClass)) {
    if (events.length > 0) assetClassStats[cls] = aggregateStats(events);
  }

  // Strategy comparison across all symbols
  const allStrategies = {};
  for (const r of results) {
    if (!r.strategies) continue;
    for (const [key, strat] of Object.entries(r.strategies)) {
      if (!allStrategies[key]) allStrategies[key] = { name: strat.name, allTrades: [] };
      // Re-collect trades from events
    }
  }

  return {
    success: true,
    timing: { total_ms: totalTime, total_readable: (totalTime / 1000).toFixed(1) + 's' },
    symbols_tested: results.length,
    symbols_with_events: results.filter(r => r.fear_events > 0).length,
    total_fear_events: allEvents.length,
    aggregate: agg,
    by_asset_class: assetClassStats,
    symbols: results.map(r => ({
      symbol: r.symbol,
      fear_events: r.fear_events || 0,
      current_fg: r.current_fg,
      current_zone: r.current_zone,
      best_strategy: r.strategies ? getBestStrategy(r.strategies) : null,
      error: r.error,
    })),
    strategy_comparison: results.reduce((acc, r) => {
      if (!r.strategies) return acc;
      for (const [key, strat] of Object.entries(r.strategies)) {
        if (!acc[key]) acc[key] = { name: strat.name, total_trades: 0, returns_30d: [], drawdowns: [] };
        acc[key].total_trades += strat.stats.trade_count;
        if (strat.stats.avg_return_30d != null) acc[key].returns_30d.push(strat.stats.avg_return_30d);
        if (strat.stats.avg_drawdown != null) acc[key].drawdowns.push(strat.stats.avg_drawdown);
      }
      return acc;
    }, {}),
  };
}

function getBestStrategy(strategies) {
  let best = null, bestReturn = -Infinity;
  for (const [key, strat] of Object.entries(strategies)) {
    if (strat.stats.avg_return_30d != null && strat.stats.avg_return_30d > bestReturn) {
      bestReturn = strat.stats.avg_return_30d;
      best = key;
    }
  }
  return best;
}
