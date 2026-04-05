/**
 * F&G Dashboard — Production Server
 *
 * Paginated API, in-memory cache, error handling, health checks.
 * Serves 11,000+ symbols reliably with <200ms response times.
 */
import express from 'express';
import compression from 'compression';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { loadCache, saveCache as _saveCache } from '../core/fg_cache.js';
import { detectAssetClass, classifyCalibratedZone } from '../core/fg_calibrated.js';
import { loadDexTokens } from '../core/dex_universe.js';

import { scoreSignal } from '../core/signal_scorer.js';
import { miningFundamental, cryptoFundamental, stockFundamental, commodityFundamental, calculateGap } from '../core/fundamental_catalysts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
const PORT = 3000;
const HOME = process.env.HOME || process.env.USERPROFILE || '/tmp';

// Load CANETOAD geological signals (must be after HOME is defined)
let CANETOAD = {};
try {
  const geoFile = join(HOME, '.tradingview-mcp', 'canetoad', 'signals.json');
  if (existsSync(geoFile)) {
    CANETOAD = JSON.parse(readFileSync(geoFile, 'utf8'));
    console.log('CANETOAD loaded:', Object.keys(CANETOAD).length, 'tickers with geological data');
  }
} catch (e) { console.error('CANETOAD load error:', e.message); }

// Load crypto fundamentals cache
let CRYPTO_FUND = {};
try {
  const cf = join(HOME, '.tradingview-mcp', 'cache', 'crypto_fundamentals.json');
  if (existsSync(cf)) { CRYPTO_FUND = JSON.parse(readFileSync(cf, 'utf8')); console.log('Crypto fundamentals loaded:', Object.keys(CRYPTO_FUND).length, 'tokens'); }
} catch {}

app.use(compression());
app.use(express.json());

// ─── In-memory data store (loaded once, refreshed periodically) ─────────────

let DATA = { rows: [], stats: {}, categories: [], tfCounts: {}, updated: null };
let FAVS = [];

function loadFavorites() {
  const file = join(HOME, '.tradingview-mcp', 'watchlist', 'favorites.json');
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return []; }
}
function saveFavorites(list) {
  const dir = join(HOME, '.tradingview-mcp', 'watchlist');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'favorites.json'), JSON.stringify(list));
}

// Crypto mcap lookup
let cryptoMcaps = new Map();
try {
  const f = join(HOME, '.tradingview-mcp', 'universes', 'crypto_tokens.json');
  if (existsSync(f)) for (const t of JSON.parse(readFileSync(f, 'utf8'))) if (t.symbol && t.market_cap) cryptoMcaps.set(t.symbol.toUpperCase(), t.market_cap);
} catch {}

const MEGA = new Set(['AAPL','MSFT','GOOG','AMZN','NVDA','META','TSLA','BRK-B','AVGO','LLY','JPM','V','UNH','XOM','MA','COST','HD','PG','JNJ','ABBV','WMT','NFLX','BAC','CRM','ORCL','CVX','MRK','KO','PEP','AMD']);
const ASX_BIG = new Set(['BHP','RIO','CBA','WBC','NAB','ANZ','CSL','WES','MQG','FMG','TLS','GMG','WOW']);

function estimateMcap(sym, price) {
  const mc = cryptoMcaps.get(sym.toUpperCase());
  if (mc) return mc;
  const base = sym.replace(/\.[A-Z]+$/, '');
  if (MEGA.has(base)) return 1e12 + Math.random() * 2e12;
  if (ASX_BIG.has(base)) return 5e10 + Math.random() * 2e11;
  if (sym.endsWith('.AX')) return 5e7 + Math.random() * 5e9;
  if (price > 100) return 5e9 + Math.random() * 5e10;
  if (price > 10) return 1e9 + Math.random() * 1e10;
  return 1e8 + Math.random() * 5e9;
}

