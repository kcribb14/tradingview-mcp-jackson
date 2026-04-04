/**
 * Fast Fear & Greed Scanner — pure data pipeline, zero visual steps.
 *
 * Two scan modes:
 *   quick   — screener-only, 100 stocks scored in <8s, no chart interaction
 *   fg-fast — screener proxy + Pine batch for real F&G on top candidates in <25s
 *
 * NO screenshots, NO drawings, NO chart rendering waits.
 */
import * as pine from './pine.js';
import * as data from './data.js';
import { parseValue, readMultiView } from './scanner.js';
import { classifyZone, proxyFearGreed } from './fg_scanner.js';

// ─── Field accessor (handles \xa0 non-breaking spaces) ─────────────────────

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

// ─── QUICK SCAN: Screener-only, no chart ────────────────────────────────────

/**
 * Pure screener scan with proxy F&G scoring.
 * Reads 3 screener views, merges, scores, ranks.
 * Target: <8 seconds for 100 stocks.
 *
 * @param {number} universe - Stocks to scan (default 100)
 * @param {number} top - Return top N per category (default 20)
 * @param {string} sort - Sort by: 'fear', 'greed', 'momentum', 'composite' (default 'fear')
 */
export async function quickScan({ universe = 100, top = 20, sort = 'fear' } = {}) {
  const t0 = Date.now();

  // Read 3 screener views in sequence (each ~2s)
  const stocks = await readMultiView({
    views: ['Overview', 'Technicals', 'Performance'],
    maxRows: universe,
  });
  const readTime = Date.now() - t0;

  // Score every stock
  const scored = stocks.map(stock => {
    const fg = proxyFearGreed(stock);
    return {
      symbol: stock.Symbol,
      proxy_fg: fg.proxy_fg,
      zone: fg.zone,
      severity: fg.severity,
      components: fg.components,
      price: f(stock, 'Price'),
      change_pct: f(stock, 'Change %'),
      rel_volume: f(stock, 'Rel Volume'),
      rsi: f(stock, 'RSI (14)'),
      ma_rating: f(stock, 'MA Rating'),
      tech_rating: f(stock, 'Tech Rating'),
      perf_1w: f(stock, 'Perf %1W'),
      perf_1m: f(stock, 'Perf %1M'),
      perf_3m: f(stock, 'Perf %3M'),
      volatility: f(stock, 'Volatility1W'),
      market_cap: stock._raw?.['Market cap'] ?? null,
      pe: f(stock, 'P/E'),
      sector: stock._raw?.['Sector'] ?? null,
      analyst_rating: stock._raw?.['Analyst Rating'] ?? null,
    };
  });

  // Sort options
  const byFear = [...scored].sort((a, b) => a.proxy_fg - b.proxy_fg);
  const byGreed = [...scored].sort((a, b) => b.proxy_fg - a.proxy_fg);

  let sorted;
  switch (sort) {
    case 'greed': sorted = byGreed; break;
    case 'momentum': sorted = [...scored].sort((a, b) => (b.perf_1m ?? 0) - (a.perf_1m ?? 0)); break;
    case 'composite': sorted = [...scored].sort((a, b) => Math.abs(b.proxy_fg) - Math.abs(a.proxy_fg)); break;
    default: sorted = byFear; break;
  }

  const totalTime = Date.now() - t0;

  return {
    success: true,
    scan_type: 'quick',
    timing: {
      read_ms: readTime,
      total_ms: totalTime,
      total_readable: (totalTime / 1000).toFixed(1) + 's',
    },
    stocks_scanned: scored.length,
    sort_by: sort,
    top_n: Math.min(top, sorted.length),
    results: sorted.slice(0, top),
    fear_opportunities: byFear.filter(s => s.severity <= -1).slice(0, 10),
    greed_warnings: byGreed.filter(s => s.severity >= 1).slice(0, 10),
    distribution: {
      extreme_fear: scored.filter(s => s.severity === -2).length,
      fear: scored.filter(s => s.severity === -1).length,
      neutral: scored.filter(s => s.severity === 0).length,
      greed: scored.filter(s => s.severity === 1).length,
      extreme_greed: scored.filter(s => s.severity === 2).length,
    },
  };
}

