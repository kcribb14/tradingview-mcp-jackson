/**
 * F&G Dashboard Web Server — localhost:3000
 */
import express from 'express';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { loadCache } from '../core/fg_cache.js';
import { detectAssetClass, classifyCalibratedZone } from '../core/fg_calibrated.js';
import { addToken, discoverTokens, loadDexTokens } from '../core/dex_universe.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
const PORT = 3000;
const HOME = process.env.HOME || process.env.USERPROFILE || '/tmp';

// ─── Load crypto market caps from CoinGecko cache ──────────────────────────

let cryptoMcaps = new Map();
try {
  const cFile = join(HOME, '.tradingview-mcp', 'universes', 'crypto_tokens.json');
  if (existsSync(cFile)) {
    const tokens = JSON.parse(readFileSync(cFile, 'utf8'));
    for (const t of tokens) {
      if (t.symbol && t.market_cap) cryptoMcaps.set(t.symbol.toUpperCase(), t.market_cap);
    }
  }
} catch {}

// Rough market cap tiers for stocks (by symbol recognition)
const MEGA_CAPS = new Set(['AAPL','MSFT','GOOG','AMZN','NVDA','META','TSLA','BRK-B','AVGO','LLY','JPM','V','UNH','XOM','MA','COST','HD','PG','JNJ','ABBV','WMT','NFLX','BAC','CRM','ORCL','CVX','MRK','KO','PEP','AMD','TMO','CSCO']);
const LARGE_CAPS = new Set(['ADBE','ACN','ABT','MCD','IBM','DHR','QCOM','INTU','ISRG','GE','VZ','TXN','BKNG','PFE','RTX','AMGN','LMT','NOW','AMAT','GS','BLK','CAT','HON','LOW','DE','BA','DIS','CI','BMY','SO','DUK','NEE','WFC','SCHW','CME','MCO','MU']);
const ASX_LARGE = new Set(['BHP','RIO','CBA','WBC','NAB','ANZ','CSL','WES','MQG','FMG','TLS','GMG','WOW']);

function estimateMcap(sym, price) {
  // Crypto: use cached CoinGecko data
  const cmc = cryptoMcaps.get(sym.toUpperCase());
  if (cmc) return cmc;
  // Stocks: rough tiers
  const base = sym.replace('.AX', '').replace('.L', '').replace('.TO', '');
  if (MEGA_CAPS.has(base)) return 1e12 + Math.random() * 2e12;
  if (LARGE_CAPS.has(base)) return 1e11 + Math.random() * 5e11;
  if (ASX_LARGE.has(base)) return 5e10 + Math.random() * 2e11;
  if (sym.endsWith('.AX')) return 5e7 + Math.random() * 5e9;
  if (sym.endsWith('.L')) return 1e8 + Math.random() * 1e10;
  // US mid/small default
  if (price > 100) return 5e9 + Math.random() * 5e10;
  if (price > 10) return 1e9 + Math.random() * 1e10;
  return 1e8 + Math.random() * 5e9;
}

// ─── API ────────────────────────────────────────────────────────────────────

