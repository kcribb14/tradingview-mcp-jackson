/**
 * Unified Signal Scoring Engine — ranks every entry signal by quality.
 *
 * Multi-factor scoring (0-100):
 *   F&G Depth (0-25)     — how far below calibrated threshold
 *   Volume Spike (0-15)  — moneyFlow proxy for unusual volume
 *   ATH Distance (0-15)  — deeper from high = more oversold
 *   Cycle Lag (0-15)     — lagging its rotation leader
 *   RSI Oversold (0-10)  — RSI < 30 = deeply oversold
 *   Momentum (0-10)      — pmacd deeply negative = capitulation
 *   Historical WR (0-10) — backtest win rate for asset class
 *
 * Grade: A (70+), B (50-69), C (30-49), D (<30)
 */

const CLASS_WR = {
  US_LARGE_CAP: 100, US_MID_SMALL: 52, ASX_TOP50: 71, ASX_MINING_MID: 100,
  ASX_MINING_MICRO: 33, CRYPTO_MAJOR: 100, CRYPTO_MID: 50, COMMODITIES: 100, ETFS: 80,
};

/**
 * Score a single entry zone signal.
 * @param {object} row — dashboard row { s, f, r, ch, wh, ad, ss, c, w, ... }
 * @param {object} opts — { threshold, lagGap, classKey }
 * @returns {{ score, grade, factors }}
 */
export function scoreSignal(row, opts = {}) {
  let score = 0;
  const factors = [];

  // Factor 1: F&G Depth (0-25)
  const threshold = opts.threshold ?? -15;
  const depth = Math.max(0, threshold - row.f);
  const f1 = Math.min(25, Math.round(depth * 1.5));
  score += f1;
  if (f1 > 0) factors.push({ name: 'F&G Depth', val: depth.toFixed(0) + ' pts below', pts: f1, max: 25 });

  // Factor 2: Volume/Whale (0-15)
  const mf = Math.abs(row.mfRaw ?? 0);
  const isWhale = row.wh === 'ACC';
  const f2 = isWhale ? 15 : mf > 20 ? 10 : mf > 10 ? 5 : 0;
  score += f2;
  if (f2 > 0) factors.push({ name: isWhale ? 'Whale Accumulation' : 'Volume Elevated', val: isWhale ? '🐋' : mf.toFixed(0), pts: f2, max: 15 });

  // Factor 3: ATH Distance proxy (0-15)
  const ath = Math.abs(row.ad ?? 0);
  const f3 = Math.min(15, Math.round(ath / 5));
  score += f3;
  if (f3 > 0) factors.push({ name: 'ATH Distance', val: (row.ad ?? 0).toFixed(0) + '%', pts: f3, max: 15 });

  // Factor 4: Cycle Lag (0-15)
  const lag = opts.lagGap ?? 0;
  const f4 = lag > 5 ? Math.min(15, Math.round(lag * 0.8)) : 0;
  score += f4;
  if (f4 > 0) factors.push({ name: 'Lagging Leader', val: lag.toFixed(0) + ' pts', pts: f4, max: 15 });

  // Factor 5: RSI Oversold (0-10)
  const rsi = row.r ?? 50;
  const f5 = rsi < 25 ? 10 : rsi < 30 ? 8 : rsi < 35 ? 5 : rsi < 40 ? 2 : 0;
  score += f5;
  if (f5 > 0) factors.push({ name: 'RSI Oversold', val: rsi.toFixed(0), pts: f5, max: 10 });

  // Factor 6: Momentum (0-10)
  const pmacd = Math.abs(row.ch ?? 0);
  const f6 = pmacd > 20 ? 10 : pmacd > 10 ? 7 : pmacd > 5 ? 3 : 0;
  score += f6;
  if (f6 > 0) factors.push({ name: 'Deep Momentum', val: (row.ch ?? 0).toFixed(1) + '%', pts: f6, max: 10 });

  // Factor 7: Historical WR (0-10)
  const cls = opts.classKey || 'US_MID_SMALL';
  const wr = CLASS_WR[cls] ?? 50;
  const f7 = wr >= 80 ? 10 : wr >= 65 ? 7 : wr >= 55 ? 4 : 0;
  score += f7;
  if (f7 > 0) factors.push({ name: 'Backtest WR', val: wr + '%', pts: f7, max: 10 });

  score = Math.min(100, score);
  const grade = score >= 70 ? 'A' : score >= 50 ? 'B' : score >= 30 ? 'C' : 'D';

  return { score, grade, factors };
}
