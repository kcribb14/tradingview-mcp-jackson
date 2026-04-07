/**
 * Yahoo Finance deep history — gets 30+ years of daily bars by paginating
 * with explicit period1/period2 in 10-year chunks.
 *
 * Yahoo's range=max with interval=1d returns monthly data for old dates.
 * But period1/period2 with interval=1d returns actual daily bars.
 *
 * AAPL: 9,132 bars (1990-2026, 36 years) — completely free.
 */

const CHUNK_YEARS = 10;

async function fetchChunk(ticker, period1, period2) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&period1=${period1}&period2=${period2}&includePrePost=false`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) return [];
    const d = await r.json();
    const result = d?.chart?.result?.[0];
    if (!result?.timestamp) return [];
    const q = result.indicators.quote[0];
    const bars = [];
    for (let i = 0; i < result.timestamp.length; i++) {
      if (q.close[i] != null && q.open[i] != null) {
        bars.push({
          time: result.timestamp[i],
          open: q.open[i], high: q.high[i], low: q.low[i],
          close: q.close[i], volume: q.volume[i] || 0
        });
      }
    }
    return bars;
  } catch { return []; }
}

/**
 * Fetch maximum daily history for a ticker by paginating in 10-year chunks.
 * @param {string} ticker - Yahoo ticker (e.g. "AAPL", "BHP.AX", "GC=F")
 * @param {number} startYear - How far back to go (default: 1985)
 * @returns {Array} OHLCV bars sorted by time
 */
export async function getDeepHistory(ticker, startYear = 1985) {
  const allBars = [];
  const seen = new Set();
  const now = Math.floor(Date.now() / 1000);

  // Generate 10-year chunks from startYear to present
  for (let year = startYear; year < new Date().getFullYear(); year += CHUNK_YEARS) {
    const p1 = Math.floor(new Date(year, 0, 1).getTime() / 1000);
    const p2 = Math.min(Math.floor(new Date(year + CHUNK_YEARS, 0, 1).getTime() / 1000), now);

    const bars = await fetchChunk(ticker, p1, p2);
    for (const b of bars) {
      if (!seen.has(b.time)) {
        seen.add(b.time);
        allBars.push(b);
      }
    }

    // Rate limit — be polite to Yahoo
    await new Promise(r => setTimeout(r, 300));
  }

  allBars.sort((a, b) => a.time - b.time);
  return allBars;
}

export function isAvailable() { return true; } // No key needed