// ─── PINE BATCH: Generate request.security() scanner ────────────────────────

/**
 * Generate Pine Script that batch-reads F&G components for multiple symbols
 * using request.security(). Outputs results to a table.
 *
 * Pine request.security() limit: 40 calls per script.
 * We use 1 call per symbol (fetching close), so max ~38 symbols (leaving margin).
 */
function generateBatchPine(symbols) {
  const maxSymbols = Math.min(symbols.length, 38);
  const syms = symbols.slice(0, maxSymbols);

  // For each symbol we need: close, EMA(50), RSI(14), volume, avg volume
  // We'll compute a composite F&G proxy from these in Pine
  // request.security calls + ta.change() must run on every bar (global scope)
  const securityCalls = syms.map((sym, i) => {
    return `
// ${sym}
[c${i}, e${i}, r${i}, v${i}, av${i}] = request.security("${sym}", timeframe.period, [close, ta.ema(close, 50), ta.rsi(close, 14), volume, ta.sma(volume, 20)])
float chg${i} = ta.change(c${i})`;
  }).join('\n');

  // F&G computation uses pre-computed chg values (no ta.* inside conditional)
  const tableRows = syms.map((sym, i) => {
    return `
    // ${sym} - compute F&G components
    float pmacd${i} = e${i} > 0 ? (c${i} / e${i} - 1) * 100 : 0
    float mf${i} = av${i} > 0 ? (v${i} / av${i} - 1) * math.sign(nz(chg${i})) * 15 : 0
    float rsiComp${i} = (r${i} - 50) * 0.6
    float fg${i} = math.max(-60, math.min(60, (pmacd${i} * 0.35 + rsiComp${i} * 0.35 + mf${i} * 0.3)))
    table.cell(t, 0, ${i}, "${sym}")
    table.cell(t, 1, ${i}, str.tostring(math.round(fg${i} * 100) / 100))
    table.cell(t, 2, ${i}, str.tostring(math.round(r${i} * 100) / 100))
    table.cell(t, 3, ${i}, str.tostring(math.round(c${i} * 100) / 100))
    table.cell(t, 4, ${i}, str.tostring(math.round(pmacd${i} * 100) / 100))
    table.cell(t, 5, ${i}, str.tostring(math.round(mf${i} * 100) / 100))`;
  }).join('\n');

  return `//@version=6
indicator("FG Scanner Batch", overlay=true)

${securityCalls}

var t = table.new(position.bottom_right, 6, ${syms.length}, bgcolor=color.new(color.black, 80))

if barstate.islast
${tableRows}
`;
}

/**
 * Parse the Pine table output back into structured F&G scores.
 */
function parseBatchTable(tableData) {
  const results = [];
  if (!tableData?.studies) return results;

  for (const study of tableData.studies) {
    if (!study.name?.includes('FG Scanner Batch')) continue;
    for (const table of study.tables || []) {
      for (const rowStr of table.rows || []) {
        const cells = rowStr.split(' | ').map(s => s.trim());
        if (cells.length >= 4) {
          const symbol = cells[0];
          const fg = parseFloat(cells[1]);
          const rsi = parseFloat(cells[2]);
          const price = parseFloat(cells[3]);
          const pmacd = cells[4] ? parseFloat(cells[4]) : null;
          const mf = cells[5] ? parseFloat(cells[5]) : null;
          if (symbol && !isNaN(fg)) {
            results.push({
              symbol,
              pine_fg: fg,
              pine_rsi: isNaN(rsi) ? null : rsi,
              pine_price: isNaN(price) ? null : price,
              pine_pmacd: isNaN(pmacd) ? null : pmacd,
              pine_mf: isNaN(mf) ? null : mf,
              ...classifyZone(fg),
            });
          }
        }
      }
    }
  }
  return results;
}

// ─── FG-FAST: Screener + Pine batch ─────────────────────────────────────────

