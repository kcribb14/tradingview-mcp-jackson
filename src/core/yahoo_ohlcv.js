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

  // Common suffix mappings for non-US exchanges
  // ASX: BHP → BHP.AX
  // LSE: SHEL → SHEL.L
  // TSX: SHOP → SHOP.TO
  // Crypto: BTCUSD → BTC-USD
  if (sym.match(/^(BTC|ETH|SOL|XRP|DOGE|ADA|DOT|AVAX|LINK|MATIC)/i) && sym.endsWith('USD')) {
    return sym.slice(0, -3) + '-USD';
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

  // Calculate range from bar count
  let range = '1y';
  if (bars <= 5) range = '5d';
  else if (bars <= 30) range = '1mo';
  else if (bars <= 90) range = '3mo';
  else if (bars <= 180) range = '6mo';
  else if (bars <= 365) range = '1y';
  else range = '2y';

  const url = `${BASE_URL}/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}&includePrePost=false`;

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

    // Trim to requested bar count
    const trimmed = ohlcvBars.slice(-bars);

    return {
      bars: trimmed,
      symbol,
      yahoo_ticker: ticker,
      currency: chart.meta?.currency || 'USD',
      exchange: chart.meta?.exchangeName || null,
      bar_count: trimmed.length,
    };
  } catch {
    return null;
  }
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
