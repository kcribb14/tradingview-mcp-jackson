import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as scanner from '../core/scanner.js';

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

  server.tool('scanner_parse_value', 'Parse a TradingView screener string into a number. Handles "4.31 T USD" → 4310000000000, "+66.75%" → 66.75, "Strong buy" → 5.', {
    value: z.string().describe('TradingView string to parse'),
  }, async ({ value }) => {
    return jsonResult({ success: true, input: value, parsed: scanner.parseValue(value) });
  });
}
