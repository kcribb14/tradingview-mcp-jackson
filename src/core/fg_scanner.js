/**
 * Fear & Greed Scanner Pipeline.
 * Combines screener pre-filtering with per-symbol F&G indicator reads.
 *
 * Architecture:
 * 1. screener_read → get universe of 100 liquid stocks
 * 2. Sort/filter by volume anomaly → narrow to top N candidates
 * 3. For each candidate: chart_set_symbol → wait → data_get_study_values → extract F&G
 * 4. Score and rank by F&G zone + fundamentals + volume anomaly
 */
import * as chart from './chart.js';
import * as data from './data.js';
import { parseValue, readMultiView } from './scanner.js';

// ─── F&G Zone Classification ───────────────────────────────────────────────

/**
 * Classify F&G score into zone.
 */
export function classifyZone(score) {
  if (score == null) return { zone: 'UNKNOWN', severity: 0 };
  if (score >= 41) return { zone: 'EXTREME GREED', severity: 2 };
  if (score >= 10) return { zone: 'GREED', severity: 1 };
  if (score >= -10) return { zone: 'NEUTRAL', severity: 0 };
  if (score >= -25) return { zone: 'FEAR', severity: -1 };
  return { zone: 'EXTREME FEAR', severity: -2 };
}

// ─── F&G Value Reader ──────────────────────────────────────────────────────

/**
 * Read the F&G indicator value from the current chart.
 * Requires the F&G indicator to be loaded on the chart.
 *
 * @param {number} waitMs - ms to wait after symbol switch for indicator to recalculate
 * @returns {{ fg_score: number, zone: string, severity: number }} | null
 */
export async function readFGValue(waitMs = 2000) {
  await new Promise(r => setTimeout(r, waitMs));
  const values = await data.getStudyValues();

  // Find the F&G study
  const fgStudy = values.studies.find(s =>
    s.name.includes('Fear') || s.name.includes('F&G') || s.name.includes('Greed')
  );
  if (!fgStudy) return null;

  // Extract the F&G Index value
  const fgKey = Object.keys(fgStudy.values).find(k =>
    k.includes('Index') || k.includes('F&G')
  );
  if (!fgKey) return null;

  const rawVal = fgStudy.values[fgKey];
  const fg_score = parseValue(rawVal);
  if (fg_score == null) return null;

  const { zone, severity } = classifyZone(fg_score);
  return { fg_score, zone, severity };
}

// ─── Deep Scan Pipeline ────────────────────────────────────────────────────

/**
 * Run the full F&G scanner pipeline.
 *
 * @param {object} opts
 * @param {number} opts.max_candidates - Max symbols to deep-scan (default 30)
 * @param {number} opts.wait_ms - Ms to wait per symbol for F&G recalc (default 2000)
 * @param {boolean} opts.skip_screener - If true, use provided symbols instead of screener
 * @param {string[]} opts.symbols - Pre-defined symbol list (used with skip_screener)
 */
