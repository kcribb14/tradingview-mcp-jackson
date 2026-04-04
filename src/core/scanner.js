/**
 * Bulk scanner engine.
 * Reads multiple screener views, merges data, computes custom scores.
 * No chart switching required — operates entirely on screener data.
 */
import * as screener from './screener.js';

// ─── Value Parser ──────────────────────────────────────────────────────────

const SUFFIXES = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

const RATING_MAP = {
  'strong buy': 5, 'buy': 4, 'neutral': 3, 'sell': 2, 'strong sell': 1, 'no rating': 0,
};

const TECH_RATING_MAP = {
  'strong buy': 5, 'buy': 4, 'neutral': 3, 'sell': 2, 'strong sell': 1,
};

/**
 * Parse any TradingView screener string into a number.
 * Handles: "4.31 T USD", "+66.75%", "−0.15%", "Strong buy", "143.14 M", "36.19", "—"
 */
export function parseValue(str) {
  if (str == null || str === '' || str === '—' || str === '—' || str === 'N/A') return null;

  const s = String(str).trim();

  // Rating strings
  const lower = s.toLowerCase();
  if (RATING_MAP[lower] !== undefined) return RATING_MAP[lower];
  if (TECH_RATING_MAP[lower] !== undefined) return TECH_RATING_MAP[lower];

  // Non-numeric strings (sectors, patterns, etc.) — return as-is
  if (!/[\d]/.test(s)) return s;

  // Strip currency labels (USD, AUD, EUR, etc.)
  let cleaned = s.replace(/\s*(USD|AUD|EUR|GBP|JPY|CAD|CHF|CNY|HKD|SGD|INR)\s*/gi, '').trim();

  // Handle percentage sign
  const isPct = cleaned.includes('%');
  cleaned = cleaned.replace(/%/g, '').trim();

  // Handle unicode minus (−) and regular minus
  cleaned = cleaned.replace(/−/g, '-');

  // Handle plus sign
  cleaned = cleaned.replace(/^\+/, '');

  // Handle suffix multipliers (K, M, B, T)
  const suffixMatch = cleaned.match(/^([0-9,.\-]+)\s*([KMBT])$/i);
  if (suffixMatch) {
    const num = parseFloat(suffixMatch[1].replace(/,/g, ''));
    const mult = SUFFIXES[suffixMatch[2].toUpperCase()];
    return isNaN(num) ? null : num * mult;
  }

  // Handle comma-separated numbers
  cleaned = cleaned.replace(/,/g, '');

  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// ─── Multi-View Reader ─────────────────────────────────────────────────────

/**
 * Read a specific screener view via the screener CDP target.
 * Switches view tab and reads all rows.
 */
async function readView(viewName, maxRows = 100) {
  const { evalInScreener } = await getScreenerEval();

  // Click the view tab
  await evalInScreener(`
    (function() {
      document.querySelectorAll('button').forEach(function(b) {
        if ((b.textContent || '').trim().includes('${viewName}')) b.click();
      });
    })()
  `);
  await new Promise(r => setTimeout(r, 1500));

  // Read the table
  return evalInScreener(`
    (function() {
      var maxRows = ${maxRows};
      var tables = document.querySelectorAll('table');
      var table = null;
      for (var i = 0; i < tables.length; i++) {
        if (tables[i].querySelectorAll('th').length > 2) { table = tables[i]; break; }
      }
      if (!table) return { error: 'no table' };
      var headers = [];
      table.querySelectorAll('th').forEach(function(th) { var t = th.textContent.trim(); if (t) headers.push(t); });
      var rows = [];
      var trs = table.querySelectorAll('tbody tr');
      for (var j = 0; j < Math.min(maxRows, trs.length); j++) {
        var cells = [];
        trs[j].querySelectorAll('td').forEach(function(td, idx) {
          if (idx === 0) {
            var ticker = td.querySelector('a[class*="tickerNameBox"]');
            cells.push(ticker ? ticker.textContent.trim() : td.textContent.trim());
          } else cells.push(td.textContent.trim());
        });
        var row = {};
        for (var k = 0; k < headers.length && k < cells.length; k++) row[headers[k]] = cells[k];
        if (Object.keys(row).length > 0) rows.push(row);
      }
      return { view: '${viewName}', headers: headers, rows: rows };
    })()
  `);
}

/**
 * Helper: get evalInScreener function from screener module.
 * We import it dynamically to avoid circular dependency issues.
 */
async function getScreenerEval() {
  const CDP = (await import('chrome-remote-interface')).default;
  const resp = await fetch('http://localhost:9222/json/list');
  const targets = await resp.json();
  const target = targets.find(t => t.type === 'page' && /screener/i.test(t.url));
  if (!target) throw new Error('Screener target not found. Is the screener panel open?');

  return {
    evalInScreener: async (expr) => {
      const c = await CDP({ host: 'localhost', port: 9222, target: target.id });
      await c.Runtime.enable();
      try {
        const r = await c.Runtime.evaluate({ expression: expr, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
        return r.result?.value;
      } finally {
        try { await c.close(); } catch {}
      }
    }
  };
}

/**
 * Read multiple screener views and merge into one rich dataset.
 * Each stock gets fields from ALL views merged into a single object.
 *
 * @param {string[]} views - Views to read (default: Overview + Technicals + Performance + Valuation)
 * @param {number} maxRows - Max rows per view
 * @returns {object[]} Array of merged stock objects with parsed numeric values
 */
export async function readMultiView({ views, maxRows = 100 } = {}) {
  const viewList = views || ['Overview', 'Technicals', 'Performance', 'Valuation'];
  const datasets = {};

  for (const view of viewList) {
    const data = await readView(view, maxRows);
    if (data?.error) throw new Error(`Failed to read ${view}: ${data.error}`);
    datasets[view] = data;
  }

  // Merge all datasets on Symbol
  const merged = new Map();

  for (const [viewName, data] of Object.entries(datasets)) {
    for (const row of data.rows) {
      const sym = row.Symbol;
      if (!sym) continue;
      if (!merged.has(sym)) merged.set(sym, { Symbol: sym, _raw: {} });
      const stock = merged.get(sym);
      for (const [key, val] of Object.entries(row)) {
        if (key === 'Symbol') continue;
        // Only overwrite if the field doesn't exist yet or is the same value
        if (stock._raw[key] === undefined || stock._raw[key] === val) {
          stock._raw[key] = val;
          stock[key] = parseValue(val);
        } else {
          // Different value from a different view — store both
          const viewKey = `${key} (${viewName})`;
          stock._raw[viewKey] = val;
          stock[viewKey] = parseValue(val);
        }
      }
    }
  }

  return Array.from(merged.values());
}

// ─── Scoring Functions ─────────────────────────────────────────────────────

/** Get field value from stock, handling nbsp in keys. */
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

/** Normalize a value to 0-1 range given min/max bounds. Clamps to [0, 1]. */
function norm(val, min, max) {
  if (val == null) return 0.5; // neutral for missing data
  return Math.max(0, Math.min(1, (val - min) / (max - min)));
}

/** Invert: high input = low score */
function invNorm(val, min, max) {
  return 1 - norm(val, min, max);
}

/**
 * Momentum Score (0-100).
 * Inputs: Change %, Perf %1W, Perf %1M, Perf %3M, RSI (14), Mom (10), Tech Rating
 */
export function scoreMomentum(stock) {
  const change1d = f(stock, 'Change %');
  const perf1w = f(stock, 'Perf %1W');
  const perf1m = f(stock, 'Perf %1M');
  const perf3m = f(stock, 'Perf %3M');
  const rsi = f(stock, 'RSI (14)');
  const mom = f(stock, 'Mom (10)');
  const techRating = f(stock, 'Tech Rating');

  // RSI score: 50 = neutral, >70 = high momentum, <30 = low
  const rsiScore = rsi != null ? norm(rsi, 20, 80) : 0.5;

  // Multi-TF momentum alignment (all positive = strong)
  const tfScores = [change1d, perf1w, perf1m, perf3m].map(v =>
    v != null ? norm(v, -10, 10) : 0.5
  );
  const tfAvg = tfScores.reduce((a, b) => a + b, 0) / tfScores.length;

  // Momentum indicator
  const momScore = mom != null ? norm(mom, -20, 20) : 0.5;

  // Tech rating composite
  const techScore = techRating != null ? norm(techRating, 1, 5) : 0.5;

  const raw = 0.15 * norm(change1d, -5, 5) +
              0.25 * tfAvg +
              0.25 * rsiScore +
              0.15 * momScore +
              0.20 * techScore;

  return Math.round(raw * 100);
}

/**
 * Value Score (0-100).
 * Lower P/E, higher growth, strong quality = higher score.
 */
export function scoreValue(stock) {
  const pe = f(stock, 'P/E');
  const peg = f(stock, 'PEGTTM');
  const pb = f(stock, 'P/B');
  const evEbitda = f(stock, 'EV / EBITDATTM');
  const epsGrowth = f(stock, 'EPS dil growthTTM YoY');
  const divYield = f(stock, 'Div yield %TTM');
  const roe = f(stock, 'ROETTM');
  const netMargin = f(stock, 'Net marginTTM');
  const analystRating = f(stock, 'Analyst Rating');

  // Lower P/E is better (but not negative)
  const peScore = pe != null && pe > 0 ? invNorm(pe, 5, 60) : 0.3;

  // Lower PEG is better
  const pegScore = peg != null && peg > 0 ? invNorm(peg, 0, 3) : 0.3;

  // Lower P/B is better
  const pbScore = pb != null && pb > 0 ? invNorm(pb, 0.5, 15) : 0.3;

  // Lower EV/EBITDA is better
  const evScore = evEbitda != null && evEbitda > 0 ? invNorm(evEbitda, 5, 40) : 0.3;

  // Higher EPS growth is better
  const growthScore = epsGrowth != null ? norm(epsGrowth, -20, 50) : 0.3;

  // Quality factors
  const roeScore = roe != null ? norm(roe, 0, 40) : 0.3;
  const marginScore = netMargin != null ? norm(netMargin, 0, 30) : 0.3;

  // Analyst sentiment
  const analystScore = analystRating != null ? norm(analystRating, 1, 5) : 0.5;

  const raw = 0.20 * peScore +
              0.10 * pegScore +
              0.10 * pbScore +
              0.10 * evScore +
              0.15 * growthScore +
              0.10 * roeScore +
              0.10 * marginScore +
              0.15 * analystScore;

  return Math.round(raw * 100);
}

/**
 * Trend Strength Score (0-100).
 * Uses MA Rating, multi-TF alignment, and volatility.
 */
export function scoreTrend(stock) {
  const maRating = f(stock, 'MA Rating');
  const techRating = f(stock, 'Tech Rating');
  const perf1w = f(stock, 'Perf %1W');
  const perf1m = f(stock, 'Perf %1M');
  const perf3m = f(stock, 'Perf %3M');
  const vol1m = f(stock, 'Volatility1M');

  // MA rating as trend proxy
  const maScore = maRating != null ? norm(maRating, 1, 5) : 0.5;

  // Multi-timeframe alignment: all positive and increasing = strong uptrend
  const tfs = [perf1w, perf1m, perf3m].filter(v => v != null);
  let alignScore = 0.5;
  if (tfs.length >= 2) {
    const allPositive = tfs.every(v => v > 0);
    const increasing = tfs.length >= 3 && tfs[0] > 0 && tfs[2] > tfs[1]; // acceleration
    alignScore = allPositive ? (increasing ? 0.9 : 0.7) : (tfs.every(v => v < 0) ? 0.1 : 0.4);
  }

  // Lower volatility = cleaner trend
  const volScore = vol1m != null ? invNorm(vol1m, 0.5, 5) : 0.5;

  const raw = 0.35 * maScore +
              0.30 * alignScore +
              0.15 * volScore +
              0.20 * (techRating != null ? norm(techRating, 1, 5) : 0.5);

  return Math.round(raw * 100);
}

/**
 * Volume Anomaly Score (0-100).
 * High relative volume + price movement = actionable.
 */
export function scoreVolumeAnomaly(stock) {
  const relVol = f(stock, 'Rel Volume');
  const change = f(stock, 'Change %');

  if (relVol == null) return 50;

  // Rel Volume score: >2 is unusual, >5 is extreme
  const relVolScore = norm(relVol, 0.5, 5);

  // Price movement magnitude (direction doesn't matter for anomaly)
  const moveScore = change != null ? norm(Math.abs(change), 0, 5) : 0.3;

  // Volume + movement combined = anomaly
  const raw = 0.65 * relVolScore + 0.35 * moveScore;

  return Math.round(raw * 100);
}

/**
 * Composite Score (0-100).
 * Weighted combination of all sub-scores.
 */
export function compositeScore(stock, weights = {}) {
  const w = {
    momentum: weights.momentum ?? 0.30,
    value: weights.value ?? 0.25,
    trend: weights.trend ?? 0.25,
    volume: weights.volume ?? 0.20,
  };

  const momentum = scoreMomentum(stock);
  const value = scoreValue(stock);
  const trend = scoreTrend(stock);
  const volume = scoreVolumeAnomaly(stock);

  const composite = Math.round(
    w.momentum * momentum +
    w.value * value +
    w.trend * trend +
    w.volume * volume
  );

  return {
    composite,
    momentum,
    value,
    trend,
    volume,
  };
}

// ─── Bulk Scan Pipeline ────────────────────────────────────────────────────

/**
 * Presets for common scan types.
 */
const PRESETS = {
  momentum: { momentum: 0.50, value: 0.10, trend: 0.30, volume: 0.10, sort: 'momentum' },
  value: { momentum: 0.10, value: 0.50, trend: 0.15, volume: 0.25, sort: 'value' },
  trend: { momentum: 0.20, value: 0.10, trend: 0.50, volume: 0.20, sort: 'trend' },
  volume_anomaly: { momentum: 0.15, value: 0.05, trend: 0.15, volume: 0.65, sort: 'volume' },
  balanced: { momentum: 0.30, value: 0.25, trend: 0.25, volume: 0.20, sort: 'composite' },
};

/**
 * Run a bulk scan: read screener views, compute scores, rank results.
 *
 * @param {object} opts
 * @param {string} opts.preset - Scan preset: "momentum", "value", "trend", "volume_anomaly", "balanced"
 * @param {object} opts.weights - Custom weights (overrides preset)
 * @param {number} opts.top - Return top N results (default 20)
 * @param {number} opts.max_rows - Max rows per view (default 100)
 * @param {string[]} opts.views - Views to read (default: Overview + Technicals + Performance + Valuation)
 */
export async function bulkScan({ preset = 'balanced', weights: customWeights, top = 20, max_rows = 100, views } = {}) {
  const t0 = Date.now();

  // Resolve weights
  const presetConfig = PRESETS[preset] || PRESETS.balanced;
  const weights = customWeights || {
    momentum: presetConfig.momentum,
    value: presetConfig.value,
    trend: presetConfig.trend,
    volume: presetConfig.volume,
  };
  const sortKey = customWeights ? 'composite' : presetConfig.sort;

  // Read multi-view data
  const stocks = await readMultiView({ views, maxRows: max_rows });
  const readTime = Date.now() - t0;

  // Helper: safely get a parsed numeric value from a stock by key.
  // TradingView uses \xa0 (non-breaking space) in some column names.
  const g = (s, key) => {
    // Try exact key first
    let v = s[key];
    if (v === undefined) {
      // Try with nbsp variants
      const nbspKey = key.replace(/ /g, '\xa0');
      v = s[nbspKey];
    }
    if (v === undefined) {
      // Fuzzy match: normalize all spaces in keys
      const normKey = key.replace(/\s+/g, ' ');
      for (const k of Object.keys(s)) {
        if (k.replace(/[\s\xa0]+/g, ' ') === normKey) { v = s[k]; break; }
      }
    }
    return (v !== undefined && v !== null && typeof v !== 'string') ? v : null;
  };

  // Score each stock
  const scored = stocks.map(stock => {
    const scores = compositeScore(stock, weights);
    return {
      symbol: stock.Symbol,
      composite: scores.composite,
      momentum: scores.momentum,
      value: scores.value,
      trend: scores.trend,
      volume: scores.volume,
      // Key raw data — use helper to safely extract fields with special chars
      price: g(stock, 'Price'),
      change_pct: g(stock, 'Change %'),
      market_cap: g(stock, 'Market cap'),
      rsi: g(stock, 'RSI (14)'),
      pe: g(stock, 'P/E'),
      analyst_rating: stock._raw?.['Analyst Rating'] ?? null,
      sector: stock._raw?.['Sector'] ?? null,
      rel_volume: g(stock, 'Rel Volume'),
      perf_1w: g(stock, 'Perf %1W'),
      perf_1m: g(stock, 'Perf %1M'),
      perf_3m: g(stock, 'Perf %3M'),
      volatility_1m: g(stock, 'Volatility1M'),
      tech_rating: stock._raw?.['Tech Rating'] ?? null,
      ma_rating: stock._raw?.['MA Rating'] ?? null,
      roe: g(stock, 'ROETTM'),
      peg: g(stock, 'PEGTTM'),
    };
  });

  // Sort by the chosen score
  scored.sort((a, b) => b[sortKey] - a[sortKey]);

  const totalTime = Date.now() - t0;

  return {
    success: true,
    preset,
    weights,
    sort_by: sortKey,
    stocks_scanned: scored.length,
    top_n: Math.min(top, scored.length),
    read_time_ms: readTime,
    total_time_ms: totalTime,
    results: scored.slice(0, top),
  };
}