function rebuildData() {
  try {
    const cache = loadCache();
    let rows = [];

    for (const [key, entry] of Object.entries(cache)) {
      if (!key.endsWith(':D') || entry?.fgScore == null) continue;
      const sym = key.replace(':D', '');
      const cls = detectAssetClass(sym);
      const cat = { US_LARGE_CAP:'US Large Cap', US_MID_SMALL:'US Mid/Small', ASX_TOP50:'ASX Top 50', ASX_MINING_MID:'ASX Mining Mid', ASX_MINING_MICRO:'ASX Mining Micro', CRYPTO_MAJOR:'Crypto Major', CRYPTO_MID:'Crypto Mid', COMMODITIES:'Commodities', ETFS:'ETFs', INTL_CANADA:'Canada TSX', INTL_LONDON:'London LSE', INTL_HONG_KONG:'Hong Kong', INTL_JAPAN:'Japan', INTL_GERMANY:'Germany', INTL_INDIA:'India', INTL_SOUTH_AFRICA:'South Africa' }[cls] || cls;

      const fg = entry.fgScore;
      const price = entry.lastClose || 0;
      const mcap = estimateMcap(sym, price);
      let zn;
      if (fg >= 73) zn = 'Euphoria'; else if (fg >= 41) zn = 'Thrill'; else if (fg >= 10) zn = 'Excitement';
      else if (fg >= 5) zn = 'Optimism'; else if (fg >= -5) zn = 'Balanced'; else if (fg >= -10) zn = 'Anxiety';
      else if (fg >= -25) zn = 'Fear'; else if (fg >= -41) zn = 'Panic'; else zn = 'Despondency';

      const cal = classifyCalibratedZone(sym, fg);
      let sw = '';
      if (cal.severity <= -2) sw = 'ENTRY ZONE'; else if (cal.severity === -1) sw = 'WATCHING';
      else if (cal.severity >= 2) sw = 'TAKE PROFIT'; else if (cal.severity === 1) sw = 'EXIT ZONE';

      const tier = ['US_LARGE_CAP','ASX_MINING_MID','ASX_MINING_MICRO','COMMODITIES'].includes(cls) ? 1 :
        ['US_MID_SMALL','ETFS','ASX_TOP50','CRYPTO_MAJOR'].includes(cls) ? 2 : 3;

      // Clamp all F&G scores to safe range
      const clamp = v => v != null ? Math.max(-80, Math.min(100, Math.round(v * 10) / 10)) : null;
      // 24h change approximation from pmacd component (price vs EMA deviation)
      const ch = entry.components?.pmacd != null ? Math.round(entry.components.pmacd * 100) / 100 : null;
      // Whale proxy: volume spike detection from moneyFlow component
      // High |moneyFlow| during fear = unusual volume = whale activity
      const mf = entry.components?.moneyFlow ?? 0;
      const volSpike = Math.abs(mf) > 30; // moneyFlow > 30 means volume significantly above normal
      const whale = (volSpike && fg < cal.thresholds?.fear) ? 'ACC' : volSpike && fg > (cal.thresholds?.greed ?? 5) ? 'DIST' : '';

      // ATH distance proxy from ror component (144-bar return)
      const ror = entry.components?.ror ?? 0;
      // If ror is very negative, price is far below 144-day level (proxy for ATH distance)
      const athDist = ror != null ? Math.round(ror * 10) / 10 : null;

      // Smart Score: composite of F&G depth + volume signal + momentum
      const fgDepth = cal.severity <= -2 ? 40 : cal.severity === -1 ? 25 : cal.severity === 0 ? 10 : 0;
      const volBonus = volSpike && fg < 0 ? 20 : 0; // Volume spike during fear = accumulation
      const rsiBonus = (entry.rsi ?? 50) < 30 ? 20 : (entry.rsi ?? 50) < 40 ? 10 : 0; // Oversold RSI
      const momentumBonus = (entry.components?.pmacd ?? 0) < -10 ? 20 : (entry.components?.pmacd ?? 0) < -5 ? 10 : 0;
      const smartScore = Math.min(100, fgDepth + volBonus + rsiBonus + momentumBonus);

      // Geological data from CANETOAD
      const geo = CANETOAD[sym] || null;
      // Universal fundamental score
      let fundScore = null;
      if (geo && cat.includes('Mining')) fundScore = miningFundamental(geo);
      else if (cls.includes('CRYPTO')) fundScore = cryptoFundamental(CRYPTO_FUND[sym] || { buyRatio: (entry.components?.moneyFlow ?? 0) > 10 ? 0.6 : 0.5 });
      else if (cls === 'COMMODITIES') fundScore = commodityFundamental({ pmacd: entry.components?.pmacd, ror: entry.components?.ror });
      else fundScore = stockFundamental({ volumeSpike: Math.abs(entry.components?.moneyFlow ?? 0) > 30 ? 3 : 1, revenueGrowth: 0 });
      const fvGap = calculateGap(fundScore, fg);

      rows.push({
        s: sym, f: clamp(fg), z: zn, c: cat, t: tier, w: sw, p: Math.round(price * 1e6) / 1e6, m: Math.round(mcap),
        r: entry.rsi ? Math.round(entry.rsi * 10) / 10 : null, ch,
        f1: clamp(cache[sym + ':15']?.fgScore),
        fh: clamp(cache[sym + ':60']?.fgScore),
        f4: clamp(cache[sym + ':240']?.fgScore),
        fw: clamp(cache[sym + ':W']?.fgScore),
        wh: whale, ad: athDist, ss: smartScore,
        gh: geo?.total_holes || null, gs: geo?.geological_score || null,
        gp: geo?.geological_percentile || null, gst: geo?.stranded_assets?.estimated_newly_economic || null,
        fs: fundScore, // Fundamental score 0-100
        fg_gap: fvGap, // Fundamental vs Sentiment gap
      });
      const last = rows[rows.length - 1];
      last.spark = [last.f1, last.fh, last.f4, last.f, last.fw].filter(v => v != null);
    }

    // Merge DEX smart money data into existing rows (tokens that exist in both CEX and DEX)
    const dexLookup = new Map();
    for (const token of loadDexTokens()) {
      if (token.avgTradeSize || token.buyRatio) dexLookup.set(token.symbol, token);
    }
    for (const r of rows) {
      const dex = dexLookup.get(r.s);
      if (dex) {
        r.ats = dex.avgTradeSize || 0;
        r.br = Math.round((dex.buyRatio || 0.5) * 100);
        // Upgrade whale signal using DEX data
        if (!r.wh && r.f < -10 && ((dex.avgTradeSize || 0) > 5000 || (dex.buyRatio || 0.5) > 0.6)) r.wh = 'ACC';
      }
    }

    // Add DEX tokens (clamp scores to safe range)
    const seenSyms = new Set(rows.map(r => r.s));
    const dexTokens = loadDexTokens().filter(t => !seenSyms.has(t.symbol));

    // Count tokens per chain to decide which get their own category
    const chainCounts = {};
    for (const token of dexTokens) {
      const chain = (token.chain || '').toLowerCase();
      chainCounts[chain] = (chainCounts[chain] || 0) + 1;
    }

    for (const token of dexTokens) {
      seenSyms.add(token.symbol);
      const fg = Math.max(-80, Math.min(100, Math.round((token.fg ?? 0) * 10) / 10));
      const chain = (token.chain || '').toLowerCase();
      const chainLabel = chain.charAt(0).toUpperCase() + chain.slice(1);
      const cat = chainCounts[chain] >= 20 ? 'DEX ' + chainLabel : 'DEX Other';
      const dexCh = token.priceChange?.h24 != null ? Math.round(token.priceChange.h24 * 100) / 100 : null;
      // Smart money proxy from DEX data
      const avgTs = token.avgTradeSize || 0;
      const buyR = token.buyRatio || 0.5;
      const totalTxns = (token.buys24h || 0) + (token.sells24h || 0);
      let dexSmart = '';
      if (fg < -10 && (avgTs > 5000 || buyR > 0.6) && totalTxns > 20) dexSmart = 'ACC'; // Fear + large trades/buying = accumulation
      else if (fg > 10 && (avgTs > 5000 || buyR < 0.4) && totalTxns > 20) dexSmart = 'DIST'; // Greed + selling = distribution
      rows.push({
        s: token.symbol, f: fg, z: token.zone || 'Balanced',
        c: cat, t: 3, w: '', p: token.price || 0, m: token.mcap || 1e6,
        r: null, ch: dexCh, f1: null, fh: null, f4: null, fw: null, spark: [],
        wh: dexSmart, ats: avgTs, br: Math.round(buyR * 100), // avg trade size, buy ratio %
      });
    }

    // Server-side safety net: filter out any scores outside [-80, +100]
    rows = rows.filter(r => r.f >= -80 && r.f <= 100);

    // Apply signal scoring to entry zone symbols
    for (const r of rows) {
      if (r.w === 'ENTRY ZONE' || r.w === 'WATCHING') {
        const clsKey = { 'US Large Cap': 'US_LARGE_CAP', 'US Mid/Small': 'US_MID_SMALL', 'ASX Top 50': 'ASX_TOP50', 'ASX Mining Mid': 'ASX_MINING_MID', 'ASX Mining Micro': 'ASX_MINING_MICRO', 'Crypto Major': 'CRYPTO_MAJOR', 'Crypto Mid': 'CRYPTO_MID', 'Commodities': 'COMMODITIES', 'ETFs': 'ETFS' }[r.c] || 'US_MID_SMALL';
        const cal = classifyCalibratedZone(r.s, r.f);
        const result = scoreSignal(r, { threshold: cal.thresholds?.extreme_fear ?? -15, classKey: clsKey });
        r.sq = result.score;
        r.sg = result.grade;
        r.sf = result.factors;
      }
    }
    rows.sort((a, b) => a.f - b.f);

    // Stats
    const cats = {};
    let sumFG = 0;
    for (const r of rows) {
      sumFG += r.f;
      cats[r.c] = (cats[r.c] || 0) + 1;
    }
    const tfCounts = {
      '15m': rows.filter(r => r.f1 != null).length,
      '1H': rows.filter(r => r.fh != null).length,
      '4H': rows.filter(r => r.f4 != null).length,
      'Daily': rows.length,
      'Weekly': rows.filter(r => r.fw != null).length,
    };

    // Market breadth: % of symbols with positive pmacd (price above EMA-144)
    const breadth = {};
    const breadthClasses = { 'US Large Cap': 'US', 'US Mid/Small': 'US', 'ASX Top 50': 'ASX', 'ASX Mining Mid': 'ASX', 'ASX Mining Micro': 'ASX', 'Crypto Major': 'Crypto', 'Crypto Mid': 'Crypto' };
    for (const r of rows) {
      const group = breadthClasses[r.c] || 'Other';
      if (!breadth[group]) breadth[group] = { above: 0, total: 0 };
      breadth[group].total++;
      if (r.ch != null && r.ch > 0) breadth[group].above++; // pmacd > 0 = above EMA
    }
    const breadthPct = {};
    for (const [g, b] of Object.entries(breadth)) breadthPct[g] = b.total > 0 ? Math.round(b.above / b.total * 100) : 0;

    DATA = {
      rows,
      stats: {
        total: rows.length,
        avgFG: rows.length > 0 ? Math.round(sumFG / rows.length * 100) / 100 : 0,
        oversold: rows.filter(r => r.f <= -25).length,
        overbought: rows.filter(r => r.f >= 25).length,
        whaleAcc: rows.filter(r => r.wh === 'ACC').length,
        smartSignals: rows.filter(r => r.ss >= 60).length,
        breadth: breadthPct,
      },
      categories: Object.entries(cats).map(([name, count]) => ({ name, count })).sort((a, b) => {
        const order = ['Crypto Major', 'Crypto Mid', 'US Large Cap', 'US Mid/Small', 'ASX Top 50', 'ASX Mining Mid', 'ASX Mining Micro', 'DEX Solana', 'DEX Ethereum', 'DEX Other', 'Commodities', 'ETFs'];
        const ai = order.indexOf(a.name), bi = order.indexOf(b.name);
        return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi);
      }),
      tfCounts,
      updated: new Date().toISOString(),
    };

    FAVS = loadFavorites();
    console.log(`Data loaded: ${rows.length} symbols, ${Object.keys(cache).length} cache entries`);
  } catch (e) {
    console.error('Failed to load data:', e.message);
  }
}

// ─── Paginated API ──────────────────────────────────────────────────────────

app.get('/api/cached', (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(500, Math.max(10, parseInt(req.query.limit) || 200));
    const category = req.query.category || null;
    const sort = req.query.sort || 'f';
    const order = req.query.order === 'desc' ? -1 : 1;

    let filtered = DATA.rows;
    if (category) filtered = filtered.filter(r => r.c === category || r.c.includes(category));

    // Sort — nulls always go to bottom regardless of sort direction
    filtered = [...filtered].sort((a, b) => {
      const va = a[sort], vb = b[sort];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;  // nulls to bottom
      if (vb == null) return -1;
      return typeof va === 'string' ? va.localeCompare(vb) * order : (va - vb) * order;
    });

    const total = filtered.length;
    const pages = Math.ceil(total / limit);
    const start = (page - 1) * limit;
    const symbols = filtered.slice(start, start + limit);

    // Key assets for sidebar
    const keyAssets = ['BTC','ETH','SPY','AAPL'].map(sym => {
      const r = DATA.rows.find(x => x.s === sym);
      return r ? { s: r.s, p: r.p, f: r.f, z: r.z } : null;
    }).filter(Boolean);

    // Signal counts
    const signals = {
      entry: DATA.rows.filter(r => r.w === 'ENTRY ZONE').length,
      watching: DATA.rows.filter(r => r.w === 'WATCHING').length,
      exit: DATA.rows.filter(r => r.w === 'TAKE PROFIT' || r.w === 'EXIT ZONE').length,
    };

    res.json({
      symbols, total, page, pages, limit,
      stats: DATA.stats,
      categories: DATA.categories,
      tfCounts: DATA.tfCounts,
      updated: DATA.updated,
      keyAssets, signals,
    });
  } catch (e) {
    res.status(500).json({ error: e.message, symbols: [], total: 0, page: 1, pages: 0 });
  }
});

// Scatter data: max 500 extreme dots
app.get('/api/scatter', (req, res) => {
  try {
    const category = req.query.category || null;
    let rows = category ? DATA.rows.filter(r => r.c === category || r.c.includes(category)) : DATA.rows;
    // Top 250 most fearful + top 250 most greedy
    const sorted = [...rows].sort((a, b) => a.f - b.f);
    const fear = sorted.slice(0, 250);
    const greed = sorted.slice(-250);
    const combined = [...new Map([...fear, ...greed].map(r => [r.s, r])).values()]
      .filter(r => r.f >= -80 && r.f <= 100); // Safety net
    res.json(combined);
  } catch (e) {
    res.status(500).json([]);
  }
});

