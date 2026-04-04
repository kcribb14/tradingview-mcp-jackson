/**
 * F&G Dashboard Web Server — serves the live dashboard at localhost:3000.
 *
 * Endpoints:
 *   GET /           — dashboard HTML page
 *   GET /api/cached — latest cached scan data (instant)
 *   GET /api/scan   — trigger fresh scan, return results
 *   GET /api/history — historical snapshots
 */
import express from 'express';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { loadCache } from '../core/fg_cache.js';
import { detectAssetClass, classifyCalibratedZone } from '../core/fg_calibrated.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
const PORT = 3000;

// ─── API: Cached data (instant) ─────────────────────────────────────────────

app.get('/api/cached', (req, res) => {
  try {
    const tf = req.query.tf || 'D';
    const category = req.query.category || null;
    const data = buildDashboardData(tf, category);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/history', (req, res) => {
  try {
    const histDir = join(homedir_(), '.tradingview-mcp', 'history');
    if (!existsSync(histDir)) return res.json([]);
    const files = readdirSync(histDir).filter(f => f.startsWith('fg-')).sort().reverse().slice(0, 30);
    const snapshots = files.map(f => {
      try { return JSON.parse(readFileSync(join(histDir, f), 'utf8')); } catch { return null; }
    }).filter(Boolean);
    res.json(snapshots);
  } catch { res.json([]); }
});

// ─── Serve HTML ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

// ─── Build dashboard data from cache ────────────────────────────────────────

function buildDashboardData(tf, categoryFilter) {
  const cache = loadCache();
  const suffix = { '15m': ':15', '15': ':15', '1h': ':60', '60': ':60', '4h': ':240', '240': ':240', 'd': ':D', 'daily': ':D', 'w': ':W', 'weekly': ':W' }[tf.toLowerCase()] || ':D';
  const tfLabel = { ':15': '15m', ':60': '1H', ':240': '4H', ':D': 'Daily', ':W': 'Weekly' }[suffix];

  let symScores = {};
  try { symScores = JSON.parse(readFileSync(join(homedir_(), '.tradingview-mcp', 'config', 'symbol_scores.json'), 'utf8')); } catch {}

  const rows = [];
  for (const [key, entry] of Object.entries(cache)) {
    if (!key.endsWith(suffix) || entry?.fgScore == null) continue;
    const sym = key.replace(suffix, '');
    const cls = detectAssetClass(sym);
    const catLabel = {
      US_LARGE_CAP: 'US Large Cap', US_MID_SMALL: 'US Mid/Small',
      ASX_TOP50: 'ASX Top 50', ASX_MINING_MID: 'ASX Mining Mid', ASX_MINING_MICRO: 'ASX Mining Micro',
      CRYPTO_MAJOR: 'Crypto Major', CRYPTO_MID: 'Crypto Mid',
      COMMODITIES: 'Commodities', ETFS: 'ETFs',
    }[cls] || cls;

    if (categoryFilter && cls !== categoryFilter && catLabel !== categoryFilter) continue;

    const fg = entry.fgScore;
    let zn, sw;
    if (fg <= -30) zn = 'EXTREME FEAR'; else if (fg <= -15) zn = 'FEAR'; else if (fg <= -5) zn = 'WEAK FEAR';
    else if (fg <= 5) zn = 'NEUTRAL'; else if (fg <= 15) zn = 'WEAK GREED'; else if (fg <= 30) zn = 'GREED';
    else zn = 'EXTREME GREED';

    const cal = classifyCalibratedZone(sym, fg);
    if (cal.severity <= -2) sw = 'ENTRY ZONE'; else if (cal.severity === -1) sw = 'WATCHING';
    else if (cal.severity >= 2) sw = 'TAKE PROFIT'; else if (cal.severity === 1) sw = 'EXIT ZONE';
    else sw = '';

    const tier = ['US_LARGE_CAP','ASX_MINING_MID','ASX_MINING_MICRO','COMMODITIES'].includes(cls) ? 1 :
      ['US_MID_SMALL','ETFS','ASX_TOP50','CRYPTO_MAJOR'].includes(cls) ? 2 : 3;

    rows.push({ symbol: sym, fg, zone: zn, category: catLabel, cls, tier, swing: sw, rsi: entry.rsi });
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
  const oversold = rows.filter(r => r.fg <= -25).length;
  const overbought = rows.filter(r => r.fg >= 25).length;

  return {
    tf: tfLabel,
    updated: new Date().toISOString(),
    total: rows.length,
    avgFG, oversold, overbought,
    pctOversold: rows.length > 0 ? Math.round(oversold / rows.length * 100) : 0,
    pctOverbought: rows.length > 0 ? Math.round(overbought / rows.length * 100) : 0,
    categories: catList,
    rows,
  };
}

function homedir_() { return process.env.HOME || process.env.USERPROFILE || '/tmp'; }

// ─── Start server ───────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`F&G Dashboard running at http://localhost:${PORT}`);
  console.log(`Serving ${Object.keys(loadCache()).length} cached symbols`);
});
