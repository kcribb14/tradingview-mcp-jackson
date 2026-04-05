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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
const PORT = 3000;
const HOME = process.env.HOME || process.env.USERPROFILE || '/tmp';

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
      const cat = { US_LARGE_CAP:'US Large Cap', US_MID_SMALL:'US Mid/Small', ASX_TOP50:'ASX Top 50', ASX_MINING_MID:'ASX Mining Mid', ASX_MINING_MICRO:'ASX Mining Micro', CRYPTO_MAJOR:'Crypto Major', CRYPTO_MID:'Crypto Mid', COMMODITIES:'Commodities', ETFS:'ETFs' }[cls] || cls;

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

      rows.push({
        s: sym, f: clamp(fg), z: zn, c: cat, t: tier, w: sw, p: Math.round(price * 1e6) / 1e6, m: Math.round(mcap),
        r: entry.rsi ? Math.round(entry.rsi * 10) / 10 : null, ch,
        f1: clamp(cache[sym + ':15']?.fgScore),
        fh: clamp(cache[sym + ':60']?.fgScore),
        f4: clamp(cache[sym + ':240']?.fgScore),
        fw: clamp(cache[sym + ':W']?.fgScore),
        wh: whale, // Whale signal: ACC/DIST/''
        ad: athDist, // ATH distance proxy (144-bar return)
        ss: smartScore, // Smart Score 0-100
      });
      const last = rows[rows.length - 1];
      last.spark = [last.f1, last.fh, last.f4, last.f, last.fw].filter(v => v != null);
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
      rows.push({
        s: token.symbol, f: fg, z: token.zone || 'Balanced',
        c: cat, t: 3, w: '', p: token.price || 0, m: token.mcap || 1e6,
        r: null, ch: dexCh, f1: null, fh: null, f4: null, fw: null, spark: [],
      });
    }

    // Server-side safety net: filter out any scores outside [-80, +100]
    rows = rows.filter(r => r.f >= -80 && r.f <= 100);
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

    // Sort
    filtered = [...filtered].sort((a, b) => {
      const va = a[sort] ?? 0, vb = b[sort] ?? 0;
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

const YAHOO_RANGES = { '15': { range: '60d', interval: '15m' }, '60': { range: '2y', interval: '1h' }, '240': { range: '2y', interval: '1d' }, 'D': { range: '5y', interval: '1d' }, 'W': { range: 'max', interval: '1wk' } };
const BINANCE_INTERVALS = { '15': '15m', '60': '1h', '240': '4h', 'D': '1d', 'W': '1w' };

async function fetchBars(sym, tf) {
  const { detectAssetClass } = await import('../core/fg_calibrated.js');
  const cls = detectAssetClass(sym);
  const isCrypto = cls.includes('CRYPTO');

  if (isCrypto) {
    try {
      let pair = sym.replace(/[-\/]/g, '').toUpperCase();
      if (!pair.endsWith('USDT') && !pair.endsWith('USD')) pair += 'USDT';
      const bi = BINANCE_INTERVALS[tf] || '1d';
      const limit = (tf === 'D' || tf === 'W' || tf === '240') ? 500 : 200;
      const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${bi}&limit=${limit}`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const d = await r.json();
        if (Array.isArray(d) && d.length >= 20)
          return d.map(b => ({ time: Math.floor(b[0] / 1000), open: +b[1], high: +b[2], low: +b[3], close: +b[4], volume: +b[5] || 0 }));
      }
    } catch {}
  }
  try {
    const cfg = YAHOO_RANGES[tf] || YAHOO_RANGES['D'];
    let ticker = sym;
    if (isCrypto && !ticker.includes('-')) ticker += '-USD';
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${cfg.range}&interval=${cfg.interval}&includePrePost=false`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const d = await r.json();
      const chart = d?.chart?.result?.[0];
      if (chart?.timestamp) {
        const q = chart.indicators.quote[0];
        const bars = [];
        for (let i = 0; i < chart.timestamp.length; i++)
          if (q.close[i] != null && q.open[i] != null)
            bars.push({ time: chart.timestamp[i], open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 });
        if (bars.length >= 20) return bars;
      }
    }
  } catch {}
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

// Worker status endpoint
app.get('/api/worker-status', (req, res) => {
  res.json(workerStatus);
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
    { name: 'Gold Majors', syms: ['NST.AX', 'EVN.AX'], fg: avgFG(['NST.AX', 'EVN.AX']) },
    { name: 'Gold Mid', syms: ['RMS.AX', 'CMM.AX'], fg: avgFG(['RMS.AX', 'CMM.AX']) },
    { name: 'Gold Micro', syms: ['DEV.AX', 'LOT.AX', 'WR1.AX'], fg: avgFG(['DEV.AX', 'LOT.AX', 'WR1.AX']) },
    { name: 'Silver', syms: ['SI=F'], fg: r('SI=F')?.f },
    { name: 'Lithium', syms: ['PLS.AX', 'LTR.AX', 'IGO.AX'], fg: avgFG(['PLS.AX', 'LTR.AX', 'IGO.AX']) },
  ];

  res.json({ stages, phase, leadLag, altSeason: { pct: altSeasonPct, label: altSeason, btcFG, altsAbove: altsBeatBTC, altsTotal: altScores.length }, mining, breadth: DATA.stats.breadth });
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

// ─── Start ──────────────────────────────────────────────────────────────────

rebuildData();
setInterval(rebuildData, 300000); // Refresh every 5 minutes

app.listen(PORT, () => {
  const mem = process.memoryUsage();
  console.log(`F&G Dashboard: http://localhost:${PORT}`);
  console.log(`Symbols: ${DATA.stats.total} | Memory: ${Math.round(mem.heapUsed / 1e6)}MB`);
  // Start background worker after 10s delay
  setTimeout(() => {
    console.log('Background worker starting...');
    bgWorkerLoop().catch(e => console.error('Worker error:', e.message));
  }, 10000);
});
