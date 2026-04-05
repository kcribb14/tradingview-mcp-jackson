/**
 * Universal Fundamental vs Sentiment Framework
 *
 * Every asset class has its own "drill results" — fundamentals that SHOULD
 * move the price. When fundamentals are strong but F&G shows fear, the market
 * hasn't priced in the catalyst. That gap is the alpha.
 *
 * Mining:      Geological discovery (drill results, resource extension)
 * Crypto:      On-chain growth (dev activity, buy ratio, TVL)
 * US Stocks:   Earnings/revenue surprise
 * Commodities: Supply/demand balance
 */

/**
 * Calculate fundamental score for mining stocks.
 * @param {object} geo — CANETOAD geological data
 * @returns {number} 0-100
 */
export function miningFundamental(geo) {
  if (!geo) return null;
  let score = 30; // baseline for having drilling data

  // Geological score component (0-30)
  score += Math.min(30, (geo.geological_score || 0) * 0.3);

  // Recent drill report quality (0-25)
  const latest = geo.reports?.[0];
  if (latest) {
    if (latest.quality === 'P99') score += 25;
    else if (latest.quality === 'P95') score += 18;
    else if (latest.quality === 'P90') score += 12;
    else if (latest.quality === 'P85') score += 6;
    if (latest.extension) score += 5; // resource extension bonus
  }

  // Unreacted drill result bonus (0-15)
  const rx = latest?.reaction;
  if (rx?.status === 'CONTRARIAN_BUY') score += 15;
  else if (rx?.status === 'UNREACTED') score += 10;

  // Stranded assets bonus (0-10)
  if (geo.stranded_assets?.estimated_newly_economic > 100) score += 10;
  else if (geo.stranded_assets?.estimated_newly_economic > 10) score += 5;

  return Math.min(100, Math.max(0, Math.round(score)));
}

/**
 * Calculate fundamental score for crypto tokens.
 * @param {object} data — { devCommits, sentimentUp, buyRatio, volMcapRatio, athDistance }
 * @returns {number} 0-100
 */
export function cryptoFundamental(data) {
  if (!data) return null;
  let score = 40; // baseline

  // Developer activity (0-20)
  const commits = data.devCommits ?? 0;
  if (commits > 100) score += 20;
  else if (commits > 50) score += 12;
  else if (commits > 20) score += 6;
  else if (commits < 5) score -= 10; // dead project

  // Community sentiment (0-10)
  const sent = data.sentimentUp ?? 50;
  if (sent > 75) score += 10;
  else if (sent > 60) score += 5;
  else if (sent < 30) score -= 5;

  // Buy/sell ratio from DEX (0-15)
  const br = data.buyRatio ?? 0.5;
  if (br > 0.65) score += 15;
  else if (br > 0.55) score += 8;
  else if (br < 0.4) score -= 5;

  // Volume/MCap ratio (0-10)
  const vmr = data.volMcapRatio ?? 0;
  if (vmr > 5) score += 10;
  else if (vmr > 2) score += 5;

  // Watchlist interest (0-5)
  if ((data.watchlistUsers ?? 0) > 1000000) score += 5;
  else if ((data.watchlistUsers ?? 0) > 100000) score += 3;

  return Math.min(100, Math.max(0, Math.round(score)));
}

/**
 * Calculate fundamental score for stocks.
 * @param {object} data — { earningsSurprise, revenueGrowth, volumeSpike, rsi }
 * @returns {number} 0-100
 */
export function stockFundamental(data) {
  if (!data) return null;
  let score = 45; // baseline

  // Earnings surprise (0-25)
  const surprise = data.earningsSurprise ?? 0;
  if (surprise > 10) score += 25;
  else if (surprise > 5) score += 18;
  else if (surprise > 0) score += 10;
  else if (surprise < -5) score -= 15;

  // Revenue growth (0-15)
  const rg = data.revenueGrowth ?? 0;
  if (rg > 0.2) score += 15;
  else if (rg > 0.1) score += 10;
  else if (rg > 0) score += 5;
  else if (rg < -0.1) score -= 10;

  // Volume spike during fear = institutional buying (0-15)
  if (data.volumeSpike > 3) score += 15;
  else if (data.volumeSpike > 2) score += 8;

  return Math.min(100, Math.max(0, Math.round(score)));
}

/**
 * Calculate fundamental score for commodities.
 * Uses price momentum as proxy for supply/demand.
 * @param {object} data — { pmacd, ror }
 * @returns {number} 0-100
 */
export function commodityFundamental(data) {
  if (!data) return null;
  let score = 50;

  // Price vs EMA as proxy for supply trend (0-25)
  const pmacd = data.pmacd ?? 0;
  if (pmacd > 10) score += 25;
  else if (pmacd > 5) score += 15;
  else if (pmacd > 0) score += 8;
  else if (pmacd < -10) score -= 15;

  // Rate of return as momentum (0-15)
  const ror = data.ror ?? 0;
  if (ror > 20) score += 15;
  else if (ror > 10) score += 8;
  else if (ror < -20) score -= 10;

  return Math.min(100, Math.max(0, Math.round(score)));
}

/**
 * Calculate the Fundamental vs Sentiment gap.
 * Positive gap = fundamentals stronger than sentiment (buy opportunity)
 * Negative gap = sentiment stronger than fundamentals (overvalued)
 */
export function calculateGap(fundamentalScore, fgScore) {
  if (fundamentalScore == null || fgScore == null) return null;
  // Normalize F&G to 0-100 where 0=extreme fear, 100=extreme greed
  const sentimentNorm = Math.max(0, Math.min(100, (fgScore + 50) / 100 * 100));
  return Math.round(fundamentalScore - sentimentNorm);
}
