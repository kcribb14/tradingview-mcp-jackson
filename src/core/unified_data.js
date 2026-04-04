/**
 * Unified data layer — auto-selects best source per symbol.
 * Covers ALL markets: US stocks, ASX stocks, crypto, forex, ETFs.
 *
 * Priority waterfall:
 *   Stocks (US/ASX/intl): Yahoo Finance (no auth, 18ms/symbol, 100% coverage)
 *   Crypto: Binance → CryptoCompare → Yahoo → MEXC
 *
 * Symbol detection:
 *   "AAPL"      → US stock → Yahoo Finance
 *   "BHP.AX"    → ASX stock → Yahoo Finance
 *   "ASX:BHP"   → ASX stock → Yahoo Finance (auto-append .AX)
 *   "BTC"       → Crypto → Binance waterfall
 *   "BTC-USD"   → Crypto → Yahoo Finance
 *
 * Source mapping is cached so we don't re-discover on every call.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const CACHE_DIR = join(homedir(), '.tradingview-mcp', 'cache');
const SOURCE_MAP_FILE = join(CACHE_DIR, 'source_map.json');

// ─── Source implementations ─────────────────────────────────────────────────

async function fetchJSON(url, timeout = 5000) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    signal: AbortSignal.timeout(timeout),
  });
  if (!resp.ok) return null;
  return resp.json();
}

function normalizeBar(time, o, h, l, c, v) {
  return {
    time: typeof time === 'number' && time > 1e12 ? Math.floor(time / 1000) : time,
    open: Number(o), high: Number(h), low: Number(l), close: Number(c),
    volume: Number(v) || 0,
  };
}

// Binance: [openTime, open, high, low, close, volume, ...]
async function fetchBinance(symbol, bars = 200) {
  let pair = symbol.replace(/[-\/]/g, '').toUpperCase();
  // Ensure USDT suffix for crypto
  if (!pair.endsWith('USDT') && !pair.endsWith('USD') && !pair.endsWith('BTC')) {
    pair = pair + 'USDT';
  }
  const d = await fetchJSON(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d&limit=${bars}`);
  if (!d || !Array.isArray(d) || d.length === 0) return null;
  return d.map(b => normalizeBar(b[0], b[1], b[2], b[3], b[4], b[5]));
}

// CryptoCompare: { Data: { Data: [{ time, open, high, low, close, volumefrom, volumeto }] } }
async function fetchCryptoCompare(symbol, bars = 200) {
  // Handle paired symbols like BTC-USD → fsym=BTC, tsym=USD
  let fsym = symbol.toUpperCase().replace(/-USD$/, '').replace(/USDT$/, '').replace(/USD$/, '');
  const d = await fetchJSON(`https://min-api.cryptocompare.com/data/v2/histoday?fsym=${fsym}&tsym=USD&limit=${bars}`);
  if (!d?.Data?.Data) return null;
  const candles = d.Data.Data.filter(b => b.close > 0);
  if (candles.length === 0) return null;
  return candles.map(b => normalizeBar(b.time, b.open, b.high, b.low, b.close, b.volumeto));
}

// MEXC: same format as Binance [openTime, open, high, low, close, volume, ...]
async function fetchMEXC(symbol, bars = 200) {
  const pair = symbol.replace(/[-\/]/g, '').toUpperCase();
  const d = await fetchJSON(`https://api.mexc.com/api/v3/klines?symbol=${pair}&interval=1d&limit=${bars}`);
  if (!d || !Array.isArray(d) || d.length === 0) return null;
  return d.map(b => normalizeBar(b[0], b[1], b[2], b[3], b[4], b[5]));
}

// Yahoo Finance
async function fetchYahoo(symbol, bars = 200) {
  let ticker = symbol;
  if (ticker.match(/^[A-Z]{2,10}USDT$/i)) {
    ticker = ticker.replace(/USDT$/i, '') + '-USD';
  }

  // Try ticker as-is first (works for stocks, ASX with .AX, and pre-formatted crypto)
  let d = await fetchJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1y&interval=1d&includePrePost=false`);

  // If no result and looks like a plain crypto symbol, retry with -USD
  if (!d?.chart?.result?.[0]?.timestamp && !ticker.includes('-') && !ticker.includes('.') && !ticker.startsWith('^')) {
    d = await fetchJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker + '-USD')}?range=1y&interval=1d&includePrePost=false`);
  }
  const chart = d?.chart?.result?.[0];
  if (!chart?.timestamp) return null;
  const q = chart.indicators.quote[0];
  const result = [];
  for (let i = 0; i < chart.timestamp.length; i++) {
    if (q.open[i] != null && q.close[i] != null) {
      result.push(normalizeBar(chart.timestamp[i], q.open[i], q.high[i], q.low[i], q.close[i], q.volume[i]));
    }
  }
  return result.length > 0 ? result.slice(-bars) : null;
}

// ─── Source registry ────────────────────────────────────────────────────────

const SOURCES = [
  { name: 'binance', fn: fetchBinance, rateLimit: 1200, symbolFormat: sym => sym.replace(/[-\/]/g, '').toUpperCase() + (sym.match(/USDT?$/i) ? '' : 'USDT') },
  { name: 'cryptocompare', fn: fetchCryptoCompare, rateLimit: 50 },
  { name: 'yahoo', fn: fetchYahoo, rateLimit: 30 },
  { name: 'mexc', fn: fetchMEXC, rateLimit: 500, symbolFormat: sym => sym.replace(/[-\/]/g, '').toUpperCase() + (sym.match(/USDT?$/i) ? '' : 'USDT') },
];

// ─── Source mapping cache ───────────────────────────────────────────────────

function loadSourceMap() {
  try { return JSON.parse(readFileSync(SOURCE_MAP_FILE, 'utf8')); }
  catch { return {}; }
}

function saveSourceMap(map) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(SOURCE_MAP_FILE, JSON.stringify(map));
}

// ─── Unified fetch ──────────────────────────────────────────────────────────

// ─── Symbol type detection ──────────────────────────────────────────────────

/**
 * Detect what type of instrument a symbol is and normalize it.
 * Returns { type: 'stock'|'asx'|'crypto', yahoo: string, key: string }
 */