app.get('/api/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: 'ok',
    symbols: DATA.stats.total || 0,
    uptime: Math.round(process.uptime()) + 's',
    memory: Math.round(mem.heapUsed / 1e6) + 'MB',
    updated: DATA.updated,
  });
});

// ─── Shared OHLCV fetcher (used by history endpoint + background worker) ────

const YAHOO_RANGES = { '15': { range: '60d', interval: '15m' }, '60': { range: '2y', interval: '1h' }, '240': { range: '2y', interval: '1d' }, 'D': { range: 'max', interval: '1d' }, 'W': { range: 'max', interval: '1wk' } };
const BINANCE_INTERVALS = { '15': '15m', '60': '1h', '240': '4h', 'D': '1d', 'W': '1w' };

async function fetchBars(sym, tf) {
  const { detectAssetClass } = await import('../core/fg_calibrated.js');
  const cls = detectAssetClass(sym);
  const isCrypto = cls.includes('CRYPTO');

  let primaryBars = null;
  if (isCrypto) {
    try {
      let pair = sym.replace(/[-\/]/g, '').toUpperCase();
      if (!pair.endsWith('USDT') && !pair.endsWith('USD')) pair += 'USDT';
      const bi = BINANCE_INTERVALS[tf] || '1d';
      const limit = (tf === 'D' || tf === 'W' || tf === '240') ? 1000 : 200;
      const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${bi}&limit=${limit}`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const d = await r.json();
        if (Array.isArray(d) && d.length >= 20)
          primaryBars = d.map(b => ({ time: Math.floor(b[0] / 1000), open: +b[1], high: +b[2], low: +b[3], close: +b[4], volume: +b[5] || 0 }));
      }
    } catch {}
    // For non-daily, return Binance immediately
    if (primaryBars && tf !== 'D') return primaryBars;
  }
  // Yahoo Finance — try max range first, fall back to shorter if sparse
  async function tryYahoo(ticker2, range2, interval2) {
    try {
      const r2 = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker2)}?range=${range2}&interval=${interval2}&includePrePost=false`, { signal: AbortSignal.timeout(5000) });
      if (!r2.ok) return [];
      const d2 = await r2.json();
      const ch = d2?.chart?.result?.[0];
      if (!ch?.timestamp) return [];
      const q2 = ch.indicators.quote[0];
      const b = [];
      for (let i = 0; i < ch.timestamp.length; i++)
        if (q2.close[i] != null && q2.open[i] != null)
          b.push({ time: ch.timestamp[i], open: q2.open[i], high: q2.high[i], low: q2.low[i], close: q2.close[i], volume: q2.volume[i] || 0 });
      return b;
    } catch { return []; }
  }
  try {
    const cfg = YAHOO_RANGES[tf] || YAHOO_RANGES['D'];
    let ticker = sym;
    if (isCrypto && !ticker.includes('-')) ticker += '-USD';
    let bars2 = await tryYahoo(ticker, cfg.range, cfg.interval);
    // If range=max returned sparse data (<500 bars for daily), retry with 10y
    if (tf === 'D' && bars2.length > 0 && bars2.length < 500) {
      const bars10y = await tryYahoo(ticker, '10y', '1d');
      if (bars10y.length > bars2.length) bars2 = bars10y;
    }
    if (bars2.length >= 20) return bars2;
  } catch {}

  // CryptoCompare for crypto daily — always try if Binance gave < 2000 bars
  if (isCrypto && tf === 'D' && (!primaryBars || primaryBars.length < 2000)) {
    try {
      const ccSym = sym.replace(/-USD$/i, '').replace(/USDT$/i, '').toUpperCase();
      const allBars = [];
      let toTs = Math.floor(Date.now() / 1000);
      for (let page = 0; page < 4; page++) { // 4 pages × 2000 = up to 8000 bars (22yr)
        const ccr = await fetch(`https://min-api.cryptocompare.com/data/v2/histoday?fsym=${ccSym}&tsym=USD&limit=2000&toTs=${toTs}`, { signal: AbortSignal.timeout(8000) });
        if (!ccr.ok) break;
        const ccd = await ccr.json();
        const bars3 = (ccd?.Data?.Data || []).filter(b => b.close > 0);
        if (bars3.length === 0) break;
        allBars.unshift(...bars3.map(b => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volumeto || 0 })));
        toTs = bars3[0].time - 1;
        if (bars3.length < 2000) break;
        await new Promise(r => setTimeout(r, 300));
      }
      // Deduplicate
      const seen = new Set();
      const deduped = allBars.filter(b => { if (seen.has(b.time)) return false; seen.add(b.time); return true; }).sort((a, b) => a.time - b.time);
      if (deduped.length >= 100) return deduped;
    } catch {}
  }

  // CoinGecko OHLC fallback (last resort for crypto)
  if (isCrypto && tf === 'D' && (!primaryBars || primaryBars.length < 500)) {
    try {
      const cgId = cgIdMap.get(sym.toUpperCase());
      if (cgId) {
        const cgr = await fetch(`https://api.coingecko.com/api/v3/coins/${cgId}/ohlc?vs_currency=usd&days=max`, { signal: AbortSignal.timeout(10000) });
        if (cgr.ok) {
          const cgd = await cgr.json();
          if (Array.isArray(cgd) && cgd.length > (primaryBars?.length || 0))
            primaryBars = cgd.map(([t, o, h, l, c]) => ({ time: Math.floor(t / 1000), open: o, high: h, low: l, close: c, volume: 0 }));
        }
      }
    } catch {}
  }
  // Return whatever we got (primaryBars from Binance, or from fallbacks)
  if (primaryBars && primaryBars.length >= 20) return primaryBars;
  return null;
}

// Cache the latest F&G score from a time series into the scores cache
function cacheScore(sym, tf, series, bars) {
  if (!series || series.length === 0) return;
  const last = series[series.length - 1];
  const cache = loadCache();
  const key = `${sym}:${tf}`;
  cache[key] = {
    lastScanTime: new Date().toISOString(),
    fgScore: Math.max(-80, Math.min(100, Math.round(last.fg_score * 100) / 100)),
    zone: last.zone,
    lastClose: last.close,
    barCount: bars.length,
  };
  _saveCache(cache);
}

// Track recently viewed symbols for background worker
const recentViews = new Set();

// ─── History endpoint (on-demand fetch + cache) ─────────────────────────────

app.get('/api/history/:symbol', async (req, res) => {
  try {
    const sym = req.params.symbol;
    const tf = req.query.tf || 'D';
    recentViews.add(sym);

    const { computeTimeSeries } = await import('../core/fg_backtest.js');
    const bars = await fetchBars(sym, tf);
    if (!bars || bars.length < 30) return res.json({ error: 'No ' + tf + ' data for ' + sym, tf });

    const series = computeTimeSeries(bars);
    if (series.length === 0 && bars.length >= 30) {
      const ohlcv = bars.map(b => ({ t: b.time * 1000, o: Math.round(b.open * 1e4) / 1e4, h: Math.round(b.high * 1e4) / 1e4, l: Math.round(b.low * 1e4) / 1e4, c: Math.round(b.close * 1e4) / 1e4 }));
      return res.json({ symbol: sym, tf, bars: ohlcv.length, ohlcv, fg: [], current: { price: bars[bars.length - 1].close } });
    }

    // Cache the score for the table
    cacheScore(sym, tf, series, bars);

    const slicedBars = bars.slice(-series.length);
    const ohlcv = slicedBars.map(b => ({ t: b.time * 1000, o: Math.round(b.open * 1e4) / 1e4, h: Math.round(b.high * 1e4) / 1e4, l: Math.round(b.low * 1e4) / 1e4, c: Math.round(b.close * 1e4) / 1e4 }));
    const fg = series.map(s => ({ t: new Date(s.date).getTime(), v: Math.max(-80, Math.min(100, Math.round(s.fg_score * 10) / 10)) }));
    const last = series[series.length - 1];
    res.json({ symbol: sym, tf, bars: ohlcv.length, ohlcv, fg, cached: false, current: { fg: last?.fg_score, zone: last?.zone, price: ohlcv[ohlcv.length - 1]?.c } });
  } catch (e) { res.json({ error: e.message?.slice(0, 100) }); }
});

// Lightweight on-demand fetch: just cache the score and return it
app.get('/api/fetch-and-cache/:symbol', async (req, res) => {
  try {
    const sym = req.params.symbol;
    const tf = req.query.tf || 'D';
    recentViews.add(sym);

    // Check cache freshness
    const cache = loadCache();
    const key = `${sym}:${tf}`;
    const TTL = { '15': 30 * 60e3, '60': 2 * 3600e3, '240': 8 * 3600e3, 'D': 24 * 3600e3, 'W': 7 * 24 * 3600e3 };
    const entry = cache[key];
    if (entry?.fgScore != null && entry.lastScanTime) {
      const age = Date.now() - new Date(entry.lastScanTime).getTime();
      if (age < (TTL[tf] || 24 * 3600e3)) {
        return res.json({ symbol: sym, tf, fg: entry.fgScore, zone: entry.zone, price: entry.lastClose, cached: true });
      }
    }

    const { computeTimeSeries } = await import('../core/fg_backtest.js');
    const bars = await fetchBars(sym, tf);
    if (!bars || bars.length < 30) return res.json({ error: 'No data', tf });
    const series = computeTimeSeries(bars);
    if (series.length > 0) {
      cacheScore(sym, tf, series, bars);
      const last = series[series.length - 1];
      return res.json({ symbol: sym, tf, fg: Math.max(-80, Math.min(100, Math.round(last.fg_score * 10) / 10)), zone: last.zone, price: last.close, cached: false });
    }
    res.json({ error: 'Insufficient data', tf });
  } catch (e) { res.json({ error: e.message?.slice(0, 80) }); }
});

