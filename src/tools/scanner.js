import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as scanner from '../core/scanner.js';
import * as fgScanner from '../core/fg_scanner.js';

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

  server.tool('scanner_fg_scan', 'Deep Fear & Greed scan: pre-filters via screener, then reads the DGT F&G indicator value for each symbol by switching the chart. Returns opportunities in extreme fear and warnings in extreme greed. Requires F&G indicator on chart.', {
    max_candidates: z.number().optional().describe('Max symbols to deep-scan (default 30). Each takes ~13s.'),
    wait_ms: z.number().optional().describe('Ms to wait per symbol for F&G recalc (default 2000)'),
    symbols: z.array(z.string()).optional().describe('Custom symbol list instead of screener universe'),
  }, async ({ max_candidates, wait_ms, symbols }) => {
    try {
      return jsonResult(await fgScanner.fgScan({
        max_candidates, wait_ms,
        skip_screener: symbols && symbols.length > 0,
        symbols,
      }));
    } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('scanner_parse_value', 'Parse a TradingView screener string into a number. Handles "4.31 T USD" → 4310000000000, "+66.75%" → 66.75, "Strong buy" → 5.', {
    value: z.string().describe('TradingView string to parse'),
  }, async ({ value }) => {
    return jsonResult({ success: true, input: value, parsed: scanner.parseValue(value) });
  });
}
