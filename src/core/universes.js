/**
 * Universe list manager — full tradeable instrument lists for all markets.
 *
 * Cached at ~/.tradingview-mcp/universes/ with 7-day auto-refresh.
 * Sources: Twelve Data (stocks), CoinGecko (crypto), ASX CSV.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const UNI_DIR = join(homedir(), '.tradingview-mcp', 'universes');
const REFRESH_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function ensureDir() {
  if (!existsSync(UNI_DIR)) mkdirSync(UNI_DIR, { recursive: true });
}

function isStale(file) {
  if (!existsSync(file)) return true;
  return (Date.now() - statSync(file).mtimeMs) > REFRESH_MS;
}

function loadList(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { return null; }
}

function saveList(file, data) {
  ensureDir();
  writeFileSync(file, JSON.stringify(data));
}

async function fetchJSON(url, timeout = 10000) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) return null;
  return r.json();
}

// ─── US Stocks ──────────────────────────────────────────────────────────────

const US_FILE = join(UNI_DIR, 'us_stocks.json');

export async function getUSStocks(forceRefresh = false) {
  if (!forceRefresh && !isStale(US_FILE)) {
    const cached = loadList(US_FILE);
    if (cached?.length > 0) return cached;
  }

  const symbols = [];

  // Fetch NYSE + NASDAQ common stocks from Twelve Data
  for (const exchange of ['NYSE', 'NASDAQ']) {
    const d = await fetchJSON(`https://api.twelvedata.com/stocks?exchange=${exchange}&type=Common%20Stock`);
    if (d?.data) {
      for (const s of d.data) {
        symbols.push({ symbol: s.symbol, name: s.name, exchange, type: s.type });
      }
    }
  }

  // Also add popular ETFs
  const etfs = ['SPY','QQQ','DIA','IWM','VOO','VTI','ARKK','XLF','XLE','XLK','XLV',
    'TQQQ','SQQQ','UPRO','TLT','GLD','SLV','USO','UVXY','VXX','SOXX','SMH',
    'XBI','IBB','IYR','HYG','LQD','EMB','EEM','FXI','EWJ','EWZ','EWA'];
  for (const sym of etfs) {
    if (!symbols.find(s => s.symbol === sym)) {
      symbols.push({ symbol: sym, name: sym, exchange: 'ETF', type: 'ETF' });
    }
  }

  saveList(US_FILE, symbols);
  return symbols;
}

// ─── ASX Stocks ─────────────────────────────────────────────────────────────

const ASX_FILE = join(UNI_DIR, 'asx_stocks.json');

export async function getASXStocks(forceRefresh = false) {
  if (!forceRefresh && !isStale(ASX_FILE)) {
    const cached = loadList(ASX_FILE);
    if (cached?.length > 0) return cached;
  }

  const symbols = [];

  // Try ASX CSV first
  try {
    const r = await fetch('https://www.asx.com.au/asx/research/ASXListedCompanies.csv', {
      signal: AbortSignal.timeout(10000),
    });
    if (r.ok) {
      const text = await r.text();
      const lines = text.split('\n');
      for (let i = 3; i < lines.length; i++) { // Skip header lines
        const line = lines[i].trim();
        if (!line) continue;
        // CSV format: "Company Name","ASX Code","GICS Industry Group"
        const match = line.match(/"([^"]+)","([^"]+)","([^"]*)"/);
        if (match) {
          symbols.push({
            symbol: match[2] + '.AX',
            name: match[1],
            sector: match[3],
            exchange: 'ASX',
          });
        }
      }
    }
  } catch { /* fallback to Twelve Data */ }

  // Fallback: Twelve Data
  if (symbols.length < 100) {
    const d = await fetchJSON('https://api.twelvedata.com/stocks?exchange=ASX&type=Common%20Stock');
    if (d?.data) {
      for (const s of d.data) {
        symbols.push({ symbol: s.symbol + '.AX', name: s.name, exchange: 'ASX', type: s.type });
      }
    }
  }

  saveList(ASX_FILE, symbols);
  return symbols;
}

// ─── Crypto Tokens ──────────────────────────────────────────────────────────

const CRYPTO_FILE = join(UNI_DIR, 'crypto_tokens.json');