// Available timeframes — report cached freshness
app.get('/api/available-tfs/:symbol', (req, res) => {
  const sym = req.params.symbol;
  const cache = loadCache();
  const TTL = { '15': 30 * 60e3, '60': 2 * 3600e3, '240': 8 * 3600e3, 'D': 24 * 3600e3, 'W': 7 * 24 * 3600e3 };
  const available = {};
  for (const tf of ['15', '60', '240', 'D', 'W']) {
    const entry = cache[`${sym}:${tf}`];
    const fresh = entry?.lastScanTime && (Date.now() - new Date(entry.lastScanTime).getTime()) < (TTL[tf] || 86400e3);
    available[tf] = { fetchable: true, cached: !!entry?.fgScore, fresh };
  }
  res.json({ symbol: sym, available });
});

// ─── Watchlist ──────────────────────────────────────────────────────────────

app.get('/api/watchlist', (req, res) => { res.json(FAVS); });
app.post('/api/watchlist/add', (req, res) => {
  const sym = req.body?.symbol; if (!sym) return res.json({ error: 'No symbol' });
  if (!FAVS.includes(sym)) { FAVS.push(sym); saveFavorites(FAVS); }
  res.json({ success: true, favorites: FAVS });
});
app.post('/api/watchlist/remove', (req, res) => {
  const sym = req.body?.symbol;
  FAVS = FAVS.filter(s => s !== sym); saveFavorites(FAVS);
  res.json({ success: true, favorites: FAVS });
});

// ─── On-chain enrichment (CoinGecko) ────────────────────────────────────────

const cgIdMap = new Map();
// Hardcode top crypto to avoid CoinGecko ID collisions
const CG_OVERRIDES = { BTC:'bitcoin', ETH:'ethereum', SOL:'solana', XRP:'ripple', BNB:'binancecoin', ADA:'cardano', DOGE:'dogecoin', AVAX:'avalanche-2', DOT:'polkadot', LINK:'chainlink', ATOM:'cosmos', UNI:'uniswap', AAVE:'aave', LTC:'litecoin', NEAR:'near', FIL:'filecoin', ARB:'arbitrum', OP:'optimism', APT:'aptos', INJ:'injective-protocol', SUI:'sui', SEI:'sei-network', TIA:'celestia', PEPE:'pepe', BONK:'bonk', PENDLE:'pendle', ENA:'ethena', HBAR:'hedera-hashgraph', ALGO:'algorand', FTM:'fantom', SHIB:'shiba-inu', MATIC:'matic-network', MKR:'maker', IMX:'immutable-x', SAND:'the-sandbox', MANA:'decentraland', AXS:'axie-infinity', FET:'fetch-ai', RNDR:'render-token', GRT:'the-graph', STX:'blockstack' };
for (const [sym, id] of Object.entries(CG_OVERRIDES)) cgIdMap.set(sym, id);
try {
  const f = join(HOME, '.tradingview-mcp', 'universes', 'crypto_tokens.json');
  if (existsSync(f)) for (const t of JSON.parse(readFileSync(f, 'utf8'))) if (t.symbol && t.id && !cgIdMap.has(t.symbol.toUpperCase())) cgIdMap.set(t.symbol.toUpperCase(), t.id);
} catch {}

app.get('/api/onchain/:symbol', async (req, res) => {
  try {
    const sym = req.params.symbol.toUpperCase();
    const cgId = cgIdMap.get(sym);
    if (!cgId) return res.json({ error: 'Not a known crypto token', symbol: sym });
    const r = await fetch(`https://api.coingecko.com/api/v3/coins/${cgId}?localization=false&tickers=false&community_data=true&developer_data=false`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return res.json({ error: 'CoinGecko unavailable' });
    const d = await r.json();
    const m = d.market_data || {};
    res.json({
      symbol: sym,
      athDistance: m.ath_change_percentage?.usd != null ? Math.round(m.ath_change_percentage.usd * 10) / 10 : null,
      athDate: m.ath_date?.usd,
      atlDistance: m.atl_change_percentage?.usd != null ? Math.round(m.atl_change_percentage.usd) : null,
      volMcapRatio: m.total_volume?.usd && m.market_cap?.usd ? Math.round(m.total_volume.usd / m.market_cap.usd * 10000) / 100 : null,
      priceChange: { h1: m.price_change_percentage_1h_in_currency?.usd, d1: m.price_change_percentage_24h, d7: m.price_change_percentage_7d, d30: m.price_change_percentage_30d, d200: m.price_change_percentage_200d, y1: m.price_change_percentage_1y },
      sentiment: { up: d.sentiment_votes_up_percentage, down: d.sentiment_votes_down_percentage },
      watchlistUsers: d.watchlist_portfolio_users,
      circulatingSupply: m.circulating_supply,
      maxSupply: m.max_supply,
      fdv: m.fully_diluted_valuation?.usd,
    });
  } catch (e) { res.json({ error: e.message?.slice(0, 80) }); }
});

// ─── Add token + Discover ───────────────────────────────────────────────────

app.post('/api/add-token', async (req, res) => {
  try {
    const { addToken } = await import('../core/dex_universe.js');
    res.json(await addToken(req.body?.url || req.body?.address || ''));
  } catch (e) { res.json({ error: e.message }); }
});

app.get('/api/refresh-dex', async (req, res) => {
  try {
    const { refreshDexScores } = await import('../core/dex_universe.js');
    const result = await refreshDexScores();
    rebuildData();
    res.json(result);
  } catch (e) { res.json({ error: e.message }); }
});

app.get('/api/discover', async (req, res) => {
  try {
    const { discoverTokens } = await import('../core/dex_universe.js');
    const result = await discoverTokens();
    rebuildData();
    res.json(result);
  } catch (e) { res.json({ error: e.message }); }
});

// Sector band stats
app.get('/api/sector-band/:category', (req, res) => {
  const cat = req.params.category;
  const rows = DATA.rows.filter(r => r.c === cat || r.c.includes(cat));
  if (rows.length === 0) return res.json({ error: 'No symbols' });

  const scores = rows.map(r => r.f).filter(v => v != null).sort((a, b) => a - b);
  const n = scores.length;
  const pctl = p => n > 0 ? scores[Math.min(n - 1, Math.floor(n * p / 100))] : 0;
  const avg = n > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / n * 10) / 10 : 0;

  // Distribution histogram
  const buckets = {};
  for (let b = -60; b < 100; b += 10) buckets[b] = 0;
  for (const s of scores) { const b = Math.floor(s / 10) * 10; if (buckets[b] !== undefined) buckets[b]++; else if (b >= 40) buckets[40] = (buckets[40] || 0) + 1; }

  // Top/bottom
  const topFear = [...rows].sort((a, b) => (a.f ?? 0) - (b.f ?? 0)).slice(0, 10).map(r => ({ s: r.s, f: r.f, p: r.p, fs: r.fs, fg_gap: r.fg_gap, gs: r.gs, gp: r.gp, w: r.w }));
  const topGreed = [...rows].sort((a, b) => (b.f ?? 0) - (a.f ?? 0)).slice(0, 10).map(r => ({ s: r.s, f: r.f, p: r.p, w: r.w }));

  // History from snapshots (if available)
  let history = [];
  try {
    const histDir = join(HOME, '.tradingview-mcp', 'history');
    if (existsSync(histDir)) {
      const files = readdirSync(histDir).filter(f => f.startsWith('snapshot-')).sort();
      // For now, just show current as a single point (history builds over days)
      history = [{ date: new Date().toISOString().slice(0, 10), p10: pctl(10), p25: pctl(25), median: pctl(50), p75: pctl(75), p90: pctl(90), avg }];
    }
  } catch {}

  res.json({
    category: cat, count: n,
    current: { p10: pctl(10), p25: pctl(25), median: pctl(50), p75: pctl(75), p90: pctl(90), avg, bandWidth: Math.round((pctl(90) - pctl(10)) * 10) / 10, pctFear: Math.round(scores.filter(s => s < -10).length / n * 100), pctGreed: Math.round(scores.filter(s => s > 10).length / n * 100) },
    distribution: buckets,
    topFear, topGreed, history,
  });
});

// Sector comparison — all sectors ranked
app.get('/api/sector-compare', (req, res) => {
  const cats = {};
  for (const r of DATA.rows) {
    if (!cats[r.c]) cats[r.c] = [];
    cats[r.c].push(r.f);
  }
  const sectors = Object.entries(cats).map(([name, scores]) => {
    scores.sort((a, b) => a - b);
    const n = scores.length;
    const pctl = p => scores[Math.min(n - 1, Math.floor(n * p / 100))];
    const avg = n > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / n * 10) / 10 : 0;
    return {
      name, count: n, avg, median: pctl(50),
      spread: Math.round((pctl(90) - pctl(10)) * 10) / 10,
      pctFear: Math.round(scores.filter(s => s < -10).length / n * 100),
      pctGreed: Math.round(scores.filter(s => s > 10).length / n * 100),
    };
  }).sort((a, b) => a.avg - b.avg); // Deepest fear first
  res.json({ sectors });
});