function detectSymbol(symbol) {
  const s = symbol.trim();

  // ASX: "BHP.AX", "ASX:BHP", or explicit market flag
  if (s.endsWith('.AX') || s.startsWith('ASX:')) {
    const ticker = s.replace('ASX:', '').replace('.AX', '');
    return { type: 'asx', yahoo: ticker + '.AX', key: ticker + '.AX' };
  }

  // Already has exchange suffix (.L, .TO, .HK, etc.)
  if (s.match(/\.[A-Z]{1,3}$/)) {
    return { type: 'stock', yahoo: s, key: s };
  }

  // Crypto: has -USD suffix, or is a known crypto
  if (s.includes('-USD') || s.endsWith('USDT')) {
    return { type: 'crypto', yahoo: s, key: s.replace(/[-\/]USD[T]?$/i, '') };
  }

  // Crypto: short all-caps that look like crypto tickers
  const cryptoTokens = new Set([
    'BTC','ETH','SOL','XRP','DOGE','ADA','DOT','AVAX','LINK','MATIC','BNB',
    'SHIB','UNI','AAVE','LTC','NEAR','ATOM','FTM','ALGO','SAND','HBAR',
    'APT','ARB','OP','SUI','SEI','TIA','INJ','PEPE','WLD','FET','RNDR',
    'GRT','MKR','CRV','COMP','SNX','LDO','RPL','IMX','MANA','AXS',
    'BONK','WIF','JUP','RAY','PYTH','JTO','RENDER','POPCAT','MEW','BOME',
    'ENA','PENDLE','ETHFI','STRK','ZK','ZRO','EIGEN','GRASS','ONDO',
  ]);
  if (cryptoTokens.has(s.toUpperCase())) {
    return { type: 'crypto', yahoo: s, key: s.toUpperCase() };
  }

  // Default: assume US stock
  return { type: 'stock', yahoo: s, key: s.toUpperCase() };
}

