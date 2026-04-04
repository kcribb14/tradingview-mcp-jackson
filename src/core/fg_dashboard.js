/**
 * F&G Dashboard — CMC-style timeframe-toggled view.
 *
 * Toggle between 15m/1H/4H/Daily/Weekly like CMC's RSI page.
 * Shows F&G score, zone, category, and swing trade status per symbol.
 */
import { loadCache, loadGlobals } from './fg_cache.js';
import { detectAssetClass, classifyCalibratedZone } from './fg_calibrated.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const r2 = v => Math.round(v * 100) / 100;
const HISTORY_DIR = join(homedir(), '.tradingview-mcp', 'history');
const SCORES_FILE = join(homedir(), '.tradingview-mcp', 'config', 'symbol_scores.json');

const CATEGORIES = {
  US_LARGE_CAP: 'US Large Cap', US_MID_SMALL: 'US Mid/Small',
  ASX_TOP50: 'ASX Top 50', ASX_MINING_MID: 'ASX Mining Mid', ASX_MINING_MICRO: 'ASX Mining Micro',
  CRYPTO_MAJOR: 'Crypto Major', CRYPTO_MID: 'Crypto Mid',
  COMMODITIES: 'Commodities', ETFS: 'ETFs',
};

function zone(fg) {
  if (fg <= -30) return 'EXTREME FEAR';
  if (fg <= -15) return 'FEAR';
  if (fg <= -5) return 'WEAK FEAR';
  if (fg <= 5) return 'NEUTRAL';
  if (fg <= 15) return 'WEAK GREED';
  if (fg <= 30) return 'GREED';
  return 'EXTREME GREED';
}

function swingStatus(fg, cls) {
  const cal = classifyCalibratedZone('', fg); // generic
  const t = cal.thresholds;
  if (fg <= t.extreme_fear) return 'ENTRY ZONE';
  if (fg <= t.fear) return 'WATCHING';
  if (fg >= t.extreme_greed) return 'TAKE PROFIT';
  if (fg >= t.greed) return 'EXIT ZONE';
  return '—';
}

// ─── Main dashboard ─────────────────────────────────────────────────────────

export function dashboard({ tf = 'daily', category, sort, fear_only = false, extreme_only = false, top = 100, summary = false } = {}) {
  const cache = loadCache();
  let symScores = {};
  try { symScores = JSON.parse(readFileSync(SCORES_FILE, 'utf8')); } catch {}

  // Map tf parameter to cache key suffix
  const tfSuffix = { '15m': ':15', '15': ':15', '1h': ':60', '60': ':60', '4h': ':240', '240': ':240', 'daily': ':D', 'd': ':D', 'weekly': ':W', 'w': ':W' };
  const suffix = tfSuffix[tf.toLowerCase()] || ':D';
  const tfLabel = { ':15': '15m', ':60': '1H', ':240': '4H', ':D': 'Daily', ':W': 'Weekly' }[suffix] || tf;

  // Build rows
  const rows = [];
  for (const [key, entry] of Object.entries(cache)) {
    if (!key.endsWith(suffix) || entry?.fgScore == null) continue;
    const sym = key.replace(suffix, '');
    const cls = detectAssetClass(sym);
    const catLabel = CATEGORIES[cls] || cls;

    if (category) {
      const catLower = category.toLowerCase();
      if (cls.toLowerCase() !== catLower && catLabel.toLowerCase() !== catLower) continue;
    }

    const fg = entry.fgScore;
    const z = zone(fg);
    const sw = swingStatus(fg, cls);

    if (fear_only && fg > -5) continue;
    if (extreme_only && fg > -25 && fg < 25) continue;

    const tier = ['US_LARGE_CAP','ASX_MINING_MID','ASX_MINING_MICRO','COMMODITIES'].includes(cls) ? 1 :
      ['US_MID_SMALL','ETFS','ASX_TOP50','CRYPTO_MAJOR'].includes(cls) ? 2 : 3;

    rows.push({
      symbol: sym,
      fg: fg,
      zone: z,
      category: catLabel,
      class: cls,
      tier,
      swing: sw,
      rsi: entry.rsi,
      symbol_score: symScores[sym.toUpperCase()] || null,
    });
  }

  // Sort
  const sortKey = sort || 'fg';
  if (sortKey === 'symbol') rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
  else if (sortKey === 'category') rows.sort((a, b) => a.category.localeCompare(b.category) || a.fg - b.fg);
  else rows.sort((a, b) => a.fg - b.fg);

  // If summary mode, return category aggregation
  if (summary) return buildSummary(cache, tfSuffix);

  // Category summary for this TF
  const catSummary = {};
  for (const row of rows) {
    const cat = row.category;
    if (!catSummary[cat]) catSummary[cat] = { count: 0, sumFG: 0, oversold: 0, overbought: 0, fear: 0, greed: 0, entry: 0 };
    catSummary[cat].count++;
    catSummary[cat].sumFG += row.fg;
    if (row.fg <= -25) catSummary[cat].oversold++;
    if (row.fg >= 25) catSummary[cat].overbought++;
    if (row.fg <= -5) catSummary[cat].fear++;
    if (row.fg >= 5) catSummary[cat].greed++;
    if (row.swing === 'ENTRY ZONE') catSummary[cat].entry++;
  }

  const catTable = Object.entries(catSummary).map(([cat, s]) => ({
    category: cat, count: s.count, avg_fg: r2(s.sumFG / s.count),
    pct_fear: Math.round(s.fear / s.count * 100),
    pct_greed: Math.round(s.greed / s.count * 100),
    oversold: s.oversold, overbought: s.overbought, entry_signals: s.entry,
  })).sort((a, b) => a.avg_fg - b.avg_fg);

  // Market heat
  const avgFG = rows.length > 0 ? r2(rows.reduce((s, r) => s + r.fg, 0) / rows.length) : 0;
  const oversold = rows.filter(r => r.fg <= -25).length;
  const overbought = rows.filter(r => r.fg >= 25).length;

  // Save snapshot
  saveSnapshot(tfLabel, avgFG, rows.length, oversold, overbought, catSummary);

  // Load history for this TF
  const history = loadHistory(tfLabel);

  return {
    success: true,
    scan_type: 'dashboard',
    timeframe: tfLabel,
    date: new Date().toISOString().slice(0, 16).replace('T', ' '),
    market_heat: {
      avg_fg: avgFG,
      total_symbols: rows.length,
      oversold, overbought,
      pct_oversold: rows.length > 0 ? Math.round(oversold / rows.length * 100) : 0,
      pct_overbought: rows.length > 0 ? Math.round(overbought / rows.length * 100) : 0,
      sentiment: zone(avgFG),
    },
    history: history.slice(0, 5),
    categories: catTable,
    results: rows.slice(0, top),
    entry_zone: rows.filter(r => r.swing === 'ENTRY ZONE').slice(0, 20),
    exit_zone: rows.filter(r => r.swing === 'TAKE PROFIT' || r.swing === 'EXIT ZONE').slice(0, 15),
  };
}