export async function fgScan({ max_candidates = 30, wait_ms = 2000, skip_screener = false, symbols: customSymbols } = {}) {
  const t0 = Date.now();
  const results = [];
  let screenerData = [];

  // Phase 1: Get universe from screener
  if (!skip_screener) {
    try {
      const stocks = await readMultiView({ views: ['Overview'], maxRows: 100 });
      screenerData = stocks.map(s => ({
        symbol: s.Symbol,
        price: s._raw?.['Price'] || null,
        change_pct: s._raw?.['Change\xa0%'] || s._raw?.['Change %'] || null,
        volume: s._raw?.['Volume'] || null,
        rel_volume: parseValue(s._raw?.['Rel\xa0Volume'] || s._raw?.['Rel Volume']),
        market_cap: s._raw?.['Market cap'] || null,
        pe: s._raw?.['P/E'] || null,
        sector: s._raw?.['Sector'] || null,
        analyst_rating: s._raw?.['Analyst Rating'] || null,
      }));

      // Sort by relative volume descending (most active first)
      screenerData.sort((a, b) => (b.rel_volume || 0) - (a.rel_volume || 0));
    } catch {
      // Screener not available — fall through to custom symbols
    }
  }

  // Determine symbols to scan
  let symbolsToScan;
  if (customSymbols && customSymbols.length > 0) {
    symbolsToScan = customSymbols.slice(0, max_candidates);
  } else if (screenerData.length > 0) {
    symbolsToScan = screenerData.slice(0, max_candidates).map(s => s.symbol);
  } else {
    throw new Error('No symbols to scan. Either open the screener or provide a symbol list.');
  }

  const screenerPhaseMs = Date.now() - t0;

  // Phase 2: Deep scan each symbol for F&G value
  const scanStart = Date.now();
  for (let i = 0; i < symbolsToScan.length; i++) {
    const sym = symbolsToScan[i];
    try {
      await chart.setSymbol({ symbol: sym });
      const fg = await readFGValue(wait_ms);
      const quote = await data.getQuote({});

      // Find screener data for this symbol
      const screenerInfo = screenerData.find(s => s.symbol === sym) || {};

      results.push({
        symbol: sym,
        fg_score: fg?.fg_score ?? null,
        zone: fg?.zone ?? 'UNKNOWN',
        severity: fg?.severity ?? 0,
        price: quote?.close || quote?.last || null,
        change_pct: parseValue(screenerInfo.change_pct),
        rel_volume: screenerInfo.rel_volume || null,
        market_cap: screenerInfo.market_cap || null,
        pe: screenerInfo.pe || null,
        sector: screenerInfo.sector || null,
        analyst_rating: screenerInfo.analyst_rating || null,
        // Composite scoring
        composite: null, // computed below
      });
    } catch (err) {
      results.push({
        symbol: sym,
        fg_score: null,
        zone: 'ERROR',
        severity: 0,
        error: err.message,
      });
    }
  }

  // Phase 3: Compute composite scores
  for (const r of results) {
    if (r.fg_score == null) continue;

    // F&G component (40%): extreme fear = high opportunity, extreme greed = caution
    // Invert: -50 fear → 100 opportunity score, +50 greed → 0 opportunity score
    const fgOppScore = Math.max(0, Math.min(100, 50 - r.fg_score));

    // Volume anomaly component (30%): high relative volume = actionable
    const volScore = r.rel_volume != null
      ? Math.min(100, (r.rel_volume / 3) * 100)
      : 50;

    // Fundamental component (30%): analyst rating + low P/E
    const ratingScore = r.analyst_rating
      ? (parseValue(r.analyst_rating) || 3) / 5 * 100
      : 50;
    const peScore = r.pe
      ? Math.min(100, Math.max(0, (30 - (parseValue(r.pe) || 30)) / 30 * 100))
      : 50;
    const fundScore = (ratingScore * 0.6 + peScore * 0.4);

    r.composite = Math.round(0.40 * fgOppScore + 0.30 * volScore + 0.30 * fundScore);
  }

  // Phase 4: Categorize results
  const valid = results.filter(r => r.fg_score != null);

  // Sort by composite for main ranking
  const ranked = [...valid].sort((a, b) => b.composite - a.composite);

  // Categorize by zone
  const fearOpportunities = valid
    .filter(r => r.severity <= -1)
    .sort((a, b) => a.fg_score - b.fg_score); // Most fearful first

  const greedWarnings = valid
    .filter(r => r.severity >= 1)
    .sort((a, b) => b.fg_score - a.fg_score); // Most greedy first

  const totalTime = Date.now() - t0;

  return {
    success: true,
    scanned: results.length,
    valid_reads: valid.length,
    failed_reads: results.length - valid.length,
    screener_phase_ms: screenerPhaseMs,
    scan_phase_ms: Date.now() - scanStart,
    total_time_ms: totalTime,
    avg_per_symbol_ms: Math.round((Date.now() - scanStart) / results.length),

    // Main ranked list
    top_opportunities: ranked.slice(0, 10),

    // Zone-based lists
    fear_opportunities: fearOpportunities.slice(0, 10),
    greed_warnings: greedWarnings.slice(0, 10),

    // Full results
    all_results: ranked,
  };
}