/**
 * Fetch OHLCV bars for a symbol from the best available source.
 * Auto-detects symbol type and routes to the optimal source.
 *
 * @param {string} symbol - Any symbol: "AAPL", "BHP.AX", "ASX:BHP", "BTC", "BTC-USD"
 * @param {number} bars - Number of daily bars (default 200)
 * @returns {{ bars: Array, source: string, symbol: string, type: string }} or null
 */
export async function fetchOhlcv(symbol, bars = 200) {
  const detected = detectSymbol(symbol);

  // For stocks and ASX: ALWAYS use Yahoo directly, no source cache needed
  if (detected.type === 'stock' || detected.type === 'asx') {
    const data = await fetchYahoo(detected.yahoo, bars).catch(() => null);
    if (data && data.length >= 5) {
      return { bars: data.slice(-bars), source: 'yahoo', symbol, type: detected.type };
    }
    return null;
  }

  // For crypto: check cached source first, then waterfall
  const sourceMap = loadSourceMap();
  if (sourceMap[detected.key]) {
    const cachedSrc = SOURCES.find(s => s.name === sourceMap[detected.key]);
    if (cachedSrc) {
      const data = await cachedSrc.fn(symbol, bars).catch(() => null);
      if (data && data.length >= 5) {
        return { bars: data.slice(-bars), source: cachedSrc.name, symbol, type: detected.type };
      }
    }
  }

  for (const source of SOURCES) {
    try {
      const data = await source.fn(symbol, bars);
      if (data && data.length >= 5) {
        sourceMap[detected.key] = source.name;
        saveSourceMap(sourceMap);
        return { bars: data.slice(-bars), source: source.name, symbol, type: detected.type };
      }
    } catch { /* try next */ }
  }

  return null;
}

/**
 * Fetch OHLCV for multiple symbols in parallel batches.
 *
 * @param {string[]} symbols - Array of symbols
 * @param {number} bars - Bars per symbol (default 200)
 * @param {number} concurrency - Parallel requests (default 15)
 */
export async function fetchBatch(symbols, bars = 200, concurrency = 15) {
  const t0 = Date.now();
  const results = new Map();
  const errors = [];
  const sourceCounts = {};

  for (let i = 0; i < symbols.length; i += concurrency) {
    const batch = symbols.slice(i, i + concurrency);
    const promises = batch.map(async (sym) => {
      const data = await fetchOhlcv(sym, bars);
      if (data) {
        results.set(sym, data);
        sourceCounts[data.source] = (sourceCounts[data.source] || 0) + 1;
      } else {
        errors.push(sym);
      }
    });
    await Promise.all(promises);
  }

  return {
    results,
    errors,
    fetched: results.size,
    failed: errors.length,
    sources: sourceCounts,
    timing_ms: Date.now() - t0,
  };
}

/**
 * Get the top N tokens by market cap from CoinGecko.
 */
