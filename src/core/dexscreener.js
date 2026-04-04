/**
 * DexScreener integration — on-chain DEX data for crypto F&G scoring.
 *
 * Provides liquidity, buy/sell counts, pair age, real-time volume
 * that TradingView and Yahoo don't have.
 *
 * API: https://api.dexscreener.com (no auth, no documented rate limits)
 */

const BASE = 'https://api.dexscreener.com';

// ─── Data Fetching ──────────────────────────────────────────────────────────

async function dexFetch(path) {
  const resp = await fetch(`${BASE}${path}`, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) return null;
  return resp.json();
}

/**
 * Get pair data for a token by contract address.
 * Returns up to 30 pairs sorted by liquidity.
 */
export async function fetchTokenPairs(address) {
  const data = await dexFetch(`/latest/dex/tokens/${address}`);
  return data?.pairs || [];
}

/**
 * Search for tokens by name/symbol. Returns top 30 matches.
 */
export async function searchTokens(query) {
  const data = await dexFetch(`/latest/dex/search?q=${encodeURIComponent(query)}`);
  return data?.pairs || [];
}

/**
 * Get tokens with active paid boosts (promotion signals).
 */
export async function fetchBoostedTokens() {
  return await dexFetch('/token-boosts/top/v1') || [];
}

/**
 * Get the highest-volume pair for a token by searching.
 * Filters to a specific chain if provided.
 */
export async function fetchBestPair(query, chain = null) {
  const pairs = await searchTokens(query);
  let filtered = pairs;
  if (chain) {
    filtered = pairs.filter(p => p.chainId === chain);
  }
  // Sort by 24h volume descending
  filtered.sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));
  return filtered[0] || null;
}

/**
 * Fetch top pairs by volume for a given chain via search.
 * Searches common high-cap tokens and aggregates results.
 */
export async function fetchTopPairsByChain(chain, limit = 50) {
  // Search tokens that commonly trade on this chain
  const queries = chain === 'solana'
    ? ['SOL', 'USDC', 'JUP', 'RAY', 'ORCA', 'BONK', 'WIF', 'JTO', 'PYTH', 'W', 'RENDER', 'HNT', 'MOBILE', 'SAMO', 'POPCAT', 'MEW', 'BOME', 'SLERF', 'TRUMP', 'MELANIA']
    : chain === 'ethereum'
    ? ['ETH', 'PEPE', 'SHIB', 'UNI', 'AAVE', 'LINK', 'MKR', 'LDO', 'CRV', 'COMP', 'ENS', 'APE', 'BLUR', 'DYDX', 'GRT', 'SNX', 'RPL', '1INCH', 'SUSHI', 'YFI']
    : chain === 'base'
    ? ['BRETT', 'DEGEN', 'AERO', 'TOSHI', 'WELL', 'VIRTUAL', 'MOCHI', 'BASED', 'MFER', 'NORMIE']
    : ['SOL', 'ETH', 'PEPE', 'BONK', 'WIF', 'BRETT'];

  const seen = new Set();
  const allPairs = [];

  // Fetch in parallel batches of 5
  for (let i = 0; i < queries.length; i += 5) {
    const batch = queries.slice(i, i + 5);
    const results = await Promise.all(batch.map(q => searchTokens(q)));
    for (const pairs of results) {
      for (const pair of pairs) {
        if (pair.chainId !== chain) continue;
        const key = pair.pairAddress;
        if (seen.has(key)) continue;
        seen.add(key);
        allPairs.push(pair);
      }
    }
  }

  // Sort by 24h volume and take top N
  allPairs.sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));
  return allPairs.slice(0, limit);
}

// ─── DEX Fear & Greed Score ─────────────────────────────────────────────────

/**
 * Calculate a DEX-specific Fear & Greed score from on-chain pair data.
 *
 * Components (all normalized to roughly [-30, +30]):
 *   priceDeviation — 24h price change magnitude + direction
 *   momentum       — 1h vs 24h trend alignment
 *   volumeFlow     — volume trend (h1 vs h6)
 *   orderFlow      — buy/sell ratio from on-chain txns
 *   liquidityHealth — liquidity relative to FDV
 *   ageRisk        — penalty for very new pairs
 *
 * Returns score in [-60, +60] matching the standard F&G scale.
 */