export async function getCryptoTokens(forceRefresh = false) {
  if (!forceRefresh && !isStale(CRYPTO_FILE)) {
    const cached = loadList(CRYPTO_FILE);
    if (cached?.length > 0) return cached;
  }

  const tokens = [];
  const stables = new Set(['USDT','USDC','DAI','BUSD','TUSD','FDUSD','USDS','USDE','PYUSD','USD0','USDG','RLUSD','USD1']);

  // Get top 1000 from CoinGecko (4 pages × 250)
  for (let page = 1; page <= 4; page++) {
    const d = await fetchJSON(
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}`,
      15000,
    );
    if (!d || !Array.isArray(d)) break;
    for (const coin of d) {
      const sym = coin.symbol?.toUpperCase();
      if (!sym || stables.has(sym)) continue;
      tokens.push({
        symbol: sym,
        name: coin.name,
        market_cap: coin.market_cap,
        rank: coin.market_cap_rank,
        price: coin.current_price,
        volume_24h: coin.total_volume,
      });
    }
    if (page < 4) await new Promise(r => setTimeout(r, 1500)); // CoinGecko rate limit
  }

  saveList(CRYPTO_FILE, tokens);
  return tokens;
}

// ─── Presets ────────────────────────────────────────────────────────────────

// S&P 500 — curated list of the largest US companies
const SP500_CORE = [
  'AAPL','MSFT','AMZN','NVDA','GOOG','META','TSLA','BRK-B','AVGO','LLY',
  'JPM','V','UNH','XOM','MA','COST','HD','PG','JNJ','ABBV',
  'WMT','NFLX','BAC','CRM','ORCL','CVX','MRK','KO','PEP','AMD',
  'TMO','CSCO','ADBE','ACN','ABT','MCD','INTC','IBM','DHR','QCOM',
  'INTU','ISRG','GE','VZ','TXN','BKNG','PFE','RTX','AMGN','LMT',
  'NOW','AMAT','GS','BLK','CAT','HON','LOW','DE','PLTR','T',
  'MS','LRCX','AXP','NEE','UBER','CI','DIS','BA','BMY','SO',
  'DUK','SLB','WFC','SCHW','PLD','CME','MCO','MU','PYPL','SQ',
  'SHOP','COIN','SNOW','CRWD','DDOG','PANW','ZS','ABNB','COP','HAL',
  'SPG','AMT','CCI','WELL','DLR','PSA','O','VICI','SYK','BSX',
];

const ASX_MINING = [
  'BHP.AX','RIO.AX','FMG.AX','S32.AX','MIN.AX','IGO.AX','SFR.AX','NST.AX','EVN.AX','RMS.AX',
  'PLS.AX','LTR.AX','PDN.AX','DYL.AX','BMN.AX','LOT.AX','PEN.AX','BOE.AX','ERA.AX','AGE.AX',
  'DEV.AX','WR1.AX','CHR.AX','CMM.AX','LYC.AX','ILU.AX','NHC.AX','WHC.AX','STO.AX','WDS.AX',
  'NEM.AX','GOR.AX','RED.AX','CIA.AX','CRN.AX','SYR.AX','TIE.AX','ALK.AX','CXO.AX','LKE.AX',
  'VUL.AX','PLL.AX','ARU.AX','SYA.AX','GT1.AX','FFX.AX','KAI.AX','WGX.AX','GCY.AX','NVA.AX',
];

/**
 * Get symbols for a preset universe.
 */
export async function getPreset(preset) {
  switch (preset) {
    case 'sp500':
      return { symbols: SP500_CORE, market: 'us', name: 'S&P 500 Core' };

    case 'asx_mining':
      return { symbols: ASX_MINING, market: 'asx', name: 'ASX Mining & Resources' };

    case 'asx_200': {
      const all = await getASXStocks();
      return { symbols: all.slice(0, 200).map(s => s.symbol), market: 'asx', name: 'ASX 200' };
    }

    case 'asx_full': {
      const all = await getASXStocks();
      return { symbols: all.map(s => s.symbol), market: 'asx', name: 'ASX Full' };
    }

    case 'us_full': {
      const all = await getUSStocks();
      return { symbols: all.map(s => s.symbol), market: 'us', name: 'US Full' };
    }

    case 'crypto_1000': {
      const all = await getCryptoTokens();
      return { symbols: all.slice(0, 1000).map(t => t.symbol), market: 'crypto', name: 'Crypto Top 1000' };
    }

    case 'crypto_full': {
      const all = await getCryptoTokens();
      return { symbols: all.map(t => t.symbol), market: 'crypto', name: 'Crypto Full' };
    }

    default:
      throw new Error(`Unknown preset: ${preset}. Available: sp500, asx_mining, asx_200, asx_full, us_full, crypto_1000, crypto_full`);
  }
}

/**
 * Get universe stats.
 */
export async function getUniverseStats() {
  const us = await getUSStocks().catch(() => []);
  const asx = await getASXStocks().catch(() => []);
  const crypto = await getCryptoTokens().catch(() => []);

  return {
    us_stocks: us.length,
    asx_stocks: asx.length,
    crypto_tokens: crypto.length,
    total: us.length + asx.length + crypto.length,
    us_file: US_FILE,
    asx_file: ASX_FILE,
    crypto_file: CRYPTO_FILE,
  };
}