// Historical F&G extremes — find every fear/greed event in full history
app.get('/api/extremes/:symbol', async (req, res) => {
  try {
    const sym = req.params.symbol;
    const threshold = parseFloat(req.query.threshold) || -25;
    const exitThreshold = parseFloat(req.query.exit) || -10;
    const { computeTimeSeries } = await import('../core/fg_backtest.js');
    const bars = await fetchBars(sym, 'D');
    if (!bars || bars.length < 200) return res.json({ error: 'Insufficient history', bars: bars?.length || 0 });

    const series = computeTimeSeries(bars);
    if (series.length < 50) return res.json({ error: 'Not enough F&G data', series: series.length });

    // Find every time F&G crossed below threshold
    const events = [];
    let inFear = false, entry = null;
    for (let i = 0; i < series.length; i++) {
      const s = series[i];
      if (!inFear && s.fg_score <= threshold) {
        inFear = true;
        entry = { date: s.date, fg: Math.round(s.fg_score * 10) / 10, price: s.close, idx: i };
      } else if (inFear && s.fg_score > exitThreshold) {
        inFear = false;
        const exitPrice = s.close;
        const ret = entry.price > 0 ? Math.round((exitPrice / entry.price - 1) * 10000) / 100 : 0;
        const holdDays = i - entry.idx;
        // Also calculate 30d return from entry
        const p30 = entry.idx + 30 < series.length ? series[entry.idx + 30].close : null;
        const ret30 = p30 && entry.price > 0 ? Math.round((p30 / entry.price - 1) * 10000) / 100 : null;
        events.push({ entryDate: entry.date, entryFG: entry.fg, entryPrice: entry.price, exitDate: s.date, exitPrice, holdDays, returnPct: ret, return30d: ret30 });
      }
    }

    const returns = events.map(e => e.return30d).filter(v => v != null);
    const wins = returns.filter(r => r > 0);
    const avg = returns.length > 0 ? Math.round(returns.reduce((a, b) => a + b, 0) / returns.length * 10) / 10 : null;
    const best = returns.length > 0 ? Math.max(...returns) : null;
    const worst = returns.length > 0 ? Math.min(...returns) : null;

    res.json({
      symbol: sym, threshold, totalBars: bars.length, fgBars: series.length,
      yearsOfData: Math.round((series[series.length - 1]?.close ? (new Date(series[series.length - 1].date) - new Date(series[0].date)) / 365.25 / 86400000 : 0) * 10) / 10,
      extremeEvents: events.length,
      stats: { avg30dReturn: avg, winRate: returns.length > 0 ? Math.round(wins.length / returns.length * 100) : null, best, worst, medianHoldDays: events.length > 0 ? events.sort((a, b) => a.holdDays - b.holdDays)[Math.floor(events.length / 2)].holdDays : null },
      events: events.slice(-20), // Last 20 events
      currentFG: series[series.length - 1]?.fg_score,
      distanceToThreshold: Math.round((series[series.length - 1]?.fg_score - threshold) * 10) / 10,
    });
  } catch (e) { res.json({ error: e.message?.slice(0, 100) }); }
});

// Geological data endpoint
app.get('/api/geology/:symbol', (req, res) => {
  const sym = req.params.symbol;
  const geo = CANETOAD[sym];
  if (!geo) return res.json({ error: 'No geological data for ' + sym });
  res.json(geo);
});

// Unreacted drill results — highest alpha signals
app.get('/api/unreacted', (req, res) => {
  const results = [];
  for (const [ticker, data] of Object.entries(CANETOAD)) {
    if (!data.reports) continue;
    for (const report of data.reports) {
      if (!report.reaction?.status) continue;
      if (report.reaction.status === 'UNREACTED' || report.reaction.status === 'CONTRARIAN_BUY') {
        const row = DATA.rows.find(r => r.s === ticker);
        results.push({
          ticker, fg: row?.f ?? null, signal: row?.w ?? '', score: row?.sq ?? 0, grade: row?.sg ?? 'D',
          geoScore: data.geological_score, geoPctl: data.geological_percentile,
          report: { title: report.title, date: report.date, best: report.best, gxw: report.gxw,
            quality: report.quality, extension: report.extension,
            reaction: report.reaction, priceAtReport: report.priceAtReport },
          currentPrice: row?.p ?? null,
        });
      }
    }
  }
  results.sort((a, b) => {
    // Contrarian buys first, then by quality
    const aScore = (a.report.reaction.status === 'CONTRARIAN_BUY' ? 100 : 50) + (a.geoScore || 0);
    const bScore = (b.report.reaction.status === 'CONTRARIAN_BUY' ? 100 : 50) + (b.geoScore || 0);
    return bScore - aScore;
  });
  res.json({ unreacted: results, count: results.length });
});

// Worker status endpoint
app.get('/api/worker-status', (req, res) => {
  res.json(workerStatus);
});

// Sector analysis
app.get('/api/sector/:category', (req, res) => {
  const cat = req.params.category;
  const rows = DATA.rows.filter(r => r.c === cat || r.c.includes(cat));
  if (rows.length === 0) return res.json({ error: 'No symbols in category' });

  const scores = rows.map(r => r.f).filter(v => v != null);
  const avg = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10 : 0;
  const inFear = scores.filter(v => v < -10).length;
  const inGreed = scores.filter(v => v > 10).length;

  // Relative strength: each symbol vs sector avg
  const ranked = rows.map(r => ({
    s: r.s, f: r.f, p: r.p, ch: r.ch, r: r.r, wh: r.wh, sq: r.sq, sg: r.sg, m: r.m,
    rs: r.f != null ? Math.round((r.f - avg) * 10) / 10 : null, // relative strength
  })).sort((a, b) => (a.rs ?? 0) - (b.rs ?? 0)); // most oversold relative to sector first

  // Sector dispersion (how spread out are scores)
  const min = Math.min(...scores), max = Math.max(...scores);
  const std = scores.length > 1 ? Math.sqrt(scores.reduce((s, v) => s + (v - avg) ** 2, 0) / (scores.length - 1)) : 0;
  const correlation = std < 5 ? 'HIGH (moving together)' : std < 15 ? 'MODERATE' : 'LOW (rotation underway)';

  res.json({
    category: cat,
    count: rows.length,
    avgFG: avg,
    fearPct: scores.length > 0 ? Math.round(inFear / scores.length * 100) : 0,
    greedPct: scores.length > 0 ? Math.round(inGreed / scores.length * 100) : 0,
    range: [Math.round(min * 10) / 10, Math.round(max * 10) / 10],
    stddev: Math.round(std * 10) / 10,
    correlation,
    symbols: ranked,
  });
});

// Trending: biggest movers + whale activity + new high-volume DEX tokens
app.get('/api/trending', (req, res) => {
  const rows = DATA.rows;
  // Biggest gainers (most positive pmacd)
  const gainers = [...rows].filter(r => r.ch != null).sort((a, b) => (b.ch || 0) - (a.ch || 0)).slice(0, 15)
    .map(r => ({ s: r.s, c: r.c, p: r.p, ch: r.ch, f: r.f, z: r.z }));
  // Biggest losers (potential bounces)
  const losers = [...rows].filter(r => r.ch != null).sort((a, b) => (a.ch || 0) - (b.ch || 0)).slice(0, 15)
    .map(r => ({ s: r.s, c: r.c, p: r.p, ch: r.ch, f: r.f, z: r.z, sq: r.sq, sg: r.sg }));
  // Whale accumulation (high volume during fear)
  const whales = rows.filter(r => r.wh === 'ACC').sort((a, b) => (b.sq || 0) - (a.sq || 0)).slice(0, 15)
    .map(r => ({ s: r.s, c: r.c, p: r.p, f: r.f, sq: r.sq, sg: r.sg }));
  // DEX hot (recently added DEX tokens with high volume)
  const dexHot = rows.filter(r => r.c?.startsWith('DEX')).sort((a, b) => (b.m || 0) - (a.m || 0)).slice(0, 15)
    .map(r => ({ s: r.s, c: r.c, p: r.p, ch: r.ch, f: r.f, m: r.m }));
  // Top smart signals
  const smart = [...rows].filter(r => r.sq >= 50).sort((a, b) => (b.sq || 0) - (a.sq || 0)).slice(0, 15)
    .map(r => ({ s: r.s, c: r.c, p: r.p, f: r.f, sq: r.sq, sg: r.sg }));

  res.json({ gainers, losers, whales, dexHot, smart });
});

// ─── Business Cycle Rotation ────────────────────────────────────────────────

