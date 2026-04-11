#!/usr/bin/env node
/**
 * [2/12] Fill missing F&G scores.
 * Computes DGT F&G from OHLCV bars for tickers that have prices but no fg_history.
 * Prioritizes mining_companies tickers first, then crypto, then everything else.
 */
const Database = require('better-sqlite3');
const db = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
db.pragma('journal_mode = WAL');
db.pragma('synchronous = normal');

console.log('[2/12] → Fill missing F&G scores...');

// ─── DGT F&G math (from fg_cache.js, ported to CJS) ───

function calcEMA(values, period) {
  if (!values || values.length === 0) return null;
  let ema = values[0];
  const alpha = 2 / (period + 1);
  for (let i = 1; i < values.length; i++) {
    ema = alpha * values[i] + (1 - alpha) * ema;
  }
  return ema;
}

function updateRMA(prev, val, period) {
  if (prev == null) return val;
  return (prev * (period - 1) + val) / period;
}

function classifyZone(score) {
  if (score >= 73) return 'extreme_greed';
  if (score >= 41) return 'strong_greed';
  if (score >= 10) return 'moderate_greed';
  if (score >= 5) return 'weak_greed';
  if (score >= -5) return 'neutral';
  if (score >= -10) return 'weak_fear';
  if (score >= -25) return 'moderate_fear';
  if (score >= -41) return 'strong_fear';
  return 'extreme_fear';
}

function computeFG(bars) {
  if (!bars || bars.length < 50) return null;

  const closes = bars.map(b => b.close);
  const lastClose = closes[closes.length - 1];

  // pmacd: (close / ema(144) - 1) * 100
  const ema144 = calcEMA(closes, Math.min(144, closes.length));
  const pmacd = ema144 > 0 ? (lastClose / ema144 - 1) * 100 : 0;

  // ror: rate of return over 144 bars (or available)
  const rorIdx = Math.max(0, closes.length - 145);
  const refClose = closes[rorIdx];
  const ror = refClose > 0 ? (lastClose - refClose) / refClose * 100 : 0;

  // moneyFlow: RMA-smoothed volume-weighted pressure
  let mfRMA = null, volRMA = null;
  const mfPeriod = 21;
  for (let i = Math.max(0, bars.length - mfPeriod); i < bars.length; i++) {
    const b = bars[i];
    const range = b.high - b.low;
    const mfRatio = range > 0 ? (2 * b.close - b.low - b.high) / range : 0;
    const mfVal = mfRatio * (b.volume || 0);
    mfRMA = mfRMA != null ? updateRMA(mfRMA, mfVal, mfPeriod) : mfVal;
    volRMA = volRMA != null ? updateRMA(volRMA, b.volume || 0, mfPeriod) : (b.volume || 0);
  }
  const rawMF = volRMA > 1e-8 ? (mfRMA / volRMA) * 100 : 0;
  const moneyFlow = Number.isFinite(rawMF) ? Math.max(-100, Math.min(100, rawMF)) : 0;

  // Clamp components
  const safePmacd = Math.max(-60, Math.min(60, Number.isFinite(pmacd) ? pmacd : 0));
  const safeRor = Math.max(-80, Math.min(80, Number.isFinite(ror) ? ror : 0));
  const safeMF = Math.max(-100, Math.min(100, Number.isFinite(moneyFlow) ? moneyFlow : 0));

  // Composite (vix=0, gold=0 without globals — acceptable for bulk backfill)
  const raw = (safePmacd * 1.0 + safeRor * 1.0 + safeMF * 1.0 + 0 * 1.2 + 0 * 0.8) / 5.0;

  // RMA(5) smoothing over recent history
  let fgRMA = raw;
  // Apply additional smoothing using recent bars as proxy
  const windowSize = Math.min(5, bars.length);
  for (let i = bars.length - windowSize; i < bars.length; i++) {
    fgRMA = updateRMA(fgRMA, raw, 5);
  }

  return Math.max(-80, Math.min(100, Math.round(fgRMA * 100) / 100));
}

// ─── Find tickers needing F&G ───

const priceTickers = new Set(db.prepare('SELECT DISTINCT ticker FROM prices').pluck().all());
const fgTickers = new Set(db.prepare('SELECT DISTINCT ticker FROM fg_history').pluck().all());
const miningTickers = new Set(db.prepare('SELECT ticker FROM mining_companies').pluck().all());

const needFG = [...priceTickers].filter(t => !fgTickers.has(t));
console.log('Tickers needing F&G: ' + needFG.length);

// Prioritize: mining first, then crypto, then rest
const mining = needFG.filter(t => miningTickers.has(t));
const crypto = needFG.filter(t => !miningTickers.has(t) && (t.includes('-') || t.includes('USD')));
const rest = needFG.filter(t => !miningTickers.has(t) && !t.includes('-') && !t.includes('USD'));
const ordered = [...mining, ...crypto, ...rest];
console.log('Priority: ' + mining.length + ' mining, ' + crypto.length + ' crypto, ' + rest.length + ' other\n');

// ─── Compute and insert ───

const insertFG = db.prepare('INSERT OR IGNORE INTO fg_history (ticker, date, fg_score, zone) VALUES (?, ?, ?, ?)');

const batchInsert = db.transaction((ticker, scores) => {
  for (const { date, score, zone } of scores) {
    insertFG.run(ticker, date, score, zone);
  }
});

let filled = 0, skipped = 0, errors = 0;

for (let i = 0; i < ordered.length; i++) {
  const ticker = ordered[i];

  try {
    // Get all daily bars for this ticker
    const bars = db.prepare(
      'SELECT date, open, high, low, close, volume FROM prices WHERE ticker = ? AND close > 0 ORDER BY date ASC'
    ).all(ticker);

    if (bars.length < 50) { skipped++; continue; }

    // Compute F&G for sliding windows across history
    const scores = [];
    const windowSize = 200; // Use 200-bar windows like FULL tier
    const step = 1; // Every day

    for (let j = Math.max(50, windowSize); j <= bars.length; j += step) {
      const window = bars.slice(Math.max(0, j - windowSize), j);
      const fg = computeFG(window);
      if (fg !== null && Number.isFinite(fg)) {
        scores.push({
          date: bars[j - 1].date,
          score: fg,
          zone: classifyZone(fg)
        });
      }
    }

    if (scores.length > 0) {
      batchInsert(ticker, scores);
      filled++;
    } else {
      skipped++;
    }
  } catch (e) {
    errors++;
    if (errors <= 5) console.log('  Error: ' + ticker + ' — ' + e.message);
  }

  if ((i + 1) % 50 === 0 || i === ordered.length - 1) {
    process.stdout.write('\r  Progress: ' + (i + 1) + '/' + ordered.length + ' | Filled: ' + filled + ' | Skipped: ' + skipped + ' | Errors: ' + errors);
  }
}

console.log('\n');

// Final count
const newFGCount = db.prepare('SELECT COUNT(DISTINCT ticker) as n FROM fg_history').get().n;
console.log('[2/12] ✓ F&G scores filled');
console.log('  Before: ' + fgTickers.size + ' tickers');
console.log('  After: ' + newFGCount + ' tickers');
console.log('  Added: ' + filled + ' tickers (' + (newFGCount - fgTickers.size) + ' net new)');
console.log('  Skipped: ' + skipped + ' (< 50 bars)');
console.log('  Errors: ' + errors);

db.close();
