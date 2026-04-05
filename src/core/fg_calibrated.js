/**
 * Calibrated F&G system — asset-class-specific thresholds.
 *
 * Instead of fixed -25/-35 thresholds for all instruments, uses
 * percentile-based thresholds calibrated to each asset class's
 * volatility profile.
 *
 * US Large Caps: rare fear at -14 (10th percentile)
 * Crypto Mid-caps: rare fear at -30 (10th percentile)
 *
 * The SIGNAL fires when F&G drops to a level that's actually
 * rare for THAT asset class, not a universal number.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Load CoinGecko universe for dynamic crypto detection
let _cgSet = null;
function getCryptoSet() {
  if (_cgSet) return _cgSet;
  _cgSet = new Set();
  try {
    const file = join(homedir(), '.tradingview-mcp', 'universes', 'crypto_tokens.json');
    if (existsSync(file)) {
      const tokens = JSON.parse(readFileSync(file, 'utf8'));
      for (const t of tokens) {
        if (t.symbol) _cgSet.add(t.symbol.toUpperCase());
      }
    }
  } catch {}
  return _cgSet;
}

const THRESHOLDS_FILE = join(homedir(), '.tradingview-mcp', 'config', 'fg_thresholds.json');

// Default thresholds (from 106-symbol profiling on 2026-04-04)
const DEFAULTS = {
  US_LARGE_CAP:      { extreme_fear: -14, fear: -7,  greed: 7,  extreme_greed: 14, avg: -1,  stddev: 10 },
  US_MID_SMALL:      { extreme_fear: -29, fear: -23, greed: -1, extreme_greed: 10, avg: -11, stddev: 14 },
  ASX_TOP50:         { extreme_fear: -12, fear: -5,  greed: 10, extreme_greed: 15, avg: 2,   stddev: 10 },
  ASX_MINING_MID:    { extreme_fear: -13, fear: -3,  greed: 12, extreme_greed: 17, avg: 3,   stddev: 12 },
  ASX_MINING_MICRO:  { extreme_fear: -26, fear: -17, greed: 9,  extreme_greed: 15, avg: -5,  stddev: 15 },
  CRYPTO_MAJOR:      { extreme_fear: -28, fear: -21, greed: 2,  extreme_greed: 10, avg: -9,  stddev: 14 },
  CRYPTO_MID:        { extreme_fear: -30, fear: -25, greed: -4, extreme_greed: 7,  avg: -13, stddev: 14 },
  COMMODITIES:       { extreme_fear: -13, fear: -2,  greed: 15, extreme_greed: 20, avg: 6,   stddev: 13 },
  ETFS:              { extreme_fear: -7,  fear: -1,  greed: 12, extreme_greed: 18, avg: 5,   stddev: 10 },
};

function loadThresholds() {
  try { return JSON.parse(readFileSync(THRESHOLDS_FILE, 'utf8')); }
  catch { return DEFAULTS; }
}

// ─── Asset class detection ──────────────────────────────────────────────────

const CRYPTO_MAJORS = new Set(['BTC','ETH','SOL','XRP','BNB','DOGE','ADA','USDT','USDC']);
let _usStockSet = null;

const largeCap = new Set(['AAPL','MSFT','GOOG','AMZN','NVDA','META','TSLA','BRK-B','AVGO','LLY',
  'JPM','V','UNH','XOM','MA','COST','HD','PG','JNJ','ABBV','WMT','NFLX','BAC','CRM','ORCL',
  'CVX','MRK','KO','PEP','AMD','TMO','CSCO','ADBE','ACN','ABT','MCD','IBM','DHR','QCOM',
  'INTU','ISRG','GE','VZ','TXN','BKNG','PFE','RTX','AMGN','LMT','NOW','AMAT','GS','BLK',
  'CAT','HON','LOW','DE','BA','DIS','CI','BMY','SO','DUK','NEE','WFC','SCHW','CME','MCO']);

const etfs = new Set(['SPY','QQQ','DIA','IWM','VOO','VTI','ARKK','GDX','GDXJ','SIL','URA','LIT','PICK',
  'GLD','SLV','USO','UNG','TLT','SHY','IEF','AGG','HYG','LQD','TQQQ','SQQQ','UPRO','BITO','MSTR',
  'XLK','XLV','XLF','XLE','XLI','XLU','XLP','XLY','XLB','XLRE','XLC','EWA','EWJ','FXI','EWZ','SOXX']);

/**
 * Determine the asset class for a symbol.
 */