app.get('/api/cycle', (req, res) => {
  const r = sym => DATA.rows.find(x => x.s === sym);
  const avgFG = syms => {
    const vals = syms.map(s => r(s)?.f).filter(v => v != null);
    return vals.length > 0 ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10 : null;
  };
  const catAvg = cat => {
    const vals = DATA.rows.filter(x => x.c === cat).map(x => x.f);
    return vals.length > 0 ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10 : null;
  };

  // ─── 6-STAGE MACRO BUSINESS CYCLE ───
  const bondsFG = avgFG(['TLT', 'IEF', 'SHY', 'AGG']);
  const equitiesFG = avgFG(['SPY', 'QQQ', 'IWM', 'DIA']);
  const commoditiesFG = avgFG(['GC=F', 'SI=F', 'CL=F', 'HG=F', 'PL=F']);
  const cryptoFG = avgFG(['BTC', 'ETH']);
  const realEstateFG = avgFG(['VNQ', 'IYR', 'XLRE']);
  const dollarFG = r('UUP')?.f ?? null;

  const B = (bondsFG ?? 0) > 0;
  const E = (equitiesFG ?? 0) > 0;
  const C = (commoditiesFG ?? 0) > 0;

  let macroStage;
  if (B && !E && !C) macroStage = { stage: 1, name: 'RECESSION', desc: 'Bonds rising, equities & commodities falling', action: 'Buy bonds, avoid risk assets', buy: ['Bonds', 'Gold', 'Cash'], avoid: ['Equities', 'Crypto', 'Real Estate'] };
  else if (B && E && !C) macroStage = { stage: 2, name: 'EARLY RECOVERY', desc: 'Bonds & equities rising, commodities still weak', action: 'Buy equities NOW — best entry point', buy: ['Equities', 'Bonds', 'Real Estate'], avoid: ['Commodities'] };
  else if (B && E && C) macroStage = { stage: 3, name: 'EXPANSION', desc: 'Everything rising — full risk-on', action: 'Full risk-on: equities, crypto, mining', buy: ['Equities', 'Crypto', 'Commodities', 'Mining'], avoid: ['Cash'] };
  else if (!B && E && C) macroStage = { stage: 4, name: 'LATE EXPANSION', desc: 'Bonds falling, equities & commodities strong', action: 'Reduce bonds, hold equities, commodities peak', buy: ['Commodities', 'Equities'], avoid: ['Bonds'] };
  else if (!B && !E && C) macroStage = { stage: 5, name: 'SLOWDOWN', desc: 'Only commodities still rising', action: 'Reduce equities, commodities peaking', buy: ['Gold', 'Commodities'], avoid: ['Equities', 'Crypto'] };
  else if (!B && !E && !C) macroStage = { stage: 6, name: 'CONTRACTION', desc: 'Everything falling — maximum fear', action: 'Cash + gold only, wait for bonds to bottom', buy: ['Cash', 'Gold'], avoid: ['Everything else'] };
  else if (B && !E && C) macroStage = { stage: 1.5, name: 'STAGFLATION', desc: 'Bonds & commodities up, equities down', action: 'Gold + inflation hedges', buy: ['Gold', 'Commodities'], avoid: ['Equities', 'Bonds long'] };
  else macroStage = { stage: 3.5, name: 'SELECTIVE GROWTH', desc: 'Equities up without broad commodity support', action: 'Quality equities only', buy: ['Large Cap'], avoid: ['Small Cap', 'Commodities'] };

  // Barometers
  const barometers = [
    { name: 'Bonds', fg: bondsFG, symbols: ['TLT','IEF','SHY','AGG'], bullish: B },
    { name: 'Equities', fg: equitiesFG, symbols: ['SPY','QQQ','IWM'], bullish: E },
    { name: 'Commodities', fg: commoditiesFG, symbols: ['GC=F','SI=F','CL=F','HG=F'], bullish: C },
    { name: 'Crypto', fg: cryptoFG, symbols: ['BTC','ETH'], bullish: (cryptoFG ?? 0) > 0 },
    { name: 'Real Estate', fg: realEstateFG, symbols: ['VNQ','IYR'], bullish: (realEstateFG ?? 0) > 0 },
    { name: 'USD', fg: dollarFG, symbols: ['UUP'], bullish: (dollarFG ?? 0) > 0 },
  ];

  // Full asset class table
  const assetTable = [
    { name: 'US Govt Bonds', sym: 'TLT', fg: r('TLT')?.f, cat: 'Bonds' },
    { name: 'Corp Bonds', sym: 'LQD', fg: r('LQD')?.f, cat: 'Bonds' },
    { name: 'High Yield', sym: 'HYG', fg: r('HYG')?.f, cat: 'Bonds' },
    { name: 'US Large Cap', sym: 'SPY', fg: r('SPY')?.f, cat: 'Equities' },
    { name: 'US Small Cap', sym: 'IWM', fg: r('IWM')?.f, cat: 'Equities' },
    { name: 'Europe', sym: 'VGK', fg: r('VGK')?.f, cat: 'Equities' },
    { name: 'Emerging Mkts', sym: 'EEM', fg: r('EEM')?.f, cat: 'Equities' },
    { name: 'China', sym: 'FXI', fg: r('FXI')?.f, cat: 'Equities' },
    { name: 'Gold', sym: 'GC=F', fg: r('GC=F')?.f, cat: 'Commodities' },
    { name: 'Silver', sym: 'SI=F', fg: r('SI=F')?.f, cat: 'Commodities' },
    { name: 'Oil', sym: 'CL=F', fg: r('CL=F')?.f, cat: 'Commodities' },
    { name: 'Copper', sym: 'HG=F', fg: r('HG=F')?.f, cat: 'Commodities' },
    { name: 'Real Estate', sym: 'VNQ', fg: r('VNQ')?.f, cat: 'Real Estate' },
    { name: 'US Dollar', sym: 'UUP', fg: r('UUP')?.f, cat: 'Currency' },
    { name: 'Bitcoin', sym: 'BTC', fg: r('BTC')?.f, cat: 'Crypto' },
    { name: 'Ethereum', sym: 'ETH', fg: r('ETH')?.f, cat: 'Crypto' },
    { name: 'Altcoins', sym: null, fg: catAvg('Crypto Mid'), cat: 'Crypto' },
    { name: 'ASX Mining', sym: null, fg: catAvg('ASX Mining Micro'), cat: 'Mining' },
    { name: 'Lithium', sym: null, fg: avgFG(['ALB','SQM','PLS.AX']), cat: 'Mining' },
    { name: 'Uranium', sym: null, fg: avgFG(['CCJ','UEC','PDN.AX']), cat: 'Mining' },
  ];

  // Cycle indicators
  const emaAbove = ['SPY','QQQ','IWM','BTC','GC=F','TLT'].filter(s => (r(s)?.ch ?? 0) > 0).length;
  const riskAppetite = Math.round(((equitiesFG??0)+(cryptoFG??0)-(bondsFG??0)-(r('GC=F')?.f??0))*10)/10;
  const fgSpread = Math.round((Math.max(...barometers.map(b=>b.fg??-99)) - Math.min(...barometers.map(b=>b.fg??99)))*10)/10;
  const yieldCurveProxy = Math.round(((r('TLT')?.f??0) - (r('SHY')?.f??0))*10)/10;

  const indicators = [
    { name: '200 EMA Cross', value: emaAbove+'/6 above', status: emaAbove>=4?'BULLISH':emaAbove>=3?'MIXED':'BEARISH' },
    { name: 'F&G Spread', value: fgSpread+' pts', status: fgSpread>20?'WIDE (rotation)':'NARROW (systemic)' },
    { name: 'Risk Appetite', value: (riskAppetite>0?'+':'')+riskAppetite, status: riskAppetite>10?'RISK ON':riskAppetite<-10?'RISK OFF':'CAUTIOUS' },
    { name: 'Yield Curve', value: (yieldCurveProxy>0?'+':'')+yieldCurveProxy, status: yieldCurveProxy>0?'Steepening (recovery)':'Flattening (tightening)' },
  ];

  const stages = [
    { id: 'safety', name: 'Safety', symbols: ['GC=F', 'SI=F', 'TLT', 'GLD', 'SLV'], fg: avgFG(['GC=F', 'SI=F', 'GLD', 'SLV']) },
    { id: 'commodities', name: 'Commodities', symbols: ['GC=F', 'SI=F', 'CL=F', 'HG=F', 'PL=F'], fg: avgFG(['GC=F', 'SI=F', 'CL=F', 'HG=F', 'PL=F']) },
    { id: 'equities', name: 'Large Cap Equities', symbols: ['SPY', 'QQQ', 'AAPL', 'MSFT'], fg: catAvg('US Large Cap') },
    { id: 'smallcap', name: 'Small/Mid Cap', symbols: ['IWM'], fg: catAvg('US Mid/Small') },
    { id: 'btc_eth', name: 'BTC / ETH', symbols: ['BTC', 'ETH'], fg: avgFG(['BTC', 'ETH']) },
    { id: 'altcoins', name: 'Altcoins', symbols: ['SOL', 'AVAX', 'DOT', 'LINK'], fg: catAvg('Crypto Mid') },
    { id: 'memes', name: 'Meme / Micro', symbols: ['DOGE', 'PEPE', 'WIF', 'BONK'], fg: avgFG(['DOGE', 'PEPE', 'WIF', 'BONK']) },
  ];

  // Determine phase label
  for (const s of stages) {
    s.status = s.fg == null ? 'unknown' : s.fg >= 10 ? 'greed' : s.fg >= -5 ? 'neutral' : s.fg >= -15 ? 'fear' : 'deep_fear';
    s.emoji = { greed: '✅', neutral: '⚠️', fear: '🔴', deep_fear: '💀', unknown: '❓' }[s.status];
  }

  // Detect current phase
  const safetyFG = stages[0].fg ?? 0;
  const riskFG = avgFG(['SPY', 'BTC', 'ETH']) ?? 0;
  let phase = 'UNKNOWN';
  if (safetyFG > 5 && riskFG < -10) phase = 'RISK OFF — Money in safety, avoid risk assets';
  else if (safetyFG > 0 && riskFG > -5) phase = 'MID CYCLE — Balanced, selective opportunities';
  else if (riskFG > 10) phase = 'RISK ON — Money flowing into risk assets';
  else if (safetyFG < -5 && riskFG < -15) phase = 'CAPITULATION — Everything selling, potential bottom';
  else phase = 'EARLY FEAR — Monitor for rotation signals';

  // Lead-lag analysis
  const leadLag = [
    { leader: 'GC=F', follower: 'SI=F', names: ['Gold', 'Silver'] },
    { leader: 'SPY', follower: 'IWM', names: ['S&P 500', 'Small Caps'] },
    { leader: 'BTC', follower: 'ETH', names: ['Bitcoin', 'Ethereum'] },
  ].map(pair => {
    const lFG = r(pair.leader)?.f, fFG = r(pair.follower)?.f;
    const gap = lFG != null && fFG != null ? Math.round((lFG - fFG) * 10) / 10 : null;
    const signal = gap > 10 ? 'Follower lagging — potential opportunity' : gap < -10 ? 'Follower leading — unusual' : 'In sync';
    return { ...pair, leaderFG: lFG, followerFG: fFG, gap, signal };
  });

  // Altcoin season: % of top alts with higher F&G than BTC
  const btcFG = r('BTC')?.f ?? -999;
  const topAlts = ['ETH', 'SOL', 'XRP', 'BNB', 'ADA', 'DOGE', 'AVAX', 'DOT', 'LINK', 'ATOM',
    'UNI', 'AAVE', 'LTC', 'NEAR', 'ARB', 'OP', 'APT', 'INJ', 'SUI', 'SEI', 'PEPE', 'HBAR', 'ALGO', 'FTM',
    'BONK', 'WIF', 'PENDLE', 'IMX', 'MKR', 'SAND', 'MANA', 'FET', 'STX', 'TIA', 'JUP'];
  const altScores = topAlts.map(s => r(s)?.f).filter(v => v != null);
  const altsBeatBTC = altScores.filter(v => v > btcFG).length;
  const altSeasonPct = altScores.length > 0 ? Math.round(altsBeatBTC / altScores.length * 100) : 0;
  const altSeason = altSeasonPct >= 75 ? 'ALT SEASON' : altSeasonPct <= 25 ? 'BTC SEASON' : 'NEUTRAL';

  // Mining rotation
  const mining = [
    { name: 'Gold Price', syms: ['GC=F'], fg: r('GC=F')?.f },
    { name: 'Gold Major', syms: ['NEM','GOLD','AEM','ABX.TO','NST.AX','EVN.AX','GLEN.L','ANG.JO'], fg: avgFG(['NEM','GOLD','AEM','ABX.TO','NST.AX','EVN.AX','GLEN.L','ANG.JO']) },
    { name: 'Gold Mid', syms: ['AGI','BTG','SA','GOR.AX','RMS.AX','FR.TO'], fg: avgFG(['AGI','BTG','SA','GOR.AX','RMS.AX','FR.TO']) },
    { name: 'Gold Micro', syms: ['DEV.AX','LOT.AX','WR1.AX','CHR.AX'], fg: avgFG(['DEV.AX','LOT.AX','WR1.AX','CHR.AX']) },
    { name: 'Silver', syms: ['AG','HL','PAAS','SI=F'], fg: avgFG(['AG','HL','PAAS','SI=F']) },
    { name: 'Copper', syms: ['FCX','SCCO','HG=F','SFR.AX'], fg: avgFG(['FCX','SCCO','HG=F','SFR.AX']) },
    { name: 'Lithium', syms: ['ALB','SQM','PLS.AX','LTR.AX','IGO.AX'], fg: avgFG(['ALB','SQM','PLS.AX','LTR.AX','IGO.AX']) },
    { name: 'Uranium', syms: ['CCJ','UEC','PDN.AX','BOE.AX'], fg: avgFG(['CCJ','UEC','PDN.AX','BOE.AX']) },
  ];

  res.json({
    // Macro cycle
    macroStage, barometers, assetTable, indicators,
    // Existing
    stages, phase, leadLag,
    altSeason: { pct: altSeasonPct, label: altSeason, btcFG, altsAbove: altsBeatBTC, altsTotal: altScores.length },
    mining, breadth: DATA.stats.breadth,
  });
});