app.get('/api/cached', (req, res) => {
  try {
    const tf = req.query.tf || 'D';
    const category = req.query.category || null;
    const data = buildData(tf, category);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/history', (req, res) => {
  try {
    const histDir = join(HOME, '.tradingview-mcp', 'history');
    if (!existsSync(histDir)) return res.json([]);
    const files = readdirSync(histDir).filter(f => f.startsWith('fg-')).sort().reverse().slice(0, 30);
    const snapshots = files.map(f => {
      try { return JSON.parse(readFileSync(join(histDir, f), 'utf8')); } catch { return null; }
    }).filter(Boolean);
    res.json(snapshots);
  } catch { res.json([]); }
});

app.use(express.json());

app.post('/api/add-token', async (req, res) => {
  try {
    const result = await addToken(req.body.url || req.body.address || '');
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/discover', async (req, res) => {
  try { res.json(await discoverTokens()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => { res.sendFile(join(__dirname, 'index.html')); });

// ─── Build data ─────────────────────────────────────────────────────────────

function buildData(tf, categoryFilter) {
  const cache = loadCache();
  const sfxMap = { '15m': ':15', '15': ':15', '1h': ':60', '60': ':60', '4h': ':240', '240': ':240', 'd': ':D', 'daily': ':D', 'w': ':W', 'weekly': ':W' };
  const requestedSuffix = sfxMap[tf.toLowerCase()] || ':D';
  const tfLabel = { ':15': '15m', ':60': '1H', ':240': '4H', ':D': 'Daily', ':W': 'Weekly' }[requestedSuffix];

  // Collect ALL TF scores per symbol (keyed by Daily as primary)
  const symbolData = new Map();
  for (const [key, entry] of Object.entries(cache)) {
    if (entry?.fgScore == null) continue;
    const lastColon = key.lastIndexOf(':');
    const sym = key.substring(0, lastColon);
    const sfx = key.substring(lastColon);
    if (!symbolData.has(sym)) symbolData.set(sym, {});
    const tfKey = { ':15': 'fg_15m', ':60': 'fg_1H', ':240': 'fg_4H', ':D': 'fg_D', ':W': 'fg_W' }[sfx];
    if (tfKey) {
      symbolData.get(sym)[tfKey] = entry.fgScore;
      if (sfx === ':D') {
        symbolData.get(sym)._daily = entry; // keep full daily entry
      }
    }
  }

  // Build rows — require at least Daily data
  const rows = [];
  for (const [sym, tfScores] of symbolData) {
    const entry = tfScores._daily;
    if (!entry) continue; // skip symbols without daily
    const cls = detectAssetClass(sym);
    const catLabel = { US_LARGE_CAP: 'US Large Cap', US_MID_SMALL: 'US Mid/Small', ASX_TOP50: 'ASX Top 50', ASX_MINING_MID: 'ASX Mining Mid', ASX_MINING_MICRO: 'ASX Mining Micro', CRYPTO_MAJOR: 'Crypto Major', CRYPTO_MID: 'Crypto Mid', COMMODITIES: 'Commodities', ETFS: 'ETFs' }[cls] || cls;

    if (categoryFilter && cls !== categoryFilter && catLabel !== categoryFilter) continue;

    // Primary F&G: use requested TF, fall back to daily
    const fgKey = { ':15': 'fg_15m', ':60': 'fg_1H', ':240': 'fg_4H', ':D': 'fg_D', ':W': 'fg_W' }[requestedSuffix] || 'fg_D';
    const fg = tfScores[fgKey] ?? tfScores.fg_D ?? entry.fgScore;
    const price = entry.lastClose || 0;
    const mcap = estimateMcap(sym, price);

    let zn;
    if (fg <= -30) zn = 'EXTREME FEAR'; else if (fg <= -15) zn = 'FEAR'; else if (fg <= -5) zn = 'WEAK FEAR';
    else if (fg <= 5) zn = 'NEUTRAL'; else if (fg <= 15) zn = 'WEAK GREED'; else if (fg <= 30) zn = 'GREED';
    else zn = 'EXTREME GREED';

    const cal = classifyCalibratedZone(sym, fg);
    let sw = '';
    if (cal.severity <= -2) sw = 'ENTRY ZONE'; else if (cal.severity === -1) sw = 'WATCHING';
    else if (cal.severity >= 2) sw = 'TAKE PROFIT'; else if (cal.severity === 1) sw = 'EXIT ZONE';

    const tier = ['US_LARGE_CAP', 'ASX_MINING_MID', 'ASX_MINING_MICRO', 'COMMODITIES'].includes(cls) ? 1 :
      ['US_MID_SMALL', 'ETFS', 'ASX_TOP50', 'CRYPTO_MAJOR'].includes(cls) ? 2 : 3;

    rows.push({
      symbol: sym, fg, zone: zn, category: catLabel, cls, tier, swing: sw, rsi: entry.rsi, price, mcap,
      fg_15m: tfScores.fg_15m ?? null, fg_1H: tfScores.fg_1H ?? null,
      fg_4H: tfScores.fg_4H ?? null, fg_D: tfScores.fg_D ?? entry.fgScore,
      fg_W: tfScores.fg_W ?? null,
    });
  }

  rows.sort((a, b) => a.fg - b.fg);

  // Category stats
  const cats = {};
  for (const r of rows) {
    if (!cats[r.category]) cats[r.category] = { n: 0, sum: 0, fear: 0, greed: 0, entry: 0 };
    cats[r.category].n++;
    cats[r.category].sum += r.fg;
    if (r.fg <= -5) cats[r.category].fear++;
    if (r.fg >= 5) cats[r.category].greed++;
    if (r.swing === 'ENTRY ZONE') cats[r.category].entry++;
  }
  const catList = Object.entries(cats).map(([cat, s]) => ({
    name: cat, count: s.n, avg: Math.round(s.sum / s.n * 100) / 100,
    pctFear: Math.round(s.fear / s.n * 100), pctGreed: Math.round(s.greed / s.n * 100), entries: s.entry,
  })).sort((a, b) => a.avg - b.avg);

  const avgFG = rows.length > 0 ? Math.round(rows.reduce((s, r) => s + r.fg, 0) / rows.length * 100) / 100 : 0;

  // Add DEX tokens
  const dexTokens = loadDexTokens();
  const seenSymbols = new Set(rows.map(r => r.symbol));
  for (const token of dexTokens) {
    if (seenSymbols.has(token.symbol)) continue;
    seenSymbols.add(token.symbol);

    const catByMcap = token.mcap > 50e9 ? 'Crypto Mega' : token.mcap > 1e9 ? 'Crypto Large' :
      token.mcap > 100e6 ? 'Crypto Mid' : token.mcap > 10e6 ? 'Crypto Small' :
      token.mcap > 1e6 ? 'Crypto Micro' : 'Crypto Nano';
    const catLabel = token.source === 'dexscreener' || token.source === 'boosted' || token.source === 'search'
      ? 'DEX ' + (token.chain || '').charAt(0).toUpperCase() + (token.chain || '').slice(1)
      : catByMcap;

    if (categoryFilter && catLabel !== categoryFilter) continue;

    let zn;
    const fg = token.fg ?? 0;
    if (fg >= 73) zn = 'Euphoria'; else if (fg >= 41) zn = 'Thrill'; else if (fg >= 10) zn = 'Excitement';
    else if (fg >= 5) zn = 'Optimism'; else if (fg >= -5) zn = 'Balanced'; else if (fg >= -10) zn = 'Anxiety';
    else if (fg >= -25) zn = 'Fear'; else if (fg >= -41) zn = 'Panic'; else zn = 'Despondency';

    rows.push({
      symbol: token.symbol, fg, zone: zn, category: catLabel, cls: 'DEX',
      tier: 3, swing: '', rsi: null, price: token.price, mcap: token.mcap || 1e6,
      fg_15m: null, fg_1H: null, fg_4H: null, fg_D: fg, fg_W: null,
    });
  }

  rows.sort((a, b) => a.fg - b.fg);

  // Count available TFs
  const tfCounts = { '15m': 0, '1H': 0, '4H': 0, 'Daily': rows.length, 'Weekly': 0 };
  for (const r of rows) {
    if (r.fg_15m != null) tfCounts['15m']++;
    if (r.fg_1H != null) tfCounts['1H']++;
    if (r.fg_4H != null) tfCounts['4H']++;
    if (r.fg_W != null) tfCounts['Weekly']++;
  }

  return {
    tf: tfLabel, updated: new Date().toISOString(), total: rows.length,
    avgFG, oversold: rows.filter(r => r.fg <= -25).length, overbought: rows.filter(r => r.fg >= 25).length,
    pctOversold: rows.length > 0 ? Math.round(rows.filter(r => r.fg <= -25).length / rows.length * 100) : 0,
    pctOverbought: rows.length > 0 ? Math.round(rows.filter(r => r.fg >= 25).length / rows.length * 100) : 0,
    categories: catList, rows, tfCounts,
  };
}

app.listen(PORT, () => {
  const cache = loadCache();
  console.log(`F&G Dashboard running at http://localhost:${PORT}`);
  console.log(`Serving ${Object.keys(cache).filter(k => k.endsWith(':D')).length} cached symbols`);
});