export function detectAssetClass(symbol) {
  const s = symbol.toUpperCase();

  if (s.endsWith('=X')) return 'FOREX';
  if (s.endsWith('=F')) return 'COMMODITIES';
  if (s.startsWith('^')) return 'INDICES';

  // ASX stocks
  if (s.endsWith('.AX')) {
    // Check if mining micro-cap (from our list)
    const microMiners = new Set(['DEV','WR1','CHR','LOT','CMM','AGE','BOE','PEN','DYL','BMN','ERA','NVA',
      'FFX','KAI','WGX','GCY','DRE','GT1','SYA','ARU','PLL','VUL','LKE','CXO','ALK','TIE','SYR','CRN','CIA']);
    const midMiners = new Set(['NST','EVN','PLS','LTR','PDN','IGO','SFR','S32','MIN','RMS','LYC','ILU','NHC','WHC']);
    const ticker = s.replace('.AX', '');
    if (microMiners.has(ticker)) return 'ASX_MINING_MICRO';
    if (midMiners.has(ticker)) return 'ASX_MINING_MID';
    // Top 50 by market cap
    const top50 = new Set(['BHP','RIO','CBA','WBC','NAB','ANZ','CSL','WES','MQG','FMG','TLS','GMG','WOW',
      'TCL','QBE','BXB','COL','ALL','STO','WDS','ORG','REA','LYC','SCG','IAG','SUN','SGH','CPU',
      'QAN','XRO','WTC','PME','MPL','TLC','BSL','COH','VCX','YAL','ALQ','ASX','SGP','SHL','ORI','JBH']);
    if (top50.has(ticker)) return 'ASX_TOP50';
    return 'ASX_MINING_MICRO'; // Default ASX to micro (conservative)
  }

  // International stocks
  if (s.match(/\.(L|TO|HK|T|DE|SI|JO|SA|KS)$/)) return 'US_LARGE_CAP'; // Use large-cap profile for intl

  // Crypto
  const base = s.replace(/-USD[T]?$/i, '').replace(/USDT$/i, '');
  if (CRYPTO_MAJORS.has(base)) return 'CRYPTO_MAJOR';

  // Known crypto tokens (hardcoded set + dynamic CoinGecko universe)
  const cryptoTokens = new Set(['AVAX','LINK','DOT','UNI','AAVE','NEAR','ATOM','FTM','ALGO','SAND','HBAR',
    'APT','ARB','OP','SUI','SEI','TIA','INJ','PEPE','WLD','FET','RNDR','GRT','MKR','CRV','COMP','SNX',
    'LDO','RPL','IMX','MANA','AXS','BONK','WIF','JUP','RAY','PYTH','POPCAT','MEW','BOME','ENA',
    'PENDLE','ETHFI','STRK','ZK','ZRO','EIGEN','GRASS','ONDO','LTC','SHIB','MATIC']);
  if (cryptoTokens.has(base)) return 'CRYPTO_MID';

  // Dynamic: check CoinGecko universe — but only if NOT a known stock/ETF
  // CoinGecko has symbols like COIN, AI, NET that collide with stock tickers
  const cgSet = getCryptoSet();
  if (cgSet.has(base) && !s.endsWith('.AX') && !s.endsWith('.L') && !s.endsWith('.TO') && base.length <= 6) {
    // Check against known stocks + ETFs first — stocks win over crypto
    if (!largeCap.has(s) && !etfs.has(s)) {
      // Also skip if it looks like a US stock ticker (1-4 uppercase letters that's also on NASDAQ/NYSE)
      // Heuristic: if the symbol is in our US stock universe file, treat as stock
      if (!_usStockSet) {
        _usStockSet = new Set();
        try {
          const f = join(homedir(), '.tradingview-mcp', 'universes', 'us_stocks.json');
          if (existsSync(f)) {
            const stocks = JSON.parse(readFileSync(f, 'utf8'));
            for (const st of stocks) if (st.symbol) _usStockSet.add(st.symbol.toUpperCase());
          }
        } catch {}
      }
      if (!_usStockSet.has(s)) return 'CRYPTO_MID';
    }
  }

  // ETFs
  if (etfs.has(s)) return 'ETFS';

  // US stocks — check if likely large cap
  if (largeCap.has(s)) return 'US_LARGE_CAP';

  return 'US_MID_SMALL';
}

/**
 * Get calibrated thresholds for a symbol.
 */
export function getThresholds(symbol) {
  const cls = detectAssetClass(symbol);
  const thresholds = loadThresholds();
  return {
    class: cls,
    ...(thresholds[cls] || DEFAULTS.US_MID_SMALL),
  };
}

/**
 * Classify F&G score using calibrated thresholds for the symbol's asset class.
 */
export function classifyCalibratedZone(symbol, fgScore) {
  const t = getThresholds(symbol);

  let zone, severity;
  if (fgScore <= t.extreme_fear) { zone = 'RARE FEAR'; severity = -2; }
  else if (fgScore <= t.fear) { zone = 'FEAR'; severity = -1; }
  else if (fgScore >= t.extreme_greed) { zone = 'RARE GREED'; severity = 2; }
  else if (fgScore >= t.greed) { zone = 'GREED'; severity = 1; }
  else { zone = 'NEUTRAL'; severity = 0; }

  // Percentile position (how far into the tail)
  const distFromFear = t.extreme_fear !== 0 ? Math.round((fgScore - t.extreme_fear) / Math.abs(t.extreme_fear) * 100) : 0;

  return {
    zone,
    severity,
    class: t.class,
    thresholds: { extreme_fear: t.extreme_fear, fear: t.fear, greed: t.greed, extreme_greed: t.extreme_greed },
    distance_to_rare_fear: Math.round((fgScore - t.extreme_fear) * 100) / 100,
    is_triggered: fgScore <= t.extreme_fear,
  };
}