export function dexFearGreed(pair) {
  if (!pair) return null;

  const pc = pair.priceChange || {};
  const vol = pair.volume || {};
  const txns = pair.txns || {};
  const liq = pair.liquidity?.usd || 0;
  const fdv = pair.fdv || 0;

  // Component 1: Price deviation (24h change mapped to [-30, +30])
  const change24h = pc.h24 ?? 0;
  const priceDeviation = Math.max(-30, Math.min(30, change24h * 0.4));

  // Component 2: Momentum — is short-term trend aligning with longer trend?
  const change1h = pc.h1 ?? 0;
  const change6h = pc.h6 ?? 0;
  // Same direction on 1h and 24h = momentum, divergence = reversal signal
  const momentumRaw = change1h * 0.5 + (change6h - change24h) * 0.1;
  const momentum = Math.max(-20, Math.min(20, momentumRaw));

  // Component 3: Volume flow — is volume increasing or decreasing?
  const vol1h = vol.h1 || 0;
  const vol6h = vol.h6 || 1;
  const volTrend = vol6h > 0 ? (vol1h * 6 / vol6h - 1) : 0; // normalized hourly rate
  const direction = change1h > 0 ? 1 : change1h < 0 ? -1 : 0;
  const volumeFlow = Math.max(-25, Math.min(25, direction * Math.min(3, Math.abs(volTrend)) * 8));

  // Component 4: Order flow — buy/sell ratio from on-chain transactions
  const buys24 = txns.h24?.buys || 0;
  const sells24 = txns.h24?.sells || 0;
  const totalTxns = buys24 + sells24;
  let orderFlow = 0;
  if (totalTxns > 10) {
    const buyRatio = buys24 / totalTxns; // 0.5 = neutral
    orderFlow = Math.max(-20, Math.min(20, (buyRatio - 0.5) * 60));
  }

  // Component 5: Liquidity health — liquidity relative to FDV
  let liquidityHealth = 0;
  if (fdv > 0 && liq > 0) {
    const liqRatio = liq / fdv;
    // liqRatio > 0.1 = healthy, < 0.01 = thin, > 0.5 = very deep
    liquidityHealth = Math.max(-15, Math.min(10, (liqRatio - 0.05) * 100));
  }

  // Component 6: Age risk — penalty for very new pairs
  let ageRisk = 0;
  if (pair.pairCreatedAt) {
    const ageHours = (Date.now() - pair.pairCreatedAt) / 3600000;
    if (ageHours < 1) ageRisk = -15; // < 1 hour: very risky
    else if (ageHours < 24) ageRisk = -8; // < 1 day: risky
    else if (ageHours < 168) ageRisk = -3; // < 1 week: caution
    // Older pairs get no penalty
  }

  // Weighted composite
  const raw = (
    priceDeviation * 0.25 +
    momentum * 0.15 +
    volumeFlow * 0.20 +
    orderFlow * 0.20 +
    liquidityHealth * 0.10 +
    ageRisk * 0.10
  );

  const score = Math.max(-60, Math.min(60, Math.round(raw * 100) / 100));
  const { zone, severity } = classifyDexZone(score);

  return {
    dex_fg: score,
    zone,
    severity,
    components: {
      price_deviation: round(priceDeviation),
      momentum: round(momentum),
      volume_flow: round(volumeFlow),
      order_flow: round(orderFlow),
      liquidity_health: round(liquidityHealth),
      age_risk: round(ageRisk),
    },
    raw_data: {
      buys_24h: buys24,
      sells_24h: sells24,
      buy_ratio: totalTxns > 0 ? round(buys24 / totalTxns) : null,
      volume_24h: round(vol.h24 || 0),
      liquidity_usd: round(liq),
      fdv: round(fdv),
      pair_age_hours: pair.pairCreatedAt ? round((Date.now() - pair.pairCreatedAt) / 3600000) : null,
      price_change: { m5: pc.m5, h1: pc.h1, h6: pc.h6, h24: pc.h24 },
    },
  };
}

function classifyDexZone(score) {
  if (score >= 41) return { zone: 'EXTREME GREED', severity: 2 };
  if (score >= 10) return { zone: 'GREED', severity: 1 };
  if (score >= -10) return { zone: 'NEUTRAL', severity: 0 };
  if (score >= -25) return { zone: 'FEAR', severity: -1 };
  return { zone: 'EXTREME FEAR', severity: -2 };
}

function round(v) { return v != null ? Math.round(v * 100) / 100 : null; }

// ─── Multi-TF from DexScreener price changes ────────────────────────────────

/**
 * Map DexScreener's priceChange fields to our 4 standard timeframes.
 *   15m: interpolate 5m → 1h (weighted toward 5m)
 *   1H:  direct from h1
 *   4H:  interpolate h1 → h6
 *   D:   direct from h24
 */