// Cycle history from saved snapshots
app.get('/api/cycle-history', (req, res) => {
  try {
    const histDir = join(HOME, '.tradingview-mcp', 'history');
    if (!existsSync(histDir)) return res.json({ snapshots: [] });
    const files = readdirSync(histDir).filter(f => f.startsWith('snapshot-') && f.endsWith('.json')).sort();
    const snapshots = files.map(f => {
      try { return JSON.parse(readFileSync(join(histDir, f), 'utf8')); } catch { return null; }
    }).filter(Boolean);
    res.json({ snapshots, count: snapshots.length });
  } catch (e) { res.json({ snapshots: [], error: e.message }); }
});

app.post('/api/open-in-tv', async (req, res) => {
  try {
    const { setSymbol } = await import('../core/chart.js');
    await setSymbol({ symbol: req.body?.symbol });
    res.json({ success: true });
  } catch (e) { res.json({ error: e.message?.slice(0, 60) }); }
});

// ─── Serve HTML ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => { res.sendFile(join(__dirname, 'index.html')); });

// ─── Background Worker ──────────────────────────────────────────────────────

const workerStatus = { state: 'idle', current: null, warmed: 0, total: 0, errors: 0 };
const TF_TTL = { '15': 30 * 60e3, '60': 2 * 3600e3, '240': 8 * 3600e3, 'D': 24 * 3600e3, 'W': 7 * 24 * 3600e3 };
const TOP_100 = new Set(['BTC','ETH','SOL','XRP','BNB','DOGE','ADA','AVAX','DOT','LINK','SHIB','UNI','AAVE','LTC','NEAR',
  'ATOM','FTM','APT','ARB','OP','SUI','SEI','INJ','PEPE','AAPL','MSFT','GOOG','AMZN','NVDA','META','TSLA','JPM','V',
  'UNH','XOM','MA','HD','PG','JNJ','NFLX','BAC','CRM','AMD','COST','ORCL','KO','PEP','DIS','BA','WMT','SPY','QQQ',
  'GLD','GC=F','SI=F','CL=F','BHP.AX','RIO.AX','CBA.AX','CSL.AX','FMG.AX','NST.AX','EVN.AX','PLS.AX','DEV.AX',
  'IWM','DIA','ARKK','GDX','SLV','TLT','XLK','XLF','XLE','SOFI','PLTR','COIN','CRWD','SHOP','SNOW','DKNG',
  'MARA','RIOT','HOOD','SQ','NET','ABNB','RBLX','ZM','ROKU','PINS','SNAP','DASH','COIN','U','LYFT']);

async function bgWorkerLoop() {
  const { computeTimeSeries } = await import('../core/fg_backtest.js');

  // Build priority queue
  function buildQueue() {
    const cache = loadCache();
    const now = Date.now();
    const queue = [];
    const allTFs = ['D', '60', '240', '15', 'W'];

    // Priority 1: Watchlist × all TFs
    for (const sym of FAVS) for (const tf of allTFs) queue.push({ sym, tf, pri: 1 });
    // Priority 2: Top 100 × all TFs
    for (const sym of TOP_100) for (const tf of allTFs) queue.push({ sym, tf, pri: 2 });
    // Priority 3: Recently viewed × all TFs
    for (const sym of recentViews) for (const tf of allTFs) queue.push({ sym, tf, pri: 3 });

    // Deduplicate and filter out fresh entries
    const seen = new Set();
    return queue.filter(item => {
      const key = `${item.sym}:${item.tf}`;
      if (seen.has(key)) return false;
      seen.add(key);
      const entry = cache[key];
      if (entry?.lastScanTime) {
        const age = now - new Date(entry.lastScanTime).getTime();
        if (age < (TF_TTL[item.tf] || 86400e3)) return false; // Still fresh
      }
      return true;
    }).sort((a, b) => a.pri - b.pri);
  }

  while (true) {
    const queue = buildQueue();
    workerStatus.total = queue.length;
    workerStatus.warmed = 0;
    workerStatus.errors = 0;

    if (queue.length === 0) {
      workerStatus.state = 'idle';
      workerStatus.current = null;
      await new Promise(r => setTimeout(r, 60000)); // Sleep 1 min when nothing to do
      continue;
    }

    workerStatus.state = 'running';
    for (const item of queue) {
      workerStatus.current = `${item.sym}:${item.tf}`;
      try {
        const bars = await fetchBars(item.sym, item.tf);
        if (bars && bars.length >= 30) {
          const series = computeTimeSeries(bars);
          if (series.length > 0) {
            cacheScore(item.sym, item.tf, series, bars);
            workerStatus.warmed++;
          }
        }
      } catch { workerStatus.errors++; }

      if (workerStatus.warmed % 50 === 0 && workerStatus.warmed > 0) {
        console.log(`Background: warmed ${workerStatus.warmed}/${queue.length} (${workerStatus.errors} errors)`);
        rebuildData(); // Refresh dashboard data periodically
      }
      await new Promise(r => setTimeout(r, 1200)); // Rate limit: ~50/min
    }

    console.log(`Background cycle done: ${workerStatus.warmed} warmed, ${workerStatus.errors} errors`);
    rebuildData();
    await new Promise(r => setTimeout(r, 30000)); // 30s pause between cycles
  }
}

