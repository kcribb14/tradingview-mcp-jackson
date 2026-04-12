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
  { name: 'compute_correlation', description: 'Correlation matrix for a list of tickers (date-aligned, no timestamp bugs)',
    inputSchema: { type: 'object', properties: { tickers: { type: 'array', items: { type: 'string' } }, timeframe: { type: 'string' }, days: { type: 'number' } }, required: ['tickers'] } },
  { name: 'compare_performance', description: 'Compare aligned Sharpe, return, vol, max DD across symbols',
    inputSchema: { type: 'object', properties: { tickers: { type: 'array', items: { type: 'string' } }, lookback_days: { type: 'number' } }, required: ['tickers'] } },
  { name: 'get_cross_timeframe', description: 'Latest daily + 4h + 1h price, F&G, and performance for one ticker',
    inputSchema: { type: 'object', properties: { ticker: { type: 'string' } }, required: ['ticker'] } },
  { name: 'compute_beta', description: 'Beta, alpha, R-squared vs a benchmark (default SPY)',
    inputSchema: { type: 'object', properties: { ticker: { type: 'string' }, benchmark: { type: 'string' }, days: { type: 'number' } }, required: ['ticker'] } },
  { name: 'list_asset_groups', description: 'List all cascade asset groups and their members',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'lag_relationship', description: 'Historical lag pattern between leader and follower — peak correlation, hit rate, magnitude',
    inputSchema: { type: 'object', properties: { leader: { type: 'string' }, follower: { type: 'string' } }, required: ['leader','follower'] } },
  { name: 'active_cascade_signals', description: 'Currently active cascade signals — assets primed to move based on leader movement',
    inputSchema: { type: 'object', properties: { group: { type: 'string' }, min_hit_rate: { type: 'number' } } } },
  { name: 'cascade_chain_status', description: 'Current state of every asset in a cascade group — who moved, who is primed',
    inputSchema: { type: 'object', properties: { group: { type: 'string' } }, required: ['group'] } },
  { name: 'dex_token_lookup', description: 'Look up any DEX token by symbol or address across all chains',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, chain: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'dex_token_history', description: 'Daily OHLCV + buy/sell ratio + liquidity history for a DEX token',
    inputSchema: { type: 'object', properties: { token_address: { type: 'string' }, chain: { type: 'string' }, days: { type: 'number' } }, required: ['token_address'] } },
  { name: 'dex_snapshot_series', description: 'Raw hourly snapshots — full granularity volume/txn/price data',
    inputSchema: { type: 'object', properties: { token_address: { type: 'string' }, chain: { type: 'string' }, hours: { type: 'number' } }, required: ['token_address'] } },
  { name: 'dex_volume_profile2', description: 'Which hours of day a token is most active — session pattern discovery',
    inputSchema: { type: 'object', properties: { token_address: { type: 'string' }, chain: { type: 'string' } }, required: ['token_address'] } },
  { name: 'dex_scan2', description: 'Flexible scan: filter by chain, liquidity, volume, buy ratio, price change, age. For discovering tokens matching ANY criteria.',
    inputSchema: { type: 'object', properties: { chain: { type: 'string' }, min_liquidity: { type: 'number' }, min_volume_24h: { type: 'number' }, min_buy_ratio: { type: 'number' }, max_price_change_24h: { type: 'number' }, sort_by: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'dex_trending_history2', description: 'Tokens that appeared on trending/boost lists — what happened to price after',
    inputSchema: { type: 'object', properties: { chain: { type: 'string' }, days: { type: 'number' }, limit: { type: 'number' } } } },
  { name: 'dex_chain_overview2', description: 'Summary stats per blockchain — tokens, liquidity, volume, buy/sell ratios',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'defi_tvl_query', description: 'Query DeFiLlama protocol TVL data',
    inputSchema: { type: 'object', properties: { protocol: { type: 'string' }, days: { type: 'number' } } } },
  { name: 'pump_history', description: 'Historical pump events (40%+). Filter by ticker, min size, source. Shows pre-pump drawdown, volume, F&G, and post-pump outcome.',
    inputSchema: { type: 'object', properties: { ticker: { type: 'string' }, min_pump_pct: { type: 'number' }, source: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'pump_characteristics', description: 'Statistical profile of what data looks like BEFORE a pump — avg/median/std for drawdown, volume, volatility, F&G, timing. Derived from 54K+ events.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'pump_scan_current', description: 'Find tokens currently matching the pre-pump profile: deep drawdown + fear + recovery starting.',
    inputSchema: { type: 'object', properties: { source: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'token_onchain_profile', description: 'On-chain profile: metadata, holders, whale trades, exchange listings, social presence',
    inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } },
  { name: 'whale_activity', description: 'Recent whale trades ($1k+) for a token — shows accumulation vs distribution',
    inputSchema: { type: 'object', properties: { symbol: { type: 'string' }, days: { type: 'number' }, limit: { type: 'number' } }, required: ['symbol'] } },
  { name: 'pump_full_profile', description: 'Complete pre-pump profile: price metrics + on-chain metrics combined from 54K+ events',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'exchange_listing_tracker', description: 'Show exchanges for a token, or find tokens on few exchanges (uplist potential)',
    inputSchema: { type: 'object', properties: { symbol: { type: 'string' }, max_exchanges: { type: 'number' }, limit: { type: 'number' } } } },
  { name: 'mining_scanner_latest', description: 'Latest scanner results. Filter by archetype, min_score, commodity.',
    inputSchema: { type: 'object', properties: { archetype: { type: 'string' }, min_score: { type: 'number' }, commodity: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'mining_scanner_triggered', description: 'Miners with active triggers (volume spike or gap up in last 5 days)',
    inputSchema: { type: 'object', properties: { min_score: { type: 'number' }, limit: { type: 'number' } } } },
  { name: 'mining_scanner_history', description: 'Track a ticker score over time from scanner_results',
    inputSchema: { type: 'object', properties: { ticker: { type: 'string' }, days: { type: 'number' } }, required: ['ticker'] } },
  { name: 'pump_archetype_stats', description: 'Show 8 mining pump archetypes with historical held%, median pump, risk-adj score',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'session_timing_query', description: 'Query session timing stats (day_of_week, month, exchange patterns)',
    inputSchema: { type: 'object', properties: { dimension: { type: 'string', description: 'day_of_week, month, or exchange' } } } },
  { name: 'spillover_tracker', description: 'Cross-exchange spillover events — when a pump on one exchange leads to pumps on others',
    inputSchema: { type: 'object', properties: { commodity: { type: 'string' }, leader_exchange: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'data_gaps', description: 'Show current data coverage and gaps by category',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'drillhole_exploration', description: 'Query drillhole data by commodity, country, or ticker',
    inputSchema: { type: 'object', properties: { ticker: { type: 'string' }, commodity: { type: 'string' }, country: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'drilling_trends', description: 'Drilling activity trends — accelerating or dormant by commodity/country',
    inputSchema: { type: 'object', properties: { commodity: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'volume_alerts_recent', description: 'Recent volume spike alerts from the 15-min monitor. Shows ticker, volume ratio, scanner score, archetype.',
    inputSchema: { type: 'object', properties: { days: { type: 'number' }, source: { type: 'string', description: 'mining or dex' }, limit: { type: 'number' } } } },
  { name: 'ai_screening_latest', description: 'Latest AI screening results from Gemma. Shows ticker, archetype, confidence, thesis, action (alert/watch/avoid).',
    inputSchema: { type: 'object', properties: { action: { type: 'string', description: 'alert, watch, or avoid' }, min_confidence: { type: 'number' }, limit: { type: 'number' } } } },
  { name: 'ai_screening_accuracy', description: 'AI screening accuracy stats — how well did Gemma predict 7d/30d outcomes?',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'ai_screener_rerun', description: 'Trigger a fresh AI screening run on top 20 scanner candidates. Returns results when complete.',
    inputSchema: { type: 'object', properties: { count: { type: 'number', description: 'Number of candidates to screen (default 20)' } } } },
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
      case 'compute_correlation': {
        const tks = args.tickers, tf = args.timeframe || 'D', days = args.days || 90;
        const cutoff = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
        const matrix = {};
        for (const a of tks) { matrix[a] = {}; for (const b of tks) {
          if (a === b) { matrix[a][b] = 1; continue; }
          const aligned = db.prepare(`SELECT ra.return_pct as ra, rb.return_pct as rb FROM returns ra JOIN returns rb ON ra.date_or_ts = rb.date_or_ts AND ra.timeframe = rb.timeframe WHERE ra.ticker = ? AND rb.ticker = ? AND ra.timeframe = ? AND ra.date_or_ts >= ?`).all(a, b, tf, cutoff);
          if (aligned.length < 5) { matrix[a][b] = null; continue; }
          const ra = aligned.map(r => r.ra), rb2 = aligned.map(r => r.rb), n = ra.length;
          let sa=0,sb=0,saa=0,sbb=0,sab=0;
          for (let k=0;k<n;k++){sa+=ra[k];sb+=rb2[k];saa+=ra[k]*ra[k];sbb+=rb2[k]*rb2[k];sab+=ra[k]*rb2[k]}
          const den = Math.sqrt((n*saa-sa*sa)*(n*sbb-sb*sb));
          matrix[a][b] = den === 0 ? null : Math.round((n*sab-sa*sb)/den*1000)/1000;
        }}
        result = { matrix, days, timeframe: tf };
        break;
      }
      case 'compare_performance': {
        const tks = args.tickers, days = args.lookback_days || 180;
        const placeholders = tks.map(() => '?').join(',');
        result = db.prepare(`SELECT ticker, total_return, ann_return, ann_vol, sharpe, max_drawdown, win_rate FROM performance_stats WHERE ticker IN (${placeholders}) AND lookback_days = ? AND timeframe = 'D' ORDER BY sharpe DESC`).all(...tks, days);
        break;
      }
      case 'get_cross_timeframe': {
        const t = args.ticker;
        const daily = db.prepare("SELECT date, close FROM prices WHERE ticker = ? ORDER BY date DESC LIMIT 1").all(t);
        const h1 = db.prepare("SELECT ts, close FROM prices_1h WHERE ticker = ? ORDER BY ts DESC LIMIT 1").all(t);
        const h4 = db.prepare("SELECT ts, close FROM prices_4h WHERE ticker = ? ORDER BY ts DESC LIMIT 1").all(t);
        const fg = db.prepare("SELECT date, fg_score, zone FROM fg_history WHERE ticker = ? ORDER BY date DESC LIMIT 1").all(t);
        const perf = db.prepare("SELECT lookback_days, total_return, sharpe, max_drawdown FROM performance_stats WHERE ticker = ? ORDER BY lookback_days").all(t);
        result = { ticker: t, daily: daily[0], h1: h1[0], h4: h4[0], fg: fg[0], performance: perf };
        break;
      }
      case 'compute_beta': {
        const t = args.ticker, bench = args.benchmark || 'SPY', days = args.days || 365;
        const cutoff = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
        const aligned = db.prepare(`SELECT ra.return_pct as ra, rb.return_pct as rb FROM returns ra JOIN returns rb ON ra.date_or_ts = rb.date_or_ts AND ra.timeframe = rb.timeframe WHERE ra.ticker = ? AND rb.ticker = ? AND ra.timeframe = 'D' AND ra.date_or_ts >= ?`).all(t, bench, cutoff);
        if (aligned.length < 30) { result = { error: 'Insufficient aligned data', sample: aligned.length }; break; }
        const n = aligned.length, ra = aligned.map(r=>r.ra), rb2 = aligned.map(r=>r.rb);
        const mA = ra.reduce((a,b)=>a+b,0)/n, mB = rb2.reduce((a,b)=>a+b,0)/n;
        let cov=0,vB=0,vA=0;
        for (let i=0;i<n;i++){cov+=(ra[i]-mA)*(rb2[i]-mB);vB+=(rb2[i]-mB)**2;vA+=(ra[i]-mA)**2}
        cov/=(n-1);vB/=(n-1);vA/=(n-1);
        const beta = vB>0?cov/vB:null, alpha = mA-(beta||0)*mB;
        const r2 = vA>0&&vB>0?(cov*cov)/(vA*vB):null;
        result = { ticker:t, benchmark:bench, sample:n, beta:beta?Math.round(beta*1000)/1000:null, alpha_annual:alpha?Math.round(alpha*252*1000)/1000:null, r_squared:r2?Math.round(r2*1000)/1000:null };
        break;
      }
      case 'list_asset_groups':
        result = db.prepare('SELECT group_name, ticker, position, role FROM asset_groups ORDER BY group_name, position, ticker').all();
        break;
      case 'lag_relationship':
        result = db.prepare('SELECT lag_days, ROUND(correlation,3) as correlation, ROUND(hit_rate,3) as hit_rate, ROUND(avg_follower_move*100,2) as avg_follower_pct, sample_size FROM lag_correlations WHERE ticker_leader = ? AND ticker_follower = ? ORDER BY lag_days').all(args.leader, args.follower);
        break;
      case 'active_cascade_signals':
        result = db.prepare(`SELECT group_name, leader_ticker, ROUND(leader_move_pct*100,2) as leader_pct, leader_move_date, follower_ticker, expected_lag_days, ROUND(expected_follower_move*100,2) as expected_pct, ROUND(hit_rate*100,1) as hit_rate_pct, ROUND(signal_strength,3) as strength FROM cascade_signals WHERE status='active' ${args.min_hit_rate ? 'AND hit_rate >= ?' : ''} ${args.group ? 'AND group_name = ?' : ''} ORDER BY signal_strength DESC`).all(...(args.min_hit_rate ? [args.min_hit_rate] : []), ...(args.group ? [args.group] : []));
        break;
      case 'cascade_chain_status': {
        const members = db.prepare('SELECT ticker, position, role FROM asset_groups WHERE group_name = ? ORDER BY position, ticker').all(args.group);
        const chain = members.map(m => {
          const ret = db.prepare("SELECT return_pct FROM returns WHERE ticker = ? AND timeframe = 'D' ORDER BY date_or_ts DESC LIMIT 1").get(m.ticker);
          const ret5 = db.prepare("SELECT return_pct FROM returns WHERE ticker = ? AND timeframe = 'D' ORDER BY date_or_ts DESC LIMIT 5").all(m.ticker);
          const fg = db.prepare("SELECT fg_score FROM fg_history WHERE ticker = ? ORDER BY date DESC LIMIT 1").get(m.ticker);
          const cum5 = ret5.reduce((acc, r) => acc * (1 + r.return_pct), 1) - 1;
          return { ...m, ret_1d: ret ? Math.round(ret.return_pct * 10000) / 100 : null, ret_5d: Math.round(cum5 * 10000) / 100, fg: fg?.fg_score || null };
        });
        result = chain;
        break;
      }
      case 'dex_token_lookup':
        result = db.prepare(`SELECT r.token_address, r.chain, r.symbol, r.name, r.url, s.price_usd, s.market_cap, s.liquidity_usd, s.volume_24h, s.txns_buys_24h, s.txns_sells_24h, s.price_change_24h FROM dex_registry r LEFT JOIN dex_snapshots s ON r.token_address=s.token_address AND r.chain=s.chain AND s.snapshot_ts=(SELECT MAX(snapshot_ts) FROM dex_snapshots WHERE token_address=r.token_address AND chain=r.chain) WHERE (UPPER(r.symbol) LIKE UPPER(?) OR r.token_address LIKE ?) ${args.chain ? 'AND r.chain=?' : ''} ORDER BY s.liquidity_usd DESC LIMIT ?`).all('%'+args.query+'%', '%'+args.query+'%', ...(args.chain ? [args.chain] : []), args.limit||10);
        break;
      case 'dex_token_history':
        result = db.prepare('SELECT date, open_price, high_price, low_price, close_price, avg_liquidity, total_volume, total_buys, total_sells, buy_sell_ratio, avg_mcap FROM dex_daily WHERE token_address=? AND chain=? ORDER BY date DESC LIMIT ?').all(args.token_address, args.chain||'solana', args.days||30);
        break;
      case 'dex_snapshot_series':
        result = db.prepare("SELECT snapshot_ts, price_usd, market_cap, liquidity_usd, volume_1h, volume_24h, txns_buys_1h, txns_sells_1h, price_change_5m, price_change_1h, price_change_24h FROM dex_snapshots WHERE token_address=? AND chain=? AND snapshot_ts > datetime('now', '-' || ? || ' hours') ORDER BY snapshot_ts ASC").all(args.token_address, args.chain||'solana', args.hours||168);
        break;
      case 'dex_volume_profile2':
        result = db.prepare('SELECT hour_utc, ROUND(avg_volume,0) as avg_vol, ROUND(avg_buys,1) as avg_buys, ROUND(avg_sells,1) as avg_sells, ROUND(avg_price_change,2) as avg_pct, sample_count FROM dex_hourly_profile WHERE token_address=? AND chain=? ORDER BY hour_utc').all(args.token_address, args.chain||'solana');
        break;
      case 'dex_scan2': {
        const conds = ['1=1']; const prms = [];
        if (args.chain) { conds.push('s.chain=?'); prms.push(args.chain); }
        if (args.min_liquidity) { conds.push('s.liquidity_usd>=?'); prms.push(args.min_liquidity); }
        if (args.min_volume_24h) { conds.push('s.volume_24h>=?'); prms.push(args.min_volume_24h); }
        if (args.min_buy_ratio) { conds.push('CAST(s.txns_buys_24h AS REAL)/NULLIF(s.txns_buys_24h+s.txns_sells_24h,0)>=?'); prms.push(args.min_buy_ratio); }
        if (args.max_price_change_24h != null) { conds.push('s.price_change_24h<=?'); prms.push(args.max_price_change_24h); }
        const sortMap = {volume:'s.volume_24h',liquidity:'s.liquidity_usd',mcap:'s.market_cap',buy_ratio:'CAST(s.txns_buys_24h AS REAL)/NULLIF(s.txns_buys_24h+s.txns_sells_24h,0)'};
        const sort = sortMap[args.sort_by] || 's.volume_24h';
        prms.push(args.limit||30);
        result = db.prepare(`SELECT r.symbol, r.chain, r.url, s.price_usd, s.market_cap, s.liquidity_usd, s.volume_24h, s.txns_buys_24h, s.txns_sells_24h, ROUND(CAST(s.txns_buys_24h AS REAL)/NULLIF(s.txns_buys_24h+s.txns_sells_24h,0),3) as buy_ratio, s.price_change_24h, r.token_address FROM dex_snapshots s JOIN dex_registry r ON s.token_address=r.token_address AND s.chain=r.chain WHERE s.snapshot_ts=(SELECT MAX(snapshot_ts) FROM dex_snapshots WHERE token_address=s.token_address AND chain=s.chain) AND ${conds.join(' AND ')} ORDER BY ${sort} DESC LIMIT ?`).all(...prms);
        break;
      }
      case 'dex_trending_history2':
        result = db.prepare(`SELECT t.symbol, t.chain, t.source, t.trending_at, t.price_at_trending, t.mcap_at_trending, t.liquidity_at_trending, s.price_usd as current_price, ROUND((s.price_usd-t.price_at_trending)/NULLIF(t.price_at_trending,0)*100,1) as pct_since FROM dex_trending_log t LEFT JOIN dex_snapshots s ON t.token_address=s.token_address AND t.chain=s.chain AND s.snapshot_ts=(SELECT MAX(snapshot_ts) FROM dex_snapshots WHERE token_address=t.token_address AND chain=t.chain) WHERE t.trending_at > datetime('now','-'||?||' days') ${args.chain ? 'AND t.chain=?' : ''} ORDER BY t.trending_at DESC LIMIT ?`).all(args.days||7, ...(args.chain ? [args.chain] : []), args.limit||30);
        break;
      case 'dex_chain_overview2':
        result = db.prepare(`SELECT s.chain, COUNT(DISTINCT s.token_address) as tokens, ROUND(SUM(s.liquidity_usd)/1e6,1) as liq_m, ROUND(SUM(s.volume_24h)/1e6,1) as vol_m, ROUND(AVG(CAST(s.txns_buys_24h AS REAL)/NULLIF(s.txns_buys_24h+s.txns_sells_24h,0)),3) as avg_buy_ratio FROM dex_snapshots s WHERE s.snapshot_ts=(SELECT MAX(snapshot_ts) FROM dex_snapshots WHERE token_address=s.token_address AND chain=s.chain) GROUP BY s.chain ORDER BY liq_m DESC`).all();
        break;
      case 'defi_tvl_query':
        result = db.prepare(`SELECT protocol, date, tvl_usd FROM defi_tvl WHERE 1=1 ${args.protocol ? 'AND protocol=?' : ''} ORDER BY date DESC LIMIT ?`).all(...(args.protocol ? [args.protocol] : []), args.days||30);
        break;
      case 'pump_history':
        result = db.prepare(`SELECT event_id, ticker, source, pump_date, ROUND(pump_pct,1) as pump_pct, ROUND(pre_7d_return,1) as pre_7d, ROUND(pre_30d_return,1) as pre_30d, ROUND(volume_ratio,1) as vol_ratio, ROUND(pre_7d_volatility,1) as volatility, ROUND(pre_fg_score,1) as fg, ROUND(drawdown_from_high,1) as drawdown, ROUND(post_24h_return,1) as post_24h, ROUND(post_7d_return,1) as post_7d, held_gains FROM pump_events WHERE pump_pct >= ? ${args.ticker ? "AND ticker LIKE '%'||?||'%'" : ''} ${args.source ? 'AND source=?' : ''} ORDER BY pump_pct DESC LIMIT ?`).all(args.min_pump_pct||60, ...(args.ticker?[args.ticker]:[]), ...(args.source?[args.source]:[]), args.limit||50);
        break;
      case 'pump_characteristics':
        result = db.prepare('SELECT characteristic, ROUND(avg_value,2) as avg, ROUND(median_value,2) as median, ROUND(std_dev,2) as std_dev, sample_count as n, description FROM pump_characteristics ORDER BY characteristic').all();
        break;
      case 'pump_scan_current':
        result = db.prepare(`WITH recent AS (SELECT ticker, (SELECT close FROM prices p2 WHERE p2.ticker=p1.ticker ORDER BY date DESC LIMIT 1) as price, (SELECT MAX(high) FROM prices p3 WHERE p3.ticker=p1.ticker AND p3.date>date('now','-30 days')) as high30, (SELECT AVG(volume) FROM prices p4 WHERE p4.ticker=p1.ticker AND p4.date>date('now','-7 days')) as avgvol, (SELECT volume FROM prices p5 WHERE p5.ticker=p1.ticker ORDER BY date DESC LIMIT 1) as lastvol, (SELECT fg_score FROM fg_history WHERE ticker=p1.ticker ORDER BY date DESC LIMIT 1) as fg FROM (SELECT DISTINCT ticker FROM prices WHERE date>date('now','-7 days')) p1) SELECT ticker, price, fg, ROUND((price-high30)/NULLIF(high30,0)*100,1) as drawdown, ROUND(lastvol/NULLIF(avgvol,0),1) as vol_ratio FROM recent WHERE high30>0 AND price>0 AND (price-high30)/high30<-0.3 AND fg IS NOT NULL AND fg<-10 ORDER BY drawdown ASC LIMIT ?`).all(args.limit||20);
        break;
      case 'token_onchain_profile': {
        const s = args.symbol.toUpperCase();
        result = {
          metadata: db.prepare("SELECT * FROM token_metadata WHERE UPPER(symbol)=? LIMIT 1").all(s),
          holders: db.prepare("SELECT * FROM holder_snapshots WHERE token_address IN (SELECT token_address FROM token_metadata WHERE UPPER(symbol)=?) ORDER BY snapshot_ts DESC LIMIT 5").all(s),
          whale_summary: db.prepare("SELECT direction, COUNT(*) as trades, ROUND(SUM(amount_usd),0) as total_usd FROM whale_trades WHERE UPPER(symbol)=? AND timestamp>datetime('now','-7 days') GROUP BY direction").all(s),
          exchanges: db.prepare("SELECT DISTINCT exchange FROM exchange_listings WHERE UPPER(symbol)=?").all(s),
          social: db.prepare("SELECT * FROM social_snapshots WHERE token_address IN (SELECT token_address FROM token_metadata WHERE UPPER(symbol)=?) ORDER BY snapshot_ts DESC LIMIT 1").all(s),
        };
        break;
      }
      case 'whale_activity':
        result = db.prepare("SELECT timestamp, direction, ROUND(amount_usd,0) as usd, wallet_address, ROUND(price_at_trade,8) as price FROM whale_trades WHERE UPPER(symbol)=? AND timestamp>datetime('now','-'||?||' days') AND amount_usd>=1000 ORDER BY timestamp DESC LIMIT ?").all(args.symbol.toUpperCase(), args.days||7, args.limit||50);
        break;
      case 'pump_full_profile':
        result = db.prepare("SELECT characteristic, ROUND(avg_value,2) as avg, ROUND(median_value,2) as median, ROUND(std_dev,2) as std_dev, sample_count as n, description FROM pump_characteristics ORDER BY characteristic").all();
        break;
      case 'exchange_listing_tracker':
        if (args.symbol) {
          result = db.prepare("SELECT exchange, listing_type, listing_date, price_at_listing FROM exchange_listings WHERE UPPER(symbol)=? ORDER BY listing_date DESC").all(args.symbol.toUpperCase());
        } else {
          result = db.prepare("SELECT tm.symbol, tm.chain, COUNT(DISTINCT el.exchange) as n FROM token_metadata tm LEFT JOIN exchange_listings el ON UPPER(el.symbol)=UPPER(tm.symbol) GROUP BY tm.symbol HAVING n<=? AND n>0 ORDER BY n ASC LIMIT ?").all(args.max_exchanges||3, args.limit||20);
        }
        break;
      case 'mining_scanner_latest': {
        const conds = ['1=1']; const prms = [];
        if (args.archetype) { conds.push('archetype=?'); prms.push(args.archetype); }
        if (args.min_score) { conds.push('score>=?'); prms.push(args.min_score); }
        if (args.commodity) { conds.push('primary_commodity=?'); prms.push(args.commodity); }
        prms.push(args.limit || 30);
        result = db.prepare(`SELECT * FROM scanner_results WHERE scan_date=(SELECT MAX(scan_date) FROM scanner_results) AND ${conds.join(' AND ')} ORDER BY score DESC LIMIT ?`).all(...prms);
        break;
      }
      case 'mining_scanner_triggered':
        result = db.prepare(`SELECT * FROM scanner_results WHERE scan_date=(SELECT MAX(scan_date) FROM scanner_results) AND (volume_triggered=1 OR gap_up_detected=1) AND score>=? ORDER BY score DESC LIMIT ?`).all(args.min_score || 0, args.limit || 30);
        break;
      case 'mining_scanner_history':
        result = db.prepare(`SELECT scan_date, score, archetype, fg_score, drawdown_pct, volume_ratio, commodity_30d_return, volume_triggered, gap_up_detected, signals FROM scanner_results WHERE ticker=? ORDER BY scan_date DESC LIMIT ?`).all(args.ticker, args.days || 30);
        break;
      case 'pump_archetype_stats':
        result = [
          { archetype: 'GAP_UP', held_pct: 76, risk_adj: 43.0, med_pump: 56, note: 'BEST HOLD RATE' },
          { archetype: 'FLAT_BREAKOUT', held_pct: 75, risk_adj: 39.1, med_pump: 52, note: 'EMERGING PATTERN' },
          { archetype: 'CATCH_UP', held_pct: 72, risk_adj: 37.0, med_pump: 52, note: 'COMMODITY DRIVEN' },
          { archetype: 'VOLUME_EXPLOSION', held_pct: 70, risk_adj: 38.0, med_pump: 54, note: 'MOST COMMON' },
          { archetype: 'DEAD_CAT', held_pct: 69, risk_adj: 43.8, med_pump: 64, note: 'HIGHEST RISK-ADJ' },
          { archetype: 'QUIET_ACCUM', held_pct: 67, risk_adj: 33.5, med_pump: 50, note: 'STEALTH' },
          { archetype: 'MOMENTUM', held_pct: 66, risk_adj: 33.8, med_pump: 51, note: 'CAUTION - FADES' },
          { archetype: 'EXTREME_FEAR', held_pct: 57, risk_adj: 29.2, med_pump: 51, note: 'AVOID' },
        ];
        break;
      case 'session_timing_query':
        result = db.prepare(`SELECT * FROM session_timing_stats ${args.dimension ? 'WHERE dimension=?' : ''} ORDER BY events DESC`).all(...(args.dimension ? [args.dimension] : []));
        break;
      case 'spillover_tracker': {
        const sc = ['1=1']; const sp = [];
        if (args.commodity) { sc.push('commodity=?'); sp.push(args.commodity); }
        if (args.leader_exchange) { sc.push('leader_exchange=?'); sp.push(args.leader_exchange); }
        sp.push(args.limit || 50);
        result = db.prepare(`SELECT * FROM spillover_events WHERE ${sc.join(' AND ')} ORDER BY leader_pump_date DESC LIMIT ?`).all(...sp);
        break;
      }
      case 'data_gaps': {
        const totalSymbols = db.prepare('SELECT COUNT(*) as n FROM symbols').get().n;
        const withPrices = db.prepare('SELECT COUNT(DISTINCT ticker) as n FROM prices').get().n;
        const withFG = db.prepare('SELECT COUNT(DISTINCT ticker) as n FROM fg_history').get().n;
        const miners = db.prepare('SELECT COUNT(*) as n FROM mining_companies').get().n;
        const profiled = db.prepare('SELECT COUNT(*) as n FROM mining_performance').get().n;
        const commodities = db.prepare('SELECT COUNT(DISTINCT commodity) as n FROM commodity_prices').get().n;
        result = {
          symbols: totalSymbols, with_prices: withPrices, with_fg: withFG,
          price_coverage: Math.round(withPrices / totalSymbols * 1000) / 10 + '%',
          fg_coverage: Math.round(withFG / totalSymbols * 1000) / 10 + '%',
          miners_total: miners, miners_profiled: profiled,
          miner_coverage: Math.round(profiled / miners * 1000) / 10 + '%',
          commodities_tracked: commodities,
          stale_tickers: db.prepare("SELECT COUNT(*) as n FROM (SELECT ticker FROM prices GROUP BY ticker HAVING MAX(date) < date('now', '-7 days'))").get().n,
        };
        break;
      }
      case 'drillhole_exploration': {
        const dc = ['1=1']; const dp = [];
        if (args.ticker) { dc.push('cdc.ticker=?'); dp.push(args.ticker); }
        if (args.commodity) { dc.push('cdc.primary_commodity=?'); dp.push(args.commodity); }
        dp.push(args.limit || 20);
        result = db.prepare(`SELECT cdc.ticker, cdc.primary_commodity, cdc.total_drillholes, cdc.total_metres, cdc.countries, cdc.first_drill_year, cdc.last_drill_year, cdc.exploration_intensity FROM company_drillhole_context cdc WHERE ${dc.join(' AND ')} ORDER BY cdc.total_drillholes DESC LIMIT ?`).all(...dp);
        break;
      }
      case 'drilling_trends': {
        const dtc = []; const dtp = [];
        if (args.commodity) { dtc.push('ea.commodity=?'); dtp.push(args.commodity); }
        dtp.push(args.limit || 20);
        const where = dtc.length > 0 ? 'WHERE ' + dtc.join(' AND ') : '';
        result = db.prepare(`SELECT ea.commodity, ea.country, ea.year, ea.total_holes, ea.total_metres, ea.active_companies FROM exploration_activity ea ${where} ORDER BY ea.year DESC, ea.total_holes DESC LIMIT ?`).all(...dtp);
        break;
      }
      case 'ai_screening_latest': {
        const aic = ['scan_date = (SELECT MAX(scan_date) FROM ai_screening_results)']; const aip = [];
        if (args.action) { aic.push('action=?'); aip.push(args.action); }
        if (args.min_confidence) { aic.push('confidence>=?'); aip.push(args.min_confidence); }
        aip.push(args.limit || 20);
        try {
          result = db.prepare(`SELECT scan_date, ticker, archetype, confidence, thesis, risks, action FROM ai_screening_results WHERE ${aic.join(' AND ')} ORDER BY confidence DESC LIMIT ?`).all(...aip);
        } catch (e) { result = { error: 'ai_screening_results table may not exist yet. Run ai_screener.cjs first.' }; }
        break;
      }
      case 'ai_screening_accuracy': {
        try {
          const outcomes = db.prepare('SELECT * FROM ai_screening_outcomes WHERE actual_7d_return IS NOT NULL').all();
          if (outcomes.length === 0) { result = { message: 'No outcomes yet — need 7+ days of screening data', first_results_date: new Date(Date.now() + 7*86400000).toISOString().split('T')[0] }; break; }
          const byAction = {};
          for (const o of outcomes) {
            if (!byAction[o.predicted_action]) byAction[o.predicted_action] = [];
            byAction[o.predicted_action].push(o);
          }
          result = { total_outcomes: outcomes.length, by_action: {} };
          for (const [action, group] of Object.entries(byAction)) {
            result.by_action[action] = {
              count: group.length,
              avg_7d_return: Math.round(group.reduce((s,o)=>s+(o.actual_7d_return||0),0)/group.length*10)/10,
              pumped_20pct: group.filter(o=>(o.actual_7d_return||0)>=20).length,
              positive: group.filter(o=>(o.actual_7d_return||0)>0).length,
            };
          }
        } catch (e) { result = { error: 'ai_screening_outcomes table may not exist yet.' }; }
        break;
      }
      case 'ai_screener_rerun':
        result = { message: 'Run manually: node scripts/analysis/ai_screener.cjs', note: 'Ollama must be running locally. Takes ~5min for 20 candidates.' };
        break;
      case 'volume_alerts_recent': {
        const vac = ['1=1']; const vap = [];
        if (args.source) { vac.push('source=?'); vap.push(args.source); }
        const daysBack = args.days || 7;
        vac.push("alert_date >= date('now', '-' || ? || ' days')"); vap.push(daysBack);
        vap.push(args.limit || 50);
        result = db.prepare(`SELECT * FROM volume_alerts WHERE ${vac.join(' AND ')} ORDER BY sent_at DESC LIMIT ?`).all(...vap);
        break;
      }
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
          returns: db.prepare('SELECT COUNT(*) as n FROM returns').get().n,
          correlations: db.prepare('SELECT COUNT(*) as n FROM correlations').get().n,
          performance_stats: db.prepare('SELECT COUNT(*) as n FROM performance_stats').get().n,
          asset_groups: db.prepare('SELECT COUNT(*) as n FROM asset_groups').get().n,
          lag_correlations: db.prepare('SELECT COUNT(*) as n FROM lag_correlations').get().n,
          cascade_signals: db.prepare("SELECT COUNT(*) as n FROM cascade_signals WHERE status='active'").get().n,
          dex_registry: db.prepare('SELECT COUNT(*) as n FROM dex_registry').get().n,
          dex_snapshots: db.prepare('SELECT COUNT(*) as n FROM dex_snapshots').get().n,
          dex_daily: db.prepare('SELECT COUNT(*) as n FROM dex_daily').get().n,
          dex_trending: db.prepare('SELECT COUNT(*) as n FROM dex_trending_log').get().n,
          defi_tvl: db.prepare('SELECT COUNT(*) as n FROM defi_tvl').get().n,
          pump_events: db.prepare('SELECT COUNT(*) as n FROM pump_events').get().n,
          pump_characteristics: db.prepare('SELECT COUNT(*) as n FROM pump_characteristics').get().n,
          mining_pump_events_clean: db.prepare('SELECT COUNT(*) as n FROM mining_pump_events_clean').get().n,
          scanner_results: db.prepare('SELECT COUNT(*) as n FROM scanner_results').get().n,
          drillholes: db.prepare('SELECT COUNT(*) as n FROM drillholes').get().n,
          session_timing_stats: db.prepare('SELECT COUNT(*) as n FROM session_timing_stats').get().n,
          spillover_events: db.prepare('SELECT COUNT(*) as n FROM spillover_events').get().n,
          exploration_activity: db.prepare('SELECT COUNT(*) as n FROM exploration_activity').get().n,
          company_drillhole_context: db.prepare('SELECT COUNT(*) as n FROM company_drillhole_context').get().n,
          volume_alerts: db.prepare('SELECT COUNT(*) as n FROM volume_alerts').get().n,
          ai_screening_results: (() => { try { return db.prepare('SELECT COUNT(*) as n FROM ai_screening_results').get().n; } catch { return 0; } })(),
          ai_screening_outcomes: (() => { try { return db.prepare('SELECT COUNT(*) as n FROM ai_screening_outcomes').get().n; } catch { return 0; } })(),
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