// ─── Summary view (all TFs per category) ────────────────────────────────────

function buildSummary(cache, tfSuffix) {
  const tfs = [':D']; // Start with what we have cached
  for (const [, suffix] of Object.entries(tfSuffix)) {
    if (!tfs.includes(suffix)) tfs.push(suffix);
  }

  // For each category, compute avg F&G per TF
  const catData = {};
  for (const [key, entry] of Object.entries(cache)) {
    if (!entry?.fgScore) continue;
    for (const suffix of tfs) {
      if (!key.endsWith(suffix)) continue;
      const sym = key.replace(suffix, '');
      const cls = detectAssetClass(sym);
      const catLabel = CATEGORIES[cls] || cls;
      const tfKey = { ':15': '15m', ':60': '1H', ':240': '4H', ':D': 'Daily', ':W': 'Weekly' }[suffix] || suffix;

      if (!catData[catLabel]) catData[catLabel] = { count: new Set(), tfs: {} };
      catData[catLabel].count.add(sym);
      if (!catData[catLabel].tfs[tfKey]) catData[catLabel].tfs[tfKey] = { sum: 0, n: 0, fear: 0 };
      catData[catLabel].tfs[tfKey].sum += entry.fgScore;
      catData[catLabel].tfs[tfKey].n++;
      if (entry.fgScore <= -5) catData[catLabel].tfs[tfKey].fear++;
    }
  }

  const categories = Object.entries(catData).map(([cat, data]) => {
    const row = { category: cat, symbols: data.count.size };
    for (const tf of ['15m', '1H', '4H', 'Daily', 'Weekly']) {
      const d = data.tfs[tf];
      if (d && d.n > 0) {
        row['fg_' + tf] = r2(d.sum / d.n);
        row['fear_' + tf] = Math.round(d.fear / d.n * 100);
      } else {
        row['fg_' + tf] = null;
        row['fear_' + tf] = null;
      }
    }

    // Trend: compare Daily to what it was (we don't have 7d ago yet, so use direction)
    const daily = row.fg_Daily;
    if (daily != null) {
      if (daily <= -25) row.trend = 'DEEP FEAR';
      else if (daily <= -10) row.trend = 'FEAR';
      else if (daily >= 25) row.trend = 'EUPHORIA';
      else if (daily >= 10) row.trend = 'GREED';
      else row.trend = 'NEUTRAL';
    }

    return row;
  }).sort((a, b) => (a.fg_Daily ?? 0) - (b.fg_Daily ?? 0));

  return {
    success: true,
    scan_type: 'dashboard-summary',
    date: new Date().toISOString().slice(0, 10),
    categories,
  };
}

// ─── History ────────────────────────────────────────────────────────────────

function saveSnapshot(tf, avgFG, total, oversold, overbought, catSummary) {
  if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const file = join(HISTORY_DIR, `fg-${tf}-${date}.json`);
  const catAvgs = {};
  for (const [cat, s] of Object.entries(catSummary)) {
    catAvgs[cat] = r2(s.sumFG / s.count);
  }
  writeFileSync(file, JSON.stringify({ date, tf, avgFG, total, oversold, overbought, catAvgs }));
}

function loadHistory(tf) {
  if (!existsSync(HISTORY_DIR)) return [];
  try {
    const prefix = `fg-${tf}-`;
    const files = readdirSync(HISTORY_DIR).filter(f => f.startsWith(prefix)).sort().reverse();
    return files.slice(0, 90).map(f => {
      try { return JSON.parse(readFileSync(join(HISTORY_DIR, f), 'utf8')); }
      catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

export function historyView({ tf = 'Daily' } = {}) {
  const snapshots = loadHistory(tf);
  if (snapshots.length === 0) return { success: true, message: 'No historical snapshots yet. Run tv scan dashboard daily to build history.' };

  return {
    success: true,
    timeframe: tf,
    snapshots: snapshots.slice(0, 30),
    trend: snapshots.length >= 2 ? {
      direction: snapshots[0].avgFG < snapshots[snapshots.length - 1].avgFG ? 'WORSENING' : 'IMPROVING',
      current: snapshots[0].avgFG,
      oldest: snapshots[snapshots.length - 1].avgFG,
      change: r2(snapshots[0].avgFG - snapshots[snapshots.length - 1].avgFG),
    } : null,
  };
}
