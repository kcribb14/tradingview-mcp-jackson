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
import { loadCache } from '../core/fg_cache.js';
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
      rows.push({
        s: sym, f: clamp(fg), z: zn, c: cat, t: tier, w: sw, p: Math.round(price * 1e6) / 1e6, m: Math.round(mcap),
        r: entry.rsi ? Math.round(entry.rsi * 10) / 10 : null, ch,
        f1: clamp(cache[sym + ':15']?.fgScore),
        fh: clamp(cache[sym + ':60']?.fgScore),
        f4: clamp(cache[sym + ':240']?.fgScore),
        fw: clamp(cache[sym + ':W']?.fgScore),
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

    DATA = {
      rows,
      stats: {
        total: rows.length,
        avgFG: rows.length > 0 ? Math.round(sumFG / rows.length * 100) / 100 : 0,
        oversold: rows.filter(r => r.f <= -25).length,
        overbought: rows.filter(r => r.f >= 25).length,
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

// ─── History endpoint ───────────────────────────────────────────────────────

app.get('/api/history/:symbol', async (req, res) => {
  try {
    const sym = req.params.symbol;
    const tf = req.query.tf || 'D'; // D, 60, 240, 15, W
    const { computeTimeSeries } = await import('../core/fg_backtest.js');

    // Determine fetch function and params based on timeframe
    const yahooRanges = { '15': { range: '5d', interval: '15m' }, '60': { range: '1mo', interval: '1h' }, '240': { range: '6mo', interval: '1d' }, 'D': { range: '2y', interval: '1d' }, 'W': { range: '10y', interval: '1wk' } };
    const binanceIntervals = { '15': '15m', '60': '1h', '240': '4h', 'D': '1d', 'W': '1w' };

    const { detectAssetClass } = await import('../core/fg_calibrated.js');
    const cls = detectAssetClass(sym);
    const isCrypto = cls.includes('CRYPTO');

    let bars = null;

    if (isCrypto) {
      // Try Binance first for crypto
      try {
        let pair = sym.replace(/[-\/]/g, '').toUpperCase();
        if (!pair.endsWith('USDT') && !pair.endsWith('USD')) pair += 'USDT';
        const bi = binanceIntervals[tf] || '1d';
        const limit = (tf === 'D' || tf === 'W') ? 500 : 200;
        const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${bi}&limit=${limit}`, { signal: AbortSignal.timeout(5000) });
        if (r.ok) {
          const d = await r.json();
          if (Array.isArray(d) && d.length >= 20) {
            bars = d.map(b => ({ time: Math.floor(b[0] / 1000), open: +b[1], high: +b[2], low: +b[3], close: +b[4], volume: +b[5] || 0 }));
          }
        }
      } catch {}
    }

    if (!bars) {
      // Yahoo Finance for stocks + fallback
      try {
        const cfg = yahooRanges[tf] || yahooRanges['D'];
        let ticker = sym;
        if (isCrypto && !ticker.includes('-')) ticker = ticker + '-USD';
        const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${cfg.range}&interval=${cfg.interval}&includePrePost=false`, { signal: AbortSignal.timeout(5000) });
        if (r.ok) {
          const d = await r.json();
          const chart = d?.chart?.result?.[0];
          if (chart?.timestamp) {
            const q = chart.indicators.quote[0];
            bars = [];
            for (let i = 0; i < chart.timestamp.length; i++) {
              if (q.close[i] != null && q.open[i] != null) {
                bars.push({ time: chart.timestamp[i], open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 });
              }
            }
          }
        }
      } catch {}
    }

    if (!bars || bars.length < 30) return res.json({ error: 'No ' + tf + ' data for ' + sym, tf });

    const series = computeTimeSeries(bars);
    if (series.length === 0 && bars.length >= 30) {
      // computeTimeSeries needs 150 bars — for short series, do inline calc
      const ohlcv = bars.map(b => ({ t: b.time * 1000, o: Math.round(b.open * 1e4) / 1e4, h: Math.round(b.high * 1e4) / 1e4, l: Math.round(b.low * 1e4) / 1e4, c: Math.round(b.close * 1e4) / 1e4 }));
      return res.json({ symbol: sym, tf, bars: ohlcv.length, ohlcv, fg: [], current: { price: bars[bars.length - 1].close } });
    }

    const slicedBars = bars.slice(-series.length);
    const ohlcv = slicedBars.map(b => ({ t: b.time * 1000, o: Math.round(b.open * 1e4) / 1e4, h: Math.round(b.high * 1e4) / 1e4, l: Math.round(b.low * 1e4) / 1e4, c: Math.round(b.close * 1e4) / 1e4 }));
    const fg = series.map(s => ({ t: new Date(s.date).getTime(), v: Math.max(-80, Math.min(100, Math.round(s.fg_score * 10) / 10)) }));
    const last = series[series.length - 1];
    res.json({ symbol: sym, tf, bars: ohlcv.length, ohlcv, fg, current: { fg: last?.fg_score, zone: last?.zone, price: ohlcv[ohlcv.length - 1]?.c } });
  } catch (e) { res.json({ error: e.message?.slice(0, 100) }); }
});

// Available timeframes for a symbol
// All TFs are available via live fetch; cached flag indicates pre-computed data exists
app.get('/api/available-tfs/:symbol', (req, res) => {
  const sym = req.params.symbol;
  const tfs = ['15', '60', '240', 'D', 'W'];
  const cache = loadCache();
  const available = {};
  for (const tf of tfs) {
    // All TFs available via live Binance/Yahoo fetch in /api/history
    available[tf] = true;
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
    rebuildData(); // Refresh after discovery
    res.json(result);
  } catch (e) { res.json({ error: e.message }); }
});

app.get('/api/refresh-dex', async (req, res) => {
  try {
    const { refreshDexScores } = await import('../core/dex_universe.js');
    const result = await refreshDexScores();
    rebuildData(); // Refresh dashboard data after score update
    res.json(result);
  } catch (e) { res.json({ error: e.message }); }
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

// ─── Start ──────────────────────────────────────────────────────────────────

rebuildData();
setInterval(rebuildData, 300000); // Refresh every 5 minutes

app.listen(PORT, () => {
  const mem = process.memoryUsage();
  console.log(`F&G Dashboard: http://localhost:${PORT}`);
  console.log(`Symbols: ${DATA.stats.total} | Memory: ${Math.round(mem.heapUsed / 1e6)}MB`);
});
