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
  { name: 'dex_extreme_fear', description: 'Find DEX tokens in extreme fear with sufficient liquidity',
    inputSchema: { type: 'object', properties: { chain: { type: 'string' }, min_liquidity: { type: 'number' }, limit: { type: 'number' } } } },
  { name: 'dex_token_search', description: 'Search DEX tokens by symbol or name across all chains',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'dex_whale_buying', description: 'Find DEX tokens with high buy/sell ratio (whale accumulation)',
    inputSchema: { type: 'object', properties: { min_liquidity: { type: 'number' }, limit: { type: 'number' } } } },
  { name: 'dex_chain_summary', description: 'Summary stats per blockchain (liquidity, volume, token count)',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'find_miners', description: 'Search mining companies by commodity, stage, exchange, or country',
    inputSchema: { type: 'object', properties: { commodity: { type: 'string' }, stage: { type: 'string' }, exchange: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'mining_extreme_fear', description: 'Mining stocks in extreme fear (best contrarian entries)',
    inputSchema: { type: 'object', properties: { commodity: { type: 'string' }, exchange: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'mining_gap_analysis', description: 'Find underrepresented mining segments by commodity and stage',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'commodity_price', description: 'Get commodity reference prices (Gold, Copper, Silver, etc)',
    inputSchema: { type: 'object', properties: { commodity: { type: 'string' }, days: { type: 'number' } } } },
  { name: 'mining_company_detail', description: 'Full details for a specific mining company',
    inputSchema: { type: 'object', properties: { ticker: { type: 'string' } }, required: ['ticker'] } },
  { name: 'get_prices_1h', description: 'Get 1-hour OHLCV bars (last 730 days)',
    inputSchema: { type: 'object', properties: { ticker: { type: 'string' }, limit: { type: 'number' } }, required: ['ticker'] } },
  { name: 'get_prices_4h', description: 'Get 4-hour OHLCV bars (resampled from 1h)',
    inputSchema: { type: 'object', properties: { ticker: { type: 'string' }, limit: { type: 'number' } }, required: ['ticker'] } },
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
      case 'dex_extreme_fear':
        result = db.prepare(`
          SELECT t.symbol, t.chain, h.fg_score, t.liquidity_usd, t.volume_24h,
                 t.price_change_24h, t.txns_buys_24h, t.txns_sells_24h, t.url
          FROM dex_tokens t
          JOIN symbols s ON UPPER(t.symbol)||'-'||UPPER(t.chain) = s.ticker
          JOIN fg_history h ON s.ticker = h.ticker
          WHERE h.fg_score < -20 AND t.liquidity_usd > ?
          ${args.chain ? "AND t.chain = ?" : ''}
          ORDER BY h.fg_score ASC LIMIT ?
        `).all(args.min_liquidity || 50000, ...(args.chain ? [args.chain] : []), args.limit || 30);
        break;
      case 'dex_token_search':
        result = db.prepare(`
          SELECT symbol, name, chain, liquidity_usd, market_cap, volume_24h,
                 price_usd, price_change_24h, url
          FROM dex_tokens WHERE UPPER(symbol) LIKE UPPER(?) OR UPPER(name) LIKE UPPER(?)
          ORDER BY liquidity_usd DESC LIMIT ?
        `).all('%' + args.query + '%', '%' + args.query + '%', args.limit || 20);
        break;
      case 'dex_whale_buying':
        result = db.prepare(`
          SELECT symbol, chain, liquidity_usd, txns_buys_24h, txns_sells_24h,
                 ROUND(CAST(txns_buys_24h AS REAL) / NULLIF(txns_buys_24h + txns_sells_24h, 0) * 100, 1) as buy_pct,
                 price_change_24h, url
          FROM dex_tokens WHERE txns_buys_24h > 100 AND liquidity_usd > ?
          AND txns_buys_24h > txns_sells_24h * 1.5
          ORDER BY buy_pct DESC LIMIT ?
        `).all(args.min_liquidity || 100000, args.limit || 30);
        break;
      case 'dex_chain_summary':
        result = db.prepare(`
          SELECT chain, COUNT(*) as tokens,
                 ROUND(SUM(liquidity_usd)/1e6, 1) as total_liq_m,
                 ROUND(SUM(volume_24h)/1e6, 1) as volume_24h_m,
                 SUM(txns_buys_24h) as total_buys, SUM(txns_sells_24h) as total_sells
          FROM dex_tokens GROUP BY chain ORDER BY total_liq_m DESC
        `).all();
        break;
      case 'find_miners':
        result = db.prepare(`
          SELECT mc.ticker, mc.name, mc.exchange, mc.country, mc.primary_commodity, mc.stage,
                 ROUND(mc.market_cap_aud/1e6, 1) as mcap_m_aud, h.fg_score
          FROM mining_companies mc
          LEFT JOIN fg_history h ON h.ticker = mc.ticker AND h.date = (SELECT MAX(date) FROM fg_history WHERE ticker = mc.ticker)
          WHERE 1=1 ${args.commodity ? "AND mc.primary_commodity = ?" : ''} ${args.stage ? "AND mc.stage = ?" : ''} ${args.exchange ? "AND mc.exchange = ?" : ''}
          ORDER BY mc.market_cap_aud DESC LIMIT ?
        `).all(...(args.commodity ? [args.commodity] : []), ...(args.stage ? [args.stage] : []), ...(args.exchange ? [args.exchange] : []), args.limit || 30);
        break;
      case 'mining_extreme_fear':
        result = db.prepare(`
          SELECT mc.ticker, mc.name, mc.primary_commodity, mc.stage, mc.exchange, h.fg_score, ROUND(mc.market_cap_aud/1e6, 1) as mcap_m_aud
          FROM mining_companies mc JOIN fg_history h ON h.ticker = mc.ticker
          WHERE h.date = (SELECT MAX(date) FROM fg_history WHERE ticker = mc.ticker) AND h.fg_score < -10
          ${args.commodity ? "AND mc.primary_commodity = ?" : ''} ${args.exchange ? "AND mc.exchange = ?" : ''}
          ORDER BY h.fg_score ASC LIMIT ?
        `).all(...(args.commodity ? [args.commodity] : []), ...(args.exchange ? [args.exchange] : []), args.limit || 25);
        break;
      case 'mining_gap_analysis':
        result = db.prepare(`
          SELECT primary_commodity, COUNT(*) as total,
                 SUM(CASE WHEN stage LIKE 'Producer%' THEN 1 ELSE 0 END) as producers,
                 SUM(CASE WHEN stage IN ('Explorer','Shell') THEN 1 ELSE 0 END) as explorers
          FROM mining_companies WHERE primary_commodity IS NOT NULL GROUP BY primary_commodity ORDER BY total ASC
        `).all();
        break;
      case 'commodity_price':
        result = db.prepare(`SELECT date, price_usd, unit, commodity FROM commodity_prices WHERE 1=1 ${args.commodity ? 'AND commodity = ?' : ''} ORDER BY date DESC LIMIT ?`).all(...(args.commodity ? [args.commodity] : []), args.days || 30);
        break;
      case 'mining_company_detail':
        result = db.prepare(`
          SELECT mc.*, h.fg_score FROM mining_companies mc
          LEFT JOIN fg_history h ON h.ticker = mc.ticker AND h.date = (SELECT MAX(date) FROM fg_history WHERE ticker = mc.ticker)
          WHERE mc.ticker = ?
        `).all(args.ticker);
        break;
      case 'get_prices_1h':
        result = db.prepare("SELECT datetime(ts,'unixepoch') as time, open, high, low, close, volume FROM prices_1h WHERE ticker = ? ORDER BY ts DESC LIMIT ?").all(args.ticker, args.limit || 200);
        break;
      case 'get_prices_4h':
        result = db.prepare("SELECT datetime(ts,'unixepoch') as time, open, high, low, close, volume FROM prices_4h WHERE ticker = ? ORDER BY ts DESC LIMIT ?").all(args.ticker, args.limit || 200);
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
          dex_tokens: db.prepare('SELECT COUNT(*) as n FROM dex_tokens').get().n,
          mining_companies: db.prepare('SELECT COUNT(*) as n FROM mining_companies').get().n,
          commodity_prices: db.prepare('SELECT COUNT(*) as n FROM commodity_prices').get().n,
          prices_1h: db.prepare('SELECT COUNT(*) as n FROM prices_1h').get().n,
          prices_4h: db.prepare('SELECT COUNT(*) as n FROM prices_4h').get().n,
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
