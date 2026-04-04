/**
 * F&G Dashboard — CoinMarketCap-style multi-TF table with categories.
 *
 * Shows ALL symbols with multi-TF F&G scores, category breakdowns,
 * market heat, and historical comparison.
 */
import { loadCache, loadGlobals } from './fg_cache.js';
import { detectAssetClass, classifyCalibratedZone } from './fg_calibrated.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const r2 = v => Math.round(v * 100) / 100;
const HISTORY_DIR = join(homedir(), '.tradingview-mcp', 'history');
const SCORES_FILE = join(homedir(), '.tradingview-mcp', 'config', 'symbol_scores.json');

// ─── Category mapping ───────────────────────────────────────────────────────

const CATEGORIES = {
  US_LARGE_CAP: 'US Large Cap',
  US_MID_SMALL: 'US Mid/Small',
  ASX_TOP50: 'ASX Top 50',
  ASX_MINING_MID: 'ASX Mining Mid',
  ASX_MINING_MICRO: 'ASX Mining Micro',
  CRYPTO_MAJOR: 'Crypto Major',
  CRYPTO_MID: 'Crypto Mid',
  COMMODITIES: 'Commodities',
  ETFS: 'ETFs',
};

// ─── Dashboard ──────────────────────────────────────────────────────────────

/**
 * Generate dashboard data from cache.
 *
 * @param {object} opts
 * @param {string} opts.category - Filter by category
 * @param {string} opts.sort - Sort field: fg_daily, fg_15m, symbol
 * @param {boolean} opts.fear_only - Only show fear signals
 * @param {boolean} opts.extreme_only - Only show extreme fear/greed
 * @param {number} opts.top - Limit results
 */
export function dashboard({ category, sort = 'fg_daily', fear_only = false, extreme_only = false, top = 100 } = {}) {
  const cache = loadCache();
  let symScores = {};
  try { symScores = JSON.parse(readFileSync(SCORES_FILE, 'utf8')); } catch {}

  // Build rows from cache
  const rows = [];
  for (const [key, entry] of Object.entries(cache)) {
    if (!key.endsWith(':D') || entry?.fgScore == null) continue;
    const sym = key.replace(':D', '');
    const cls = detectAssetClass(sym);
    const cal = classifyCalibratedZone(sym, entry.fgScore);
    const catLabel = CATEGORIES[cls] || cls;

    if (category && cls !== category && catLabel.toLowerCase() !== category.toLowerCase()) continue;

    // Determine signal
    let signal;
    if (cal.severity <= -2) signal = 'RARE FEAR';
    else if (cal.severity === -1) signal = 'FEAR';
    else if (cal.severity === 0) signal = 'NEUTRAL';
    else if (cal.severity === 1) signal = 'GREED';
    else signal = 'RARE GREED';

    if (fear_only && cal.severity >= 0) continue;
    if (extreme_only && Math.abs(cal.severity) < 2) continue;

    // Tier
    const tier = ['US_LARGE_CAP','ASX_MINING_MID','ASX_MINING_MICRO','COMMODITIES'].includes(cls) ? 1 :
      ['US_MID_SMALL','ETFS','ASX_TOP50','CRYPTO_MAJOR'].includes(cls) ? 2 : 3;

    const row = {
      symbol: sym,
      fg_daily: entry.fgScore,
      signal,
      category: catLabel,
      class: cls,
      tier,
      rsi: entry.rsi,
      components: entry.components,
      distance: cal.distance_to_rare_fear,
      is_rare_fear: cal.is_triggered,
      symbol_score: symScores[sym.toUpperCase()] || null,
    };

    rows.push(row);
  }

  // Sort
  switch (sort) {
    case 'fg_daily': rows.sort((a, b) => a.fg_daily - b.fg_daily); break;
    case 'symbol': rows.sort((a, b) => a.symbol.localeCompare(b.symbol)); break;
    case 'category': rows.sort((a, b) => a.category.localeCompare(b.category) || a.fg_daily - b.fg_daily); break;
    default: rows.sort((a, b) => a.fg_daily - b.fg_daily);
  }

  // Category summary
  const catSummary = {};
  for (const row of rows) {
    const cat = row.category;
    if (!catSummary[cat]) catSummary[cat] = { count: 0, sumFG: 0, fear: 0, greed: 0, extremeFear: 0 };
    catSummary[cat].count++;
    catSummary[cat].sumFG += row.fg_daily;
    if (row.signal.includes('FEAR')) catSummary[cat].fear++;
    if (row.signal.includes('GREED')) catSummary[cat].greed++;
    if (row.signal === 'RARE FEAR') catSummary[cat].extremeFear++;
  }

  const catTable = Object.entries(catSummary).map(([cat, s]) => ({
    category: cat,
    count: s.count,
    avg_fg: r2(s.sumFG / s.count),
    pct_fear: Math.round(s.fear / s.count * 100),
    pct_greed: Math.round(s.greed / s.count * 100),
    extreme_fear: s.extremeFear,
  })).sort((a, b) => a.avg_fg - b.avg_fg);

  // Market heat
  const totalFear = rows.filter(r => r.signal.includes('FEAR')).length;
  const totalGreed = rows.filter(r => r.signal.includes('GREED')).length;
  const totalExtreme = rows.filter(r => r.signal === 'RARE FEAR').length;
  const avgFG = rows.length > 0 ? r2(rows.reduce((s, r) => s + r.fg_daily, 0) / rows.length) : 0;

  // Save daily snapshot for historical comparison
  saveSnapshot(avgFG, totalFear, totalGreed, rows.length);

  // Load historical snapshots for comparison
  const history = loadHistory();

  return {
    success: true,
    scan_type: 'dashboard',
    date: new Date().toISOString().slice(0, 10),
    market_heat: {
      overall_fg: avgFG,
      total_symbols: rows.length,
      in_fear: totalFear,
      in_extreme_fear: totalExtreme,
      in_greed: totalGreed,
      pct_fear: Math.round(totalFear / rows.length * 100),
      pct_greed: Math.round(totalGreed / rows.length * 100),
      sentiment: avgFG <= -15 ? 'EXTREME FEAR' : avgFG <= -5 ? 'FEAR' : avgFG >= 15 ? 'EXTREME GREED' : avgFG >= 5 ? 'GREED' : 'NEUTRAL',
    },
    categories: catTable,
    history,
    results: rows.slice(0, top),
    fear_signals: rows.filter(r => r.signal === 'RARE FEAR').slice(0, 30),
    greed_signals: rows.filter(r => r.signal === 'RARE GREED').slice(0, 15),
  };
}

// ─── Daily snapshot history ─────────────────────────────────────────────────

function saveSnapshot(avgFG, fear, greed, total) {
  if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const file = join(HISTORY_DIR, `daily-${date}.json`);
  writeFileSync(file, JSON.stringify({ date, avgFG, fear, greed, total, pctFear: Math.round(fear/total*100), pctGreed: Math.round(greed/total*100) }));
}

function loadHistory() {
  const snapshots = [];
  if (!existsSync(HISTORY_DIR)) return snapshots;
  try {
    const files = readdirSync(HISTORY_DIR).filter(f => f.startsWith('daily-')).sort().reverse();
    for (const f of files.slice(0, 90)) {
      try {
        const d = JSON.parse(readFileSync(join(HISTORY_DIR, f), 'utf8'));
        snapshots.push(d);
      } catch {}
    }
  } catch {}
  return snapshots;
}