export function dexMultiTF(pair) {
  const pc = pair?.priceChange || {};
  const m5 = pc.m5 ?? null;
  const h1 = pc.h1 ?? null;
  const h6 = pc.h6 ?? null;
  const h24 = pc.h24 ?? null;

  // Map price changes to F&G-like scores (scale: change% → F&G [-60,+60])
  const scale = (v) => v != null ? Math.max(-60, Math.min(60, v * 0.5)) : null;

  return {
    fg_15m: m5 != null && h1 != null ? scale(m5 * 0.6 + h1 * 0.4) : scale(m5 ?? h1),
    fg_1H: scale(h1),
    fg_4H: h1 != null && h6 != null ? scale(h1 * 0.3 + h6 * 0.7) : scale(h6),
    fg_D: scale(h24),
  };
}

// ─── Scan Pipeline ──────────────────────────────────────────────────────────

/**
 * Scan top DEX pairs on a chain, calculate DEX F&G for each.
 *
 * @param {string} chain - "solana", "ethereum", "base"
 * @param {number} top - Return top N results (default 50)
 */
export async function dexScan({ chain = 'solana', top = 50 } = {}) {
  const t0 = Date.now();

  const pairs = await fetchTopPairsByChain(chain, top * 2); // overfetch to filter
  const fetchTime = Date.now() - t0;

  // Filter: minimum volume and liquidity
  const viable = pairs.filter(p =>
    (p.volume?.h24 || 0) > 1000 &&
    (p.liquidity?.usd || 0) > 5000
  );

  // Score each pair
  const results = viable.map(pair => {
    const fg = dexFearGreed(pair);
    const mtf = dexMultiTF(pair);
    return {
      symbol: pair.baseToken?.symbol || '???',
      token_address: pair.baseToken?.address?.slice(0, 8) + '...',
      chain: pair.chainId,
      dex: pair.dexId,
      price_usd: pair.priceUsd ? parseFloat(pair.priceUsd) : null,
      ...fg,
      mtf,
      pair_url: pair.url,
    };
  });

  // Sort by dex_fg ascending (most fearful first)
  results.sort((a, b) => (a.dex_fg ?? 0) - (b.dex_fg ?? 0));

  const totalTime = Date.now() - t0;

  // Signal distribution
  const dist = { extreme_fear: 0, fear: 0, neutral: 0, greed: 0, extreme_greed: 0 };
  for (const r of results) {
    if (r.severity === -2) dist.extreme_fear++;
    else if (r.severity === -1) dist.fear++;
    else if (r.severity === 0) dist.neutral++;
    else if (r.severity === 1) dist.greed++;
    else if (r.severity === 2) dist.extreme_greed++;
  }

  return {
    success: true,
    scan_type: 'dex',
    chain,
    timing: {
      fetch_ms: fetchTime,
      total_ms: totalTime,
      total_readable: (totalTime / 1000).toFixed(1) + 's',
    },
    pairs_found: pairs.length,
    viable_pairs: viable.length,
    results: results.slice(0, top),
    fear_opportunities: results.filter(r => r.severity <= -1).slice(0, 10),
    greed_warnings: [...results].sort((a, b) => (b.dex_fg ?? 0) - (a.dex_fg ?? 0)).filter(r => r.severity >= 1).slice(0, 10),
    distribution: dist,
  };
}

// ─── DEX vs CEX Comparison ──────────────────────────────────────────────────

/**
 * Compare DEX and CEX F&G scores for tokens that exist on both.
 * Alpha signal: when DEX buying diverges from CEX selling (or vice versa).
 */
