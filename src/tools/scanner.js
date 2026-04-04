import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as scanner from '../core/scanner.js';
import * as fgScanner from '../core/fg_scanner.js';
import * as fgFast from '../core/fg_fast_scanner.js';
import * as fgExact from '../core/fg_exact_scanner.js';

export function registerScannerTools(server) {
  server.tool('scanner_bulk_scan', 'Scan 100 stocks in ~8 seconds using screener data across multiple views. Returns ranked results with momentum, value, trend, and volume scores. No chart switching needed.', {
    preset: z.enum(['momentum', 'value', 'trend', 'volume_anomaly', 'balanced']).optional()
      .describe('Scan preset: "momentum" (RSI/returns-focused), "value" (P/E/growth-focused), "trend" (MA/alignment-focused), "volume_anomaly" (unusual activity), "balanced" (equal weight). Default: balanced'),
    top: z.number().optional().describe('Return top N results (default 20)'),
    max_rows: z.number().optional().describe('Max stocks to scan per view (default 100)'),
  }, async ({ preset, top, max_rows }) => {
    try { return jsonResult(await scanner.bulkScan({ preset, top, max_rows })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('scanner_fg_scan', 'Deep Fear & Greed scan on specific symbols. Reads the DGT F&G indicator per symbol by switching the chart. ~13s per symbol.', {
    symbols: z.array(z.string()).describe('Symbol list to scan (e.g., ["AAPL", "MSFT", "BTCUSD"])'),
    wait_ms: z.number().optional().describe('Ms to wait per symbol for F&G recalc (default 2000)'),
  }, async ({ symbols, wait_ms }) => {
    try {
      return jsonResult(await fgScanner.fgScan({ max_candidates: symbols.length, wait_ms, skip_screener: true, symbols }));
    } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('scanner_fg_bulk', '3-tier F&G bulk scanner. Tier 1: proxy F&G on 100 stocks in ~6s. Tier 2: real F&G on top 15 in ~3min. Tier 3: chart analysis on top 5 with fibs, S/R, screenshots. Total ~5 min for full pipeline.', {
    universe: z.number().optional().describe('Stocks in Tier 1 proxy scan (default 100)'),
    deep: z.number().optional().describe('Stocks for Tier 2 real F&G read (default 15)'),
    chart: z.number().optional().describe('Stocks for Tier 3 chart analysis (default 5)'),
    wait_ms: z.number().optional().describe('Ms per symbol for F&G recalc (default 2000)'),
  }, async ({ universe, deep, chart: chartCount, wait_ms }) => {
    try {
      return jsonResult(await fgScanner.fgBulkScan({ universe, deep, chart: chartCount, wait_ms }));
    } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('scanner_parse_value', 'Parse a TradingView screener string into a number. Handles "4.31 T USD" → 4310000000000, "+66.75%" → 66.75, "Strong buy" → 5.', {
    value: z.string().describe('TradingView string to parse'),
  }, async ({ value }) => {
    return jsonResult({ success: true, input: value, parsed: scanner.parseValue(value) });
  });

  server.tool('scanner_quick', 'Ultra-fast screener scan: 100 stocks scored with proxy F&G in <8 seconds. Pure data — no chart switching, no screenshots. Returns fear/greed opportunities, ranked results, and zone distribution.', {
    universe: z.number().optional().describe('Stocks to scan (default 100)'),
    top: z.number().optional().describe('Return top N results (default 20)'),
    sort: z.enum(['fear', 'greed', 'momentum', 'composite']).optional().describe('Sort order (default: fear)'),
  }, async ({ universe, top, sort }) => {
    try { return jsonResult(await fgFast.quickScan({ universe, top, sort })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('scanner_fg_fast', 'Fast F&G pipeline: screener proxy on 100 stocks (~6s) + Pine batch for real F&G on top 38 candidates (~15s). Total <25s. No chart switching — uses request.security() batch. Returns proxy accuracy, fear/greed opportunities, momentum shifts.', {
    universe: z.number().optional().describe('Stocks for Tier 1 screener proxy (default 100)'),
    deep: z.number().optional().describe('Stocks for Tier 2 Pine batch (default 38, max 38)'),
    pine_wait_ms: z.number().optional().describe('Ms to wait for Pine calculation (default 4000)'),
  }, async ({ universe, deep, pine_wait_ms }) => {
    try { return jsonResult(await fgFast.fgFastScan({ universe, deep, pine_wait_ms })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('scanner_fg_exact', 'Exact F&G scan with incremental caching. First scan does full calculation and caches EMA/RMA state. Subsequent scans return cached scores instantly or update incrementally with delta bars only. Shows tier breakdown: instant/micro/partial/full.', {
    universe: z.number().optional().describe('Stocks to scan (default 50)'),
    top: z.number().optional().describe('Return top N results (default 20)'),
    sort: z.enum(['fear', 'greed', 'composite']).optional().describe('Sort order (default: fear)'),
    skip_globals: z.boolean().optional().describe('Skip VIX/Gold global fetch for speed (default: true)'),
  }, async ({ universe, top, sort, skip_globals }) => {
    try { return jsonResult(await fgExact.fgExactScan({ universe, top, sort, skip_globals })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('scanner_cache_stats', 'Show F&G cache statistics: total symbols cached, staleness distribution (instant/micro/partial/full), zone breakdown, avg age, global components state.', {}, async () => {
    try { return jsonResult(fgExact.getCacheStats()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('scanner_cache_clear', 'Clear the F&G score cache for a fresh start.', {}, async () => {
    try { return jsonResult(fgExact.clearCache()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
