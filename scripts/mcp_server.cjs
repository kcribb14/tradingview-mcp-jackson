#!/usr/bin/env node
/**
 * fg-data MCP server — exposes the local SQLite DB to Claude.
 * Add via: claude mcp add fg-data node ~/tradingview-mcp-jackson/scripts/mcp_server.cjs
 */
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const Database = require('better-sqlite3');
const DB_PATH = process.env.HOME + '/.tradingview-mcp/db/fg.db';

const db = new Database(DB_PATH, { readonly: true });

const server = new Server({ name: 'fg-data', version: '1.0.0' }, { capabilities: { tools: {} } });

const TOOLS = [
  { name: 'get_prices', description: 'Historical OHLCV for a ticker. Returns date, open, high, low, close, volume.',
    inputSchema: { type: 'object', properties: { ticker: { type: 'string' }, start_date: { type: 'string' }, limit: { type: 'number' } }, required: ['ticker'] } },
  { name: 'get_fg_history', description: 'F&G score time series for a ticker',
    inputSchema: { type: 'object', properties: { ticker: { type: 'string' }, limit: { type: 'number' } }, required: ['ticker'] } },
  { name: 'get_fundamentals', description: 'Latest fundamentals (revenue, profit, equity, EPS) from SEC EDGAR XBRL',
    inputSchema: { type: 'object', properties: { ticker: { type: 'string' } }, required: ['ticker'] } },
  { name: 'get_filings', description: 'SEC filings (10-K, 10-Q, 8-K) with direct links',
    inputSchema: { type: 'object', properties: { ticker: { type: 'string' }, filing_type: { type: 'string' }, limit: { type: 'number' } }, required: ['ticker'] } },
  { name: 'get_insider_trades', description: 'Recent Form 4 insider trade filings',
    inputSchema: { type: 'object', properties: { ticker: { type: 'string' }, limit: { type: 'number' } }, required: ['ticker'] } },
  { name: 'find_extreme_fear', description: 'Find symbols in extreme fear (F&G < threshold). Best entry signals.',
    inputSchema: { type: 'object', properties: { threshold: { type: 'number' }, category: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'sector_comparison', description: 'Average and median F&G per sector/category',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'get_forex_rate', description: 'Get historical forex rate (e.g. EURUSD=X, AUDUSD=X). Returns date + rate.',
    inputSchema: { type: 'object', properties: { pair: { type: 'string', description: 'Yahoo format e.g. EURUSD=X or just EURUSD' }, days: { type: 'number' } }, required: ['pair'] } },
  { name: 'forex_fear', description: 'Find forex pairs in extreme fear (oversold currencies)',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'dxy_status', description: 'Get US Dollar Index (DXY) value and 30-day trend',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'db_stats', description: 'Show database statistics (row counts per table)',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'run_sql', description: 'Execute a read-only SQL query (SELECT only)',
    inputSchema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] } }
];

server.setRequestHandler('tools/list', async () => ({ tools: TOOLS }));