export async function dexVsCexScan({ top = 20 } = {}) {
  const t0 = Date.now();

  // Tokens available on both CEX and DEX
  const tokens = [
    { symbol: 'SOL', dexQuery: 'SOL', yahooTicker: 'SOL-USD', chain: 'solana' },
    { symbol: 'ETH', dexQuery: 'ETH', yahooTicker: 'ETH-USD', chain: 'ethereum' },
    { symbol: 'BONK', dexQuery: 'BONK', yahooTicker: 'BONK-USD', chain: 'solana' },
    { symbol: 'PEPE', dexQuery: 'PEPE', yahooTicker: 'PEPE-USD', chain: 'ethereum' },
    { symbol: 'WIF', dexQuery: 'WIF', yahooTicker: 'WIF-USD', chain: 'solana' },
    { symbol: 'SHIB', dexQuery: 'SHIB', yahooTicker: 'SHIB-USD', chain: 'ethereum' },
    { symbol: 'UNI', dexQuery: 'UNI', yahooTicker: 'UNI-USD', chain: 'ethereum' },
    { symbol: 'AAVE', dexQuery: 'AAVE', yahooTicker: 'AAVE-USD', chain: 'ethereum' },
    { symbol: 'LINK', dexQuery: 'LINK', yahooTicker: 'LINK-USD', chain: 'ethereum' },
    { symbol: 'AVAX', dexQuery: 'AVAX', yahooTicker: 'AVAX-USD', chain: 'ethereum' },
    { symbol: 'DOGE', dexQuery: 'DOGE', yahooTicker: 'DOGE-USD', chain: 'ethereum' },
    { symbol: 'ADA', dexQuery: 'ADA', yahooTicker: 'ADA-USD', chain: 'ethereum' },
    { symbol: 'DOT', dexQuery: 'DOT', yahooTicker: 'DOT-USD', chain: 'ethereum' },
    { symbol: 'JUP', dexQuery: 'JUP', yahooTicker: 'JUP-USD', chain: 'solana' },
    { symbol: 'RAY', dexQuery: 'RAY', yahooTicker: 'RAY-USD', chain: 'solana' },
  ];

  // Fetch DEX data
  const dexResults = new Map();
  const dexPromises = tokens.map(async (t) => {
    const pair = await fetchBestPair(t.dexQuery, t.chain);
    if (pair) dexResults.set(t.symbol, { pair, fg: dexFearGreed(pair) });
  });
  await Promise.all(dexPromises);

  // Fetch CEX data (Yahoo)
  const { fetchBatchOhlcv } = await import('./yahoo_ohlcv.js');
  const { computeFGFromBars } = await import('./fg_cache.js');
  const { loadGlobals } = await import('./fg_cache.js');

  const yahooSymbols = tokens.map(t => t.yahooTicker);
  const ceoBatch = await fetchBatchOhlcv(yahooSymbols, 200, 10);
  const globals = loadGlobals();

  const results = [];
  for (const token of tokens) {
    const dex = dexResults.get(token.symbol);
    const cexOhlcv = ceoBatch.results.get(token.yahooTicker);

    let cexFG = null;
    if (cexOhlcv && cexOhlcv.bars.length >= 5) {
      const fg = computeFGFromBars(cexOhlcv.bars, {}, globals);
      if (fg) cexFG = fg;
    }

    const dexScore = dex?.fg?.dex_fg ?? null;
    const cexScore = cexFG?.fgScore ?? null;
    const divergence = (dexScore != null && cexScore != null)
      ? round(dexScore - cexScore)
      : null;

    let signal = 'NO_DATA';
    if (dexScore != null && cexScore != null) {
      if (dexScore > 5 && cexScore < -5) signal = 'DEX_BUYING_CEX_SELLING'; // smart money accumulating
      else if (dexScore < -5 && cexScore > 5) signal = 'DEX_SELLING_CEX_BUYING'; // smart money distributing
      else if (Math.abs(divergence) < 5) signal = 'ALIGNED';
      else if (dexScore > cexScore) signal = 'DEX_MORE_BULLISH';
      else signal = 'CEX_MORE_BULLISH';
    }

    results.push({
      symbol: token.symbol,
      chain: token.chain,
      dex_fg: dexScore,
      cex_fg: cexScore,
      divergence,
      signal,
      dex_zone: dex?.fg?.zone ?? null,
      cex_zone: cexFG ? (cexFG.fgScore >= 10 ? 'GREED' : cexFG.fgScore <= -10 ? 'FEAR' : 'NEUTRAL') : null,
      dex_buys_24h: dex?.fg?.raw_data?.buys_24h ?? null,
      dex_sells_24h: dex?.fg?.raw_data?.sells_24h ?? null,
      dex_buy_ratio: dex?.fg?.raw_data?.buy_ratio ?? null,
      dex_volume_24h: dex?.fg?.raw_data?.volume_24h ?? null,
      dex_liquidity: dex?.fg?.raw_data?.liquidity_usd ?? null,
      price_usd: dex?.pair?.priceUsd ? parseFloat(dex.pair.priceUsd) : null,
    });
  }

  // Sort by absolute divergence
  results.sort((a, b) => Math.abs(b.divergence ?? 0) - Math.abs(a.divergence ?? 0));

  const totalTime = Date.now() - t0;

  return {
    success: true,
    scan_type: 'dex-vs-cex',
    timing: {
      total_ms: totalTime,
      total_readable: (totalTime / 1000).toFixed(1) + 's',
    },
    results: results.slice(0, top),
    alpha_signals: results.filter(r =>
      r.signal === 'DEX_BUYING_CEX_SELLING' || r.signal === 'DEX_SELLING_CEX_BUYING'
    ),
  };
}