/**
 * Fast F&G scan: screener proxy for universe, Pine batch for top candidates.
 * Target: 100 stocks scanned + 38 deep-scored in <25 seconds.
 *
 * @param {number} universe - Stocks for Tier 1 screener proxy (default 100)
 * @param {number} deep - Stocks for Tier 2 Pine batch (default 38)
 * @param {number} pine_wait_ms - Ms to wait for Pine calculation (default 4000)
 */
export async function fgFastScan({ universe = 100, deep = 38, pine_wait_ms = 4000 } = {}) {
  const t0 = Date.now();

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 1: SCREENER PROXY (~6s)
  // ═══════════════════════════════════════════════════════════════════════════

  const stocks = await readMultiView({
    views: ['Overview', 'Technicals', 'Performance'],
    maxRows: universe,
  });
  const tier1Time = Date.now() - t0;

  const tier1Results = stocks.map(stock => {
    const fg = proxyFearGreed(stock);
    return {
      symbol: stock.Symbol,
      proxy_fg: fg.proxy_fg,
      zone: fg.zone,
      severity: fg.severity,
      components: fg.components,
      price: f(stock, 'Price'),
      change_pct: f(stock, 'Change %'),
      rel_volume: f(stock, 'Rel Volume'),
      rsi: f(stock, 'RSI (14)'),
      perf_1m: f(stock, 'Perf %1M'),
      volatility: f(stock, 'Volatility1W'),
      market_cap: stock._raw?.['Market cap'] ?? null,
      sector: stock._raw?.['Sector'] ?? null,
      analyst_rating: stock._raw?.['Analyst Rating'] ?? null,
    };
  });

  // Rank by proxy F&G
  const byFear = [...tier1Results].sort((a, b) => a.proxy_fg - b.proxy_fg);
  const byGreed = [...tier1Results].sort((a, b) => b.proxy_fg - a.proxy_fg);

  // Select candidates for Pine batch: half most fearful, half most greedy
  const halfDeep = Math.ceil(deep / 2);
  const fearCandidates = byFear.slice(0, halfDeep);
  const greedCandidates = byGreed.slice(0, deep - halfDeep);

  // Deduplicate (a stock could appear in both if universe is small)
  const seen = new Set();
  const candidates = [];
  for (const c of [...fearCandidates, ...greedCandidates]) {
    if (!seen.has(c.symbol)) {
      seen.add(c.symbol);
      candidates.push(c);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 2: PINE BATCH (~15s)
  // ═══════════════════════════════════════════════════════════════════════════

  const tier2Start = Date.now();
  let pineResults = [];
  let pineError = null;

  try {
    // Generate and inject Pine Script
    const pineCode = generateBatchPine(candidates.map(c => c.symbol));
    await pine.setSource({ source: pineCode });
    const compileResult = await pine.smartCompile();

    if (compileResult.has_errors) {
      // Check for actual errors
      const errors = await pine.getErrors();
      pineError = `Compile errors: ${JSON.stringify(errors.errors?.slice(0, 3))}`;
    } else {
      // Wait for Pine to calculate across all symbols
      await new Promise(r => setTimeout(r, pine_wait_ms));

      // Read the output table
      const tableData = await data.getPineTables({ study_filter: 'FG Scanner Batch' });
      pineResults = parseBatchTable(tableData);
    }
  } catch (err) {
    pineError = err.message;
  }

  const tier2Time = Date.now() - tier2Start;

  // ═══════════════════════════════════════════════════════════════════════════
  // MERGE RESULTS
  // ═══════════════════════════════════════════════════════════════════════════

  // Create a lookup from Pine results
  const pineLookup = new Map();
  for (const pr of pineResults) {
    pineLookup.set(pr.symbol, pr);
  }

  // Merge Pine scores with proxy scores
  const merged = candidates.map(c => {
    const pr = pineLookup.get(c.symbol);
    const result = { ...c };
    if (pr) {
      result.pine_fg = pr.pine_fg;
      result.pine_zone = pr.zone;
      result.pine_severity = pr.severity;
      result.pine_rsi = pr.pine_rsi;
      result.pine_price = pr.pine_price;
      result.pine_pmacd = pr.pine_pmacd;
      result.pine_mf = pr.pine_mf;
      result.proxy_error = Math.round(Math.abs(c.proxy_fg - pr.pine_fg) * 100) / 100;
      // Use Pine F&G as the authoritative score when available
      result.final_fg = pr.pine_fg;
      result.final_zone = pr.zone;
      result.final_severity = pr.severity;
    } else {
      // Fall back to proxy
      result.final_fg = c.proxy_fg;
      result.final_zone = c.zone;
      result.final_severity = c.severity;
    }
    return result;
  });

  // Sort merged by final F&G
  const mergedRanked = [...merged].sort((a, b) => a.final_fg - b.final_fg);

  // Compute proxy accuracy for stocks that have both scores
  const withBoth = merged.filter(r => r.pine_fg != null);
  const avgError = withBoth.length > 0
    ? Math.round(withBoth.reduce((s, r) => s + r.proxy_error, 0) / withBoth.length * 100) / 100
    : null;

  const totalTime = Date.now() - t0;

  return {
    success: true,
    scan_type: 'fg-fast',
    timing: {
      tier1_ms: tier1Time,
      tier2_ms: tier2Time,
      total_ms: totalTime,
      total_readable: (totalTime / 1000).toFixed(1) + 's',
    },
    tier1: {
      stocks_scanned: tier1Results.length,
      top_fear: byFear.slice(0, 10).map(r => ({
        symbol: r.symbol, proxy_fg: r.proxy_fg, zone: r.zone,
        price: r.price, change_pct: r.change_pct, rsi: r.rsi,
        sector: r.sector,
      })),
      top_greed: byGreed.slice(0, 10).map(r => ({
        symbol: r.symbol, proxy_fg: r.proxy_fg, zone: r.zone,
        price: r.price, change_pct: r.change_pct, rsi: r.rsi,
        sector: r.sector,
      })),
    },
    tier2: {
      deep_scanned: candidates.length,
      pine_scores_read: pineResults.length,
      pine_error: pineError,
      proxy_accuracy: {
        avg_error: avgError,
        samples: withBoth.length,
      },
      fear_opportunities: mergedRanked.filter(r => r.final_severity <= -1).map(r => ({
        symbol: r.symbol, proxy_fg: r.proxy_fg, pine_fg: r.pine_fg ?? null,
        final_fg: r.final_fg, zone: r.final_zone,
        proxy_error: r.proxy_error ?? null,
        price: r.price, rsi: r.rsi ?? r.pine_rsi ?? null,
        sector: r.sector,
      })),
      greed_warnings: mergedRanked.filter(r => r.final_severity >= 1).map(r => ({
        symbol: r.symbol, proxy_fg: r.proxy_fg, pine_fg: r.pine_fg ?? null,
        final_fg: r.final_fg, zone: r.final_zone,
        proxy_error: r.proxy_error ?? null,
        price: r.price, rsi: r.rsi ?? r.pine_rsi ?? null,
        sector: r.sector,
      })),
      momentum_shifts: mergedRanked.filter(r =>
        r.final_fg > -5 && r.proxy_fg < -15
      ).map(r => ({
        symbol: r.symbol, proxy_fg: r.proxy_fg, pine_fg: r.pine_fg ?? null,
        final_fg: r.final_fg, shift: Math.round((r.final_fg - r.proxy_fg) * 100) / 100,
        price: r.price,
      })),
      full_ranking: mergedRanked.map(r => ({
        symbol: r.symbol, proxy_fg: r.proxy_fg, pine_fg: r.pine_fg ?? null,
        final_fg: r.final_fg, zone: r.final_zone,
        proxy_error: r.proxy_error ?? null,
        price: r.price,
      })),
    },
    distribution: {
      extreme_fear: tier1Results.filter(s => s.severity === -2).length,
      fear: tier1Results.filter(s => s.severity === -1).length,
      neutral: tier1Results.filter(s => s.severity === 0).length,
      greed: tier1Results.filter(s => s.severity === 1).length,
      extreme_greed: tier1Results.filter(s => s.severity === 2).length,
    },
  };
}