// ─── Push Notifications for Grade A Signals ─────────────────────────────────

let previousGradeA = new Set();
const NTFY_TOPIC = 'kieran-fg-signals';

async function checkNewSignals() {
  const gradeA = DATA.rows.filter(r => r.sg === 'A').map(r => r.s);
  const newSignals = gradeA.filter(s => !previousGradeA.has(s));

  if (newSignals.length > 0) {
    for (const sym of newSignals.slice(0, 5)) { // Max 5 notifications per cycle
      const row = DATA.rows.find(r => r.s === sym);
      if (!row) continue;
      const body = `${sym} scored ${row.sq}/100. F&G: ${row.f} (${row.z}). ${(row.sf||[])[0]?.name||''}: ${(row.sf||[])[0]?.val||''}. Price: $${row.p >= 1 ? row.p.toFixed(2) : row.p.toExponential(2)}`;
      try {
        await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
          method: 'POST',
          headers: { 'Title': `Grade A: ${sym}`, 'Priority': 'high', 'Tags': 'chart_with_downwards_trend' },
          body,
          signal: AbortSignal.timeout(5000),
        });
        console.log(`Notification sent: ${sym} (${row.sq}/100)`);
      } catch {}
    }
    if (newSignals.length > 5) console.log(`+${newSignals.length - 5} more Grade A signals (capped at 5 notifications)`);
  }

  previousGradeA = new Set(gradeA);
}

// ─── Forward Tracker — auto-log all entry signals ───────────────────────────

const TRACKING_FILE = join(HOME, '.tradingview-mcp', 'tracking', 'auto_signals.json');

function loadTracking() {
  try { return JSON.parse(readFileSync(TRACKING_FILE, 'utf8')); }
  catch { return { signals: [], started: new Date().toISOString() }; }
}

function saveTracking(data) {
  const dir = join(HOME, '.tradingview-mcp', 'tracking');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(TRACKING_FILE, JSON.stringify(data, null, 2));
}

let previousEntrySet = new Set();

function autoTrackSignals() {
  const tracking = loadTracking();
  const currentEntries = DATA.rows.filter(r => r.w === 'ENTRY ZONE');
  const currentSet = new Set(currentEntries.map(r => r.s));

  // Log NEW entry zone signals
  for (const r of currentEntries) {
    if (previousEntrySet.has(r.s)) continue; // Already tracked
    if (tracking.signals.find(s => s.symbol === r.s && s.status === 'OPEN')) continue; // Already open
    tracking.signals.push({
      symbol: r.s, logDate: new Date().toISOString(), entryPrice: r.p,
      fg: r.f, grade: r.sg || 'D', score: r.sq || 0, category: r.c, status: 'OPEN',
    });
  }

  // Update open signals with current price and check exits
  for (const sig of tracking.signals) {
    if (sig.status !== 'OPEN') continue;
    const row = DATA.rows.find(r => r.s === sig.symbol);
    if (!row) continue;
    sig.currentPrice = row.p;
    sig.currentFG = row.f;
    sig.pnl = sig.entryPrice > 0 ? Math.round((row.p - sig.entryPrice) / sig.entryPrice * 10000) / 100 : 0;
    sig.daysHeld = Math.floor((Date.now() - new Date(sig.logDate).getTime()) / 86400000);
    // Auto-close conditions
    if (row.w === 'TAKE PROFIT' || row.w === 'EXIT ZONE') {
      sig.status = 'EXIT_SIGNAL'; sig.exitDate = new Date().toISOString(); sig.exitPrice = row.p;
    } else if (sig.daysHeld >= 60) {
      sig.status = 'MAX_HOLD'; sig.exitDate = new Date().toISOString(); sig.exitPrice = row.p;
    }
  }

  saveTracking(tracking);
  previousEntrySet = currentSet;
}

// Performance endpoint
app.get('/api/performance', (req, res) => {
  const tracking = loadTracking();
  const open = tracking.signals.filter(s => s.status === 'OPEN');
  const closed = tracking.signals.filter(s => s.status !== 'OPEN');
  const wins = closed.filter(s => s.pnl > 0);
  const allPnl = closed.map(s => s.pnl).filter(v => v != null);
  const gradeA = tracking.signals.filter(s => s.grade === 'A');
  const gradeAClosed = gradeA.filter(s => s.status !== 'OPEN');
  const gradeAWins = gradeAClosed.filter(s => s.pnl > 0);

  res.json({
    started: tracking.started,
    totalSignals: tracking.signals.length,
    openSignals: open.length,
    closedSignals: closed.length,
    winRate: closed.length > 0 ? Math.round(wins.length / closed.length * 100) : null,
    avgReturn: allPnl.length > 0 ? Math.round(allPnl.reduce((a, b) => a + b, 0) / allPnl.length * 100) / 100 : null,
    bestTrade: closed.length > 0 ? closed.reduce((b, s) => (s.pnl || 0) > (b.pnl || 0) ? s : b, closed[0]) : null,
    worstTrade: closed.length > 0 ? closed.reduce((w, s) => (s.pnl || 0) < (w.pnl || 0) ? s : w, closed[0]) : null,
    gradeA: { total: gradeA.length, closed: gradeAClosed.length, winRate: gradeAClosed.length > 0 ? Math.round(gradeAWins.length / gradeAClosed.length * 100) : null },
    recentSignals: tracking.signals.slice(-20).reverse(),
  });
});

// ─── Daily Report Auto-Generation ───────────────────────────────────────────

let lastReportDate = '';
function generateDailyReport() {
  const today = new Date().toISOString().slice(0, 10);
  if (today === lastReportDate) return;
  lastReportDate = today;

  const tracking = loadTracking();
  const open = tracking.signals.filter(s => s.status === 'OPEN');
  const closed = tracking.signals.filter(s => s.status !== 'OPEN');
  const gradeA = DATA.rows.filter(r => r.sg === 'A');
  const gradeB = DATA.rows.filter(r => r.sg === 'B');

  const report = `# Daily F&G Report — ${today}\n\n` +
    `## Market Status\n` +
    `- Symbols: ${DATA.stats.total}\n` +
    `- Avg F&G: ${DATA.stats.avgFG}\n` +
    `- Entry Zones: ${DATA.rows.filter(r => r.w === 'ENTRY ZONE').length}\n` +
    `- Breadth: ${JSON.stringify(DATA.stats.breadth)}\n\n` +
    `## Signals\n` +
    `- Grade A: ${gradeA.length}\n` +
    `- Grade B: ${gradeB.length}\n\n` +
    `## Forward Performance\n` +
    `- Tracking since: ${tracking.started}\n` +
    `- Open: ${open.length} | Closed: ${closed.length}\n` +
    (closed.length > 0 ? `- Win Rate: ${Math.round(closed.filter(s => s.pnl > 0).length / closed.length * 100)}%\n` : '') +
    `\n## Grade A Signals\n` +
    gradeA.slice(0, 10).map(s => `- ${s.s}: F&G ${s.f}, Score ${s.sq}`).join('\n') + '\n';

  const dir = join(HOME, 'tradingview-mcp-jackson', 'reports', 'daily');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, today + '.md'), report);
  console.log('Daily report saved:', today);
}

// ─── Start ──────────────────────────────────────────────────────────────────

rebuildData();
// Run initial tracking on boot
setTimeout(() => { autoTrackSignals(); generateDailyReport(); }, 5000);

setInterval(() => {
  rebuildData();
  checkNewSignals();
  autoTrackSignals();
  generateDailyReport();
}, 300000); // Every 5 minutes

// Get local network IP for phone access
import { networkInterfaces } from 'os';
function getLocalIP() {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

app.listen(PORT, '0.0.0.0', () => {
  const mem = process.memoryUsage();
  const ip = getLocalIP();
  console.log(`F&G Dashboard: http://localhost:${PORT}`);
  console.log(`Network:       http://${ip}:${PORT}`);
  console.log(`Symbols: ${DATA.stats.total} | Memory: ${Math.round(mem.heapUsed / 1e6)}MB`);
  // Start background worker after 10s delay
  setTimeout(() => {
    console.log('Background worker starting...');
    bgWorkerLoop().catch(e => console.error('Worker error:', e.message));
  }, 10000);
});

// ─── Self-healing: crash handlers + heartbeat ────────────────────────────────

function gracefulShutdown(sig) {
  console.log(`Received ${sig}, saving cache...`);
  try { _saveCache(loadCache()); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err.message, err.stack?.slice(0, 200));
  try { _saveCache(loadCache()); } catch {}
  // Don't exit — let launchd KeepAlive restart us
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', String(reason).slice(0, 200));
});

// Heartbeat log every 5 minutes
const HEARTBEAT_FILE = join(HOME, '.tradingview-mcp', 'logs', 'heartbeat.log');
setInterval(() => {
  try {
    const dir = join(HOME, '.tradingview-mcp', 'logs');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const mem = process.memoryUsage();
    const entry = JSON.stringify({
      t: new Date().toISOString(), up: Math.round(process.uptime()),
      mem: Math.round(mem.heapUsed / 1e6) + 'MB', syms: DATA.stats?.total || 0,
      worker: workerStatus.state, warmed: workerStatus.warmed,
    }) + '\n';
    writeFileSync(HEARTBEAT_FILE, entry, { flag: 'a' });
  } catch {}
}, 300000);