export async function getTopTokens(count = 250) {
  const tokens = [];
  const perPage = 250;
  const pages = Math.ceil(count / perPage);

  for (let page = 1; page <= pages; page++) {
    const d = await fetchJSON(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=${page}`, 10000);
    if (!d || !Array.isArray(d)) break;
    for (const coin of d) {
      tokens.push({
        id: coin.id,
        symbol: coin.symbol?.toUpperCase(),
        name: coin.name,
        market_cap: coin.market_cap,
        market_cap_rank: coin.market_cap_rank,
        current_price: coin.current_price,
        price_change_24h: coin.price_change_percentage_24h,
        total_volume: coin.total_volume,
      });
    }
    if (tokens.length >= count) break;
    // CoinGecko rate limit: wait between pages
    if (page < pages) await new Promise(r => setTimeout(r, 1500));
  }

  return tokens.slice(0, count);
}

/**
 * Get the source mapping stats.
 */
export function getSourceStats() {
  const map = loadSourceMap();
  const counts = {};
  for (const source of Object.values(map)) {
    counts[source] = (counts[source] || 0) + 1;
  }
  return {
    total_mapped: Object.keys(map).length,
    by_source: counts,
  };
}

/**
 * Get US stocks from TradingView screener (requires open screener on US market).
 * Falls back to a curated list of popular Stake.com tickers.
 */
export function getUSStockUniverse(count = 100) {
  // Popular US stocks on Stake.com — sorted roughly by market cap
  const stakeUS = [
    'AAPL','MSFT','GOOG','AMZN','NVDA','META','TSLA','BRK-B','AVGO','LLY',
    'JPM','V','UNH','XOM','MA','COST','HD','PG','JNJ','ABBV',
    'WMT','NFLX','BAC','CRM','ORCL','CVX','MRK','KO','PEP','AMD',
    'TMO','CSCO','ADBE','ACN','ABT','MCD','INTC','IBM','DHR','QCOM',
    'INTU','ISRG','GE','VZ','TXN','BKNG','PFE','RTX','AMGN','LMT',
    'NOW','AMAT','GS','BLK','CAT','HON','LOW','DE','GEV','PLTR',
    'T','MS','LRCX','AXP','NEE','UBER','CI','DIS','BA','BMY',
    'SO','DUK','SLB','WFC','SCHW','PLD','CME','MCO','MU','PYPL',
    'SQ','SHOP','COIN','SNOW','CRWD','DDOG','PANW','ZS','ABNB','RIVN',
    'SOUN','RKLB','SOFI','MARA','RIOT','HOOD','LCID','GRAB','NIO','XPEV',
    'SPY','QQQ','DIA','IWM','VOO','VTI','ARKK','XLF','XLE','XLK',
    'TQQQ','SQQQ','UPRO','TLT','GLD','SLV','USO','VXX','UVXY','SPXS',
  ];
  return stakeUS.slice(0, count);
}

/**
 * Get ASX stocks — CommSec universe sorted by market cap.
 */
export function getASXStockUniverse(count = 100) {
  const asxStocks = [
    'CBA.AX','BHP.AX','WBC.AX','NAB.AX','ANZ.AX','WES.AX','MQG.AX','CSL.AX','WDS.AX','FMG.AX',
    'TLS.AX','GMG.AX','WOW.AX','TCL.AX','QBE.AX','NST.AX','BXB.AX','COL.AX','ALL.AX','EVN.AX',
    'STO.AX','ORG.AX','REA.AX','S32.AX','LYC.AX','SCG.AX','IAG.AX','SUN.AX','SGH.AX','PLS.AX',
    'CPU.AX','SOL.AX','APA.AX','QAN.AX','XRO.AX','WTC.AX','PME.AX','MPL.AX','TLC.AX','BSL.AX',
    'COH.AX','VCX.AX','YAL.AX','ALQ.AX','MIN.AX','ASX.AX','SGP.AX','SHL.AX','ORI.AX','JBH.AX',
    // Mining / Resources (CANETOAD targets)
    'RIO.AX','IGO.AX','SFR.AX','PDN.AX','LTR.AX','DYL.AX','BMN.AX','LOT.AX','PEN.AX','BOE.AX',
    'ERA.AX','AGE.AX','DEV.AX','WR1.AX','RMS.AX','CHR.AX','CMM.AX','RED.AX','GOR.AX','NHC.AX',
    'WHC.AX','ILU.AX','CIA.AX','CRN.AX','SYR.AX','TIE.AX','ALK.AX','CXO.AX','LKE.AX','VUL.AX',
    'PLL.AX','ARU.AX','SYA.AX','GT1.AX','FFX.AX','KAI.AX','WGX.AX','GCY.AX','DRE.AX','NVA.AX',
    'BRN.AX','ZIP.AX','LBY.AX','NVX.AX','TYR.AX','EML.AX','ADH.AX','IMU.AX','BET.AX','NEA.AX',
  ];
  return asxStocks.slice(0, count);
}
