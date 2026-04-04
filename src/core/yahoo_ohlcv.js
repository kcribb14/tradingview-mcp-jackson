/**
 * Yahoo Finance OHLCV fetcher — zero TradingView interaction.
 *
 * Uses Yahoo Finance v8 chart API (no auth needed):
 *   https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1y&interval=1d
 *
 * ~100ms per symbol. 500 symbols = ~50 seconds total.
 */

const BASE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';

/**
 * Map TradingView symbol format to Yahoo Finance ticker.
 * TV uses "EXCHANGE:SYMBOL" format, Yahoo uses plain tickers with different suffixes.
 */
function toYahooTicker(tvSymbol) {
  // Strip exchange prefix if present
  let sym = tvSymbol.includes(':') ? tvSymbol.split(':').pop() : tvSymbol;

  // Already in Yahoo format (e.g., BTC-USD, ^VIX, GC=F)
  if (sym.includes('-') || sym.includes('=') || sym.startsWith('^')) return sym;

  // Crypto: BTCUSD → BTC-USD (only if it ends with USD and looks like a crypto pair)
  const cryptoMatch = sym.match(/^([A-Z]{2,10})USD$/);
  if (cryptoMatch) {
    const base = cryptoMatch[1];
    const cryptos = ['BTC','ETH','SOL','XRP','DOGE','ADA','DOT','AVAX','LINK','MATIC',
      'BNB','SHIB','UNI','AAVE','LTC','NEAR','ATOM','FTM','ALGO','SAND','HBAR',
      'APT','ARB','OP','SUI','SEI','TIA','INJ','PEPE','WLD','FET','RNDR','GRT',
      'MKR','CRV','COMP','SNX','LDO','RPL','SSV','SUSHI','YFI','BAL','1INCH'];
    if (cryptos.includes(base)) return base + '-USD';
  }

  return sym;
}

/**
 * Fetch OHLCV bars from Yahoo Finance for a single symbol.
 *
 * @param {string} symbol - TradingView symbol (e.g., "AAPL", "ASX:BHP")
 * @param {number} bars - Number of daily bars to fetch (max ~250 for 1y)
 * @param {string} interval - Bar interval: "1d", "1h", "5m" (default "1d")
 * @returns {{ bars: Array, symbol: string, currency: string }} or null on error
 */
export async function fetchOhlcv(symbol, bars = 200, interval = '1d') {
  const ticker = toYahooTicker(symbol);

  // Yahoo interval mapping + range constraints
  // 15m: max 60 days range
  // 1h:  max 730 days range
  // 1d:  unlimited
  let yahooInterval = interval;
  let range;

  if (interval === '15m' || interval === '15') {
    yahooInterval = '15m';
    // 15m bars: ~26 per trading day, need bars/26 days
    const days = Math.min(60, Math.max(5, Math.ceil(bars / 26) + 2));
    range = days + 'd';
  } else if (interval === '60m' || interval === '1h' || interval === '60') {
    yahooInterval = '1h';
    // 1h bars: ~7 per trading day, need bars/7 days
    const days = Math.min(729, Math.max(5, Math.ceil(bars / 7) + 2));
    range = days <= 30 ? days + 'd' : days <= 180 ? Math.ceil(days / 30) + 'mo' : '2y';
  } else if (interval === '4h' || interval === '240' || interval === '240m') {
    // Yahoo doesn't have 4H — fetch 1H and aggregate
    yahooInterval = '1h';
    const days = Math.min(729, Math.max(10, Math.ceil(bars * 4 / 7) + 5));
    range = days <= 30 ? days + 'd' : days <= 180 ? Math.ceil(days / 30) + 'mo' : '2y';
  } else {
    // Daily
    yahooInterval = '1d';
    if (bars <= 5) range = '5d';
    else if (bars <= 30) range = '1mo';
    else if (bars <= 90) range = '3mo';
    else if (bars <= 180) range = '6mo';
    else if (bars <= 365) range = '1y';
    else range = '2y';
  }

  const url = `${BASE_URL}/${encodeURIComponent(ticker)}?range=${range}&interval=${yahooInterval}&includePrePost=false`;

  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) return null;
    const data = await resp.json();

    const chart = data?.chart?.result?.[0];
    if (!chart) return null;

    const timestamps = chart.timestamp;
    const quote = chart.indicators?.quote?.[0];
    if (!timestamps || !quote) return null;

    const ohlcvBars = [];
    for (let i = 0; i < timestamps.length; i++) {
      const o = quote.open?.[i];
      const h = quote.high?.[i];
      const l = quote.low?.[i];
      const c = quote.close?.[i];
      const v = quote.volume?.[i];
      if (o != null && h != null && l != null && c != null) {
        ohlcvBars.push({
          time: timestamps[i],
          open: o,
          high: h,
          low: l,
          close: c,
          volume: v || 0,
        });
      }
    }

    // Aggregate to 4H if requested
    let finalBars = ohlcvBars;
    if (interval === '4h' || interval === '240' || interval === '240m') {
      finalBars = aggregateBars(ohlcvBars, 4);
    }

    // Trim to requested bar count
    const trimmed = finalBars.slice(-bars);

    return {
      bars: trimmed,
      symbol,
      yahoo_ticker: ticker,
      currency: chart.meta?.currency || 'USD',
      exchange: chart.meta?.exchangeName || null,
      bar_count: trimmed.length,
      interval,
    };
  } catch {
    return null;
  }
}

