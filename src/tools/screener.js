import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/screener.js';

export function registerScreenerTools(server) {
  server.tool('screener_open', 'Open the TradingView Stock Screener panel. Must be opened before reading screener data.', {}, async () => {
    try { return jsonResult(await core.open()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('screener_read', 'Read current screener results (symbol, price, change%, volume, market cap, sector, rating, etc.). Returns all visible rows as structured data.', {
    max_rows: z.number().optional().describe('Maximum rows to return (default 100)'),
    view: z.string().optional().describe('Switch to a screener tab before reading: "overview", "performance", "valuation", "dividends", "profitability", "technicals", "income statement", "balance sheet", "cash flow", "per share", "extended hours"'),
  }, async ({ max_rows, view }) => {
    try { return jsonResult(await core.read({ max_rows, view })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('screener_sort', 'Sort the screener by any column. Uses React fiber setSort() for 100% reliability — no DOM clicks.', {
    column: z.string().describe('Column to sort by. Display names: "Market cap", "Change %", "P/E", "Volume", "Price", "Analyst Rating", "Sector", "EPS", "Div yield %", "Beta", "RSI". Or internal IDs: MarketCap, Change, PriceToEarnings, Volume, etc.'),
    order: z.enum(['asc', 'desc']).optional().describe('Sort order: "desc" (default) or "asc"'),
  }, async ({ column, order }) => {
    try { return jsonResult(await core.sort({ column, order })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('screener_get_sort', 'Get the current screener sort column and direction.', {}, async () => {
    try { return jsonResult(await core.getSort()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('screener_filter', 'Open a filter pill to view/set filter options. Click a filter pill (e.g., "Sector", "Market cap") to open its dropdown/popup.', {
    filter_name: z.string().describe('Filter pill text (e.g., "Sector", "Market cap", "P/E", "Analyst Rating", "Div yield %", "Price", "Change %")'),
  }, async ({ filter_name }) => {
    try { return jsonResult(await core.filter({ filter_name })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('screener_get_filters', 'List all available screener filter pills, view tabs, and current column headers.', {}, async () => {
    try { return jsonResult(await core.getFilters()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('screener_export', 'Export all visible screener data as structured JSON (up to 500 rows).', {}, async () => {
    try { return jsonResult(await core.exportData()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