// Deep backtest stats per class (from 2127 events over 10 years, walk-forward validated)
const CLASS_STATS = {
  US_LARGE_CAP:     { avg30d: 2.65, wr: 56, sharpe: 0.52, pValue: '<0.01', significant: true, avgDD: -6.8 },
  US_MID_SMALL:     { avg30d: 7.52, wr: 52, sharpe: 0.69, pValue: '0.02', significant: true, avgDD: -10.6 },
  ASX_TOP50:        { avg30d: 1.49, wr: 59, sharpe: 0.39, pValue: '0.09', significant: false, avgDD: -5.8 },
  ASX_MINING_MID:   { avg30d: 6.44, wr: 49, sharpe: 0.53, pValue: '<0.01', significant: true, avgDD: -12.6 },
  ASX_MINING_MICRO: { avg30d: 6.44, wr: 49, sharpe: 0.53, pValue: '<0.01', significant: true, avgDD: -12.6 },
  CRYPTO_MAJOR:     { avg30d: 3.51, wr: 47, sharpe: 0.32, pValue: '0.10', significant: false, avgDD: -10.4 },
  CRYPTO_MID:       { avg30d: -0.75, wr: 36, sharpe: -0.07, pValue: '>0.50', significant: false, avgDD: -10.3 },
  COMMODITIES:      { avg30d: 2.21, wr: 57, sharpe: 0.73, pValue: '0.02', significant: true, avgDD: -6.6 },
  ETFS:             { avg30d: 1.85, wr: 57, sharpe: 0.53, pValue: '<0.01', significant: true, avgDD: -5.8 },
};

/**
 * Generate calibrated entry advice using deep backtest statistics.
 */
export function calibratedEntry(symbol, fgScore) {
  const cal = classifyCalibratedZone(symbol, fgScore);
  const t = cal.thresholds;
  const stats = CLASS_STATS[cal.class] || CLASS_STATS.US_MID_SMALL;

  if (fgScore > t.fear) {
    return {
      action: 'NO_SIGNAL',
      confidence: 0,
      reasoning: `F&G ${fgScore} is normal for ${cal.class} (fear threshold: ${t.fear})`,
      zone: cal.zone,
      class: cal.class,
    };
  }

  // Crypto mid-caps: negative edge, warn user
  if (cal.class === 'CRYPTO_MID') {
    return {
      action: 'AVOID',
      confidence: 0,
      reasoning: `F&G ${fgScore} in fear for ${cal.class}, but backtesting shows NEGATIVE edge (-0.75% avg, 36% WR, p>0.50). Crypto mid-cap fear signals are not profitable.`,
      zone: cal.zone,
      class: cal.class,
      stats: { avg_30d: stats.avg30d, win_rate: stats.wr, sharpe: stats.sharpe, p_value: stats.pValue },
    };
  }

  if (fgScore > t.extreme_fear) {
    return {
      action: 'WATCH',
      confidence: 20,
      reasoning: `F&G ${fgScore} in fear zone for ${cal.class}. Rare fear at ${t.extreme_fear}, ${cal.distance_to_rare_fear.toFixed(1)} pts away.`,
      suggestedSize: '0%',
      zone: cal.zone,
      class: cal.class,
    };
  }

  // Rare fear triggered — use class-specific stats
  const conf = stats.significant ? Math.min(75, Math.round(stats.wr * 1.2)) : Math.min(40, stats.wr);

  return {
    action: stats.significant ? 'SCALE_IN' : 'WATCH',
    confidence: conf,
    reasoning: `F&G ${fgScore} = RARE FEAR for ${cal.class} (10th pctl: ${t.extreme_fear}). Backtest: ${stats.avg30d}% avg 30d return, ${stats.wr}% win rate, Sharpe ${stats.sharpe}, p=${stats.pValue}${stats.significant ? '' : ' (NOT significant — use with caution)'}`,
    suggestedSize: stats.significant ? '50% now, 50% on confirmation' : '25% max (low confidence)',
    expectedDrawdown: `${stats.avgDD}% avg`,
    expectedReturn30d: `${stats.avg30d}% avg`,
    historicalWinRate: `${stats.wr}%`,
    sharpe: stats.sharpe,
    p_value: stats.pValue,
    statistically_significant: stats.significant,
    zone: cal.zone,
    class: cal.class,
  };
}