/**
 * Aggregate smaller-timeframe bars into larger ones.
 * E.g., group every N 1H bars into 4H bars.
 */
function aggregateBars(bars, groupSize) {
  const result = [];
  for (let i = 0; i < bars.length; i += groupSize) {
    const group = bars.slice(i, i + groupSize);
    if (group.length === 0) continue;
    result.push({
      time: group[0].time,
      open: group[0].open,
      high: Math.max(...group.map(b => b.high)),
      low: Math.min(...group.map(b => b.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((s, b) => s + b.volume, 0),
    });
  }
  return result;
}

/**
 * Fetch OHLCV for a single symbol across multiple timeframes.
 * Returns a map of interval → bars data.
 */
export async function fetchMultiTF(symbol, intervals = ['15m', '1h', '4h', '1d'], bars = 200) {
  const results = new Map();
  const promises = intervals.map(async (interval) => {
    const data = await fetchOhlcv(symbol, bars, interval);
    if (data) results.set(interval, data);
  });
  await Promise.all(promises);
  return results;
}

/**
 * Fetch OHLCV for multiple symbols across multiple timeframes in parallel.
 */
export async function fetchBatchMultiTF(symbols, intervals = ['15m', '1h', '4h', '1d'], bars = 200, concurrency = 10) {
  const t0 = Date.now();
  const results = new Map(); // symbol → Map(interval → data)
  const errors = [];

  // Build all fetch tasks: symbol × interval
  const tasks = [];
  for (const sym of symbols) {
    for (const interval of intervals) {
      tasks.push({ sym, interval });
    }
  }

  // Process in batches
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    const promises = batch.map(async ({ sym, interval }) => {
      const data = await fetchOhlcv(sym, bars, interval);
      if (data) {
        if (!results.has(sym)) results.set(sym, new Map());
        results.get(sym).set(interval, data);
      }
    });
    await Promise.all(promises);
  }

  // Count errors
  for (const sym of symbols) {
    if (!results.has(sym) || results.get(sym).size === 0) {
      errors.push(sym);
    }
  }

  return {
    results,
    errors,
    fetched: results.size,
    failed: errors.length,
    total_requests: tasks.length,
    timing_ms: Date.now() - t0,
  };
}

/**
 * Fetch OHLCV for multiple symbols in parallel batches.
 * Respects Yahoo rate limits with configurable concurrency.
 *
 * @param {string[]} symbols - Array of TradingView symbols
 * @param {number} bars - Bars per symbol (default 200)
 * @param {number} concurrency - Parallel requests (default 10)
 * @returns {{ results: Map<string, object>, errors: string[], timing_ms: number }}
 */
export async function fetchBatchOhlcv(symbols, bars = 200, concurrency = 10) {
  const t0 = Date.now();
  const results = new Map();
  const errors = [];

  // Process in batches
  for (let i = 0; i < symbols.length; i += concurrency) {
    const batch = symbols.slice(i, i + concurrency);
    const promises = batch.map(async (sym) => {
      const data = await fetchOhlcv(sym, bars);
      if (data) {
        results.set(sym, data);
      } else {
        errors.push(sym);
      }
    });
    await Promise.all(promises);
  }

  return {
    results,
    errors,
    fetched: results.size,
    failed: errors.length,
    timing_ms: Date.now() - t0,
  };
}