server.setRequestHandler('tools/call', async (req) => {
  const { name, arguments: args } = req.params;
  try {
    let result;
    switch (name) {
      case 'get_prices':
        result = db.prepare(
          `SELECT date, open, high, low, close, volume FROM prices WHERE ticker = ? ${args.start_date ? 'AND date >= ?' : ''} ORDER BY date DESC LIMIT ?`
        ).all(args.ticker, ...(args.start_date ? [args.start_date] : []), args.limit || 500);
        break;
      case 'get_fg_history':
        result = db.prepare('SELECT date, fg_score, zone FROM fg_history WHERE ticker = ? ORDER BY date DESC LIMIT ?').all(args.ticker, args.limit || 365);
        break;
      case 'get_fundamentals':
        result = db.prepare('SELECT * FROM fundamentals WHERE ticker = ? ORDER BY period_end DESC LIMIT 8').all(args.ticker);
        break;
      case 'get_filings':
        result = db.prepare(
          `SELECT * FROM filings WHERE ticker = ? ${args.filing_type ? "AND filing_type = ?" : ""} ORDER BY filing_date DESC LIMIT ?`
        ).all(args.ticker, ...(args.filing_type ? [args.filing_type] : []), args.limit || 20);
        break;
      case 'get_insider_trades':
        result = db.prepare('SELECT * FROM insider_trades WHERE ticker = ? ORDER BY filed_at DESC LIMIT ?').all(args.ticker, args.limit || 30);
        break;
      case 'find_extreme_fear': {
        const threshold = args.threshold || -20;
        const sql = `
          SELECT f.ticker, f.fg_score, f.zone, s.category, f.date
          FROM fg_history f
          JOIN (SELECT ticker, MAX(date) as md FROM fg_history GROUP BY ticker) l ON f.ticker = l.ticker AND f.date = l.md
          LEFT JOIN symbols s ON f.ticker = s.ticker
          WHERE f.fg_score < ? ${args.category ? 'AND s.category = ?' : ''}
          ORDER BY f.fg_score ASC LIMIT ?`;
        result = db.prepare(sql).all(threshold, ...(args.category ? [args.category] : []), args.limit || 50);
        break;
      }
      case 'sector_comparison':
        result = db.prepare(`
          SELECT s.category as sector, COUNT(*) as symbols,
                 ROUND(AVG(f.fg_score), 1) as avg_fg,
                 SUM(CASE WHEN f.fg_score < -15 THEN 1 ELSE 0 END) as in_fear
          FROM fg_history f
          JOIN (SELECT ticker, MAX(date) as md FROM fg_history GROUP BY ticker) l ON f.ticker = l.ticker AND f.date = l.md
          JOIN symbols s ON f.ticker = s.ticker
          GROUP BY s.category ORDER BY avg_fg ASC
        `).all();
        break;
      case 'get_forex_rate': {
        const pair = args.pair.toUpperCase().endsWith('=X') ? args.pair.toUpperCase() : args.pair.toUpperCase() + '=X';
        result = db.prepare('SELECT date, close as rate FROM prices WHERE ticker = ? ORDER BY date DESC LIMIT ?').all(pair, args.days || 30);
        break;
      }
      case 'forex_fear':
        result = db.prepare(`
          SELECT s.ticker, h.fg_score, h.zone, h.date
          FROM fg_history h
          JOIN (SELECT ticker, MAX(date) as md FROM fg_history GROUP BY ticker) l ON h.ticker = l.ticker AND h.date = l.md
          JOIN symbols s ON h.ticker = s.ticker
          WHERE s.asset_class = 'forex' AND h.fg_score < -5
          ORDER BY h.fg_score ASC
        `).all();
        break;
      case 'dxy_status':
        result = db.prepare("SELECT date, close as value FROM prices WHERE ticker = 'DX-Y.NYB' ORDER BY date DESC LIMIT 30").all();
        break;
      case 'db_stats':
        result = {
          symbols: db.prepare('SELECT COUNT(*) as n FROM symbols').get().n,
          prices: db.prepare('SELECT COUNT(*) as n FROM prices').get().n,
          tickers_with_prices: db.prepare('SELECT COUNT(DISTINCT ticker) as n FROM prices').get().n,
          fg_points: db.prepare('SELECT COUNT(*) as n FROM fg_history').get().n,
          filings: db.prepare('SELECT COUNT(*) as n FROM filings').get().n,
          fundamentals: db.prepare('SELECT COUNT(*) as n FROM fundamentals').get().n,
          insider_trades: db.prepare('SELECT COUNT(*) as n FROM insider_trades').get().n,
        };
        break;
      case 'run_sql':
        if (!/^\s*SELECT/i.test(args.sql)) throw new Error('Only SELECT queries allowed');
        result = db.prepare(args.sql).all();
        break;
      default: throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('fg-data MCP server running on', DB_PATH);
}
main().catch(console.error);
