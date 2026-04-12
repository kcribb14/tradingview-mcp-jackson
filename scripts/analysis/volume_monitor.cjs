#!/usr/bin/env node
/**
 * High-frequency volume monitor — runs every 15 minutes via launchd.
 * Checks top 50 miners + top 100 DEX tokens for volume spikes (3x+ median).
 * Sends ntfy alerts for new triggers. Completes in <30s (SQLite only, no API calls).
 */
const Database = require('better-sqlite3');
const https = require('https');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(process.env.HOME, '.tradingview-mcp', 'db', 'fg.db');
const LOG_PATH = path.join(process.env.HOME, '.tradingview-mcp', 'logs', 'volume_monitor.log');

// Ensure log dir exists
fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  fs.appendFileSync(LOG_PATH, line + '\n');
}

let db;
try {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = normal');
} catch (e) {
  log('FATAL: Cannot open DB — ' + e.message);
  process.exit(1);
}

// ─── Create volume_alerts table ───

db.exec(`
CREATE TABLE IF NOT EXISTS volume_alerts (
  alert_id TEXT PRIMARY KEY,
  ticker TEXT,
  source TEXT,
  alert_date TEXT,
  volume_ratio REAL,
  scanner_score REAL,
  archetype TEXT,
  fg_score REAL,
  price_at_alert REAL,
  sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_valert_date ON volume_alerts(alert_date);
CREATE INDEX IF NOT EXISTS idx_valert_ticker ON volume_alerts(ticker);
`);

const today = new Date().toISOString().split('T')[0];
const insertAlert = db.prepare(`
  INSERT OR IGNORE INTO volume_alerts
  (alert_id, ticker, source, alert_date, volume_ratio, scanner_score, archetype, fg_score, price_at_alert)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

log('─── Volume monitor run ───');

const alerts = [];

// ─── 1. Check top 50 miners from scanner_results ───

const scanDate = db.prepare('SELECT MAX(scan_date) as d FROM scanner_results').get()?.d;
let miners = [];
if (scanDate) {
  miners = db.prepare(`
    SELECT sr.ticker, sr.score, sr.archetype, sr.fg_score, sr.primary_commodity
    FROM scanner_results sr
    WHERE sr.scan_date = ?
    ORDER BY sr.score DESC LIMIT 50
  `).all(scanDate);
}

log('Checking ' + miners.length + ' miners (scan date: ' + (scanDate || 'none') + ')');

for (const m of miners) {
  try {
    // Get latest 30 days of volume
    const bars = db.prepare(
      'SELECT date, close, volume FROM prices WHERE ticker = ? AND volume > 0 ORDER BY date DESC LIMIT 30'
    ).all(m.ticker);

    if (bars.length < 10) continue;

    const latestVol = bars[0].volume;
    const latestPrice = bars[0].close;
    const latestDate = bars[0].date;

    // 20-day median volume (skip day 0 = today)
    const vols = bars.slice(1, 21).map(b => b.volume).sort((a, b) => a - b);
    const medianVol = vols.length > 0 ? vols[Math.floor(vols.length / 2)] : 0;

    if (medianVol <= 0) continue;
    const ratio = latestVol / medianVol;

    if (ratio >= 3) {
      const alertId = `${m.ticker}_${today}_mining`;
      const existing = db.prepare('SELECT 1 FROM volume_alerts WHERE alert_id = ?').get(alertId);
      if (!existing) {
        insertAlert.run(alertId, m.ticker, 'mining', today, Math.round(ratio * 10) / 10, m.score, m.archetype, m.fg_score, latestPrice);
        alerts.push({
          ticker: m.ticker,
          source: 'mining',
          ratio: Math.round(ratio * 10) / 10,
          score: m.score,
          archetype: m.archetype,
          fg: m.fg_score,
          price: latestPrice,
          commodity: m.primary_commodity,
        });
        log('TRIGGER: ' + m.ticker + ' vol=' + ratio.toFixed(1) + 'x score=' + m.score + ' ' + m.archetype);
      }
    }
  } catch (e) {
    // Skip individual ticker errors silently
  }
}

// ─── 2. Check top 100 DEX tokens from dex_snapshots ───

let dexTokens = [];
try {
  dexTokens = db.prepare(`
    SELECT r.token_address, r.chain, r.symbol, r.name,
           s.price_usd, s.volume_24h, s.liquidity_usd,
           s.txns_buys_24h, s.txns_sells_24h, s.price_change_24h,
           s.snapshot_ts
    FROM dex_snapshots s
    JOIN dex_registry r ON s.token_address = r.token_address AND s.chain = r.chain
    WHERE s.snapshot_ts = (
      SELECT MAX(s2.snapshot_ts) FROM dex_snapshots s2
      WHERE s2.token_address = s.token_address AND s2.chain = s.chain
    )
    AND s.volume_24h > 0
    ORDER BY s.volume_24h DESC
    LIMIT 100
  `).all();
} catch (e) {
  log('DEX query error: ' + e.message);
}

log('Checking ' + dexTokens.length + ' DEX tokens');

for (const t of dexTokens) {
  try {
    // Compare current volume to historical average
    // Get all snapshots for this token to build baseline
    const history = db.prepare(`
      SELECT volume_24h FROM dex_snapshots
      WHERE token_address = ? AND chain = ? AND volume_24h > 0
      ORDER BY snapshot_ts DESC LIMIT 20
    `).all(t.token_address, t.chain);

    if (history.length < 3) continue;

    // Average volume (excluding latest)
    const older = history.slice(1);
    const avgVol = older.reduce((s, h) => s + h.volume_24h, 0) / older.length;
    if (avgVol <= 0) continue;

    const ratio = t.volume_24h / avgVol;

    if (ratio >= 3) {
      const alertId = `${t.symbol}_${t.chain}_${today}_dex`;
      const existing = db.prepare('SELECT 1 FROM volume_alerts WHERE alert_id = ?').get(alertId);
      if (!existing) {
        // Get F&G if available
        const fg = db.prepare("SELECT fg_score FROM fg_history WHERE ticker = ? ORDER BY date DESC LIMIT 1")
          .get(t.symbol?.toUpperCase() + '-' + t.chain?.toUpperCase());

        insertAlert.run(alertId, t.symbol + ':' + t.chain, 'dex', today, Math.round(ratio * 10) / 10, null, null, fg?.fg_score || null, t.price_usd);
        alerts.push({
          ticker: t.symbol + ':' + t.chain,
          source: 'dex',
          ratio: Math.round(ratio * 10) / 10,
          price: t.price_usd,
          volume: t.volume_24h,
          liquidity: t.liquidity_usd,
          change24h: t.price_change_24h,
        });
        log('TRIGGER: ' + t.symbol + ':' + t.chain + ' vol=' + ratio.toFixed(1) + 'x vol24h=$' + Math.round(t.volume_24h));
      }
    }
  } catch (e) {
    // Skip individual token errors
  }
}

// ─── 3. Send ntfy alerts ───

if (alerts.length > 0) {
  const miningAlerts = alerts.filter(a => a.source === 'mining');
  const dexAlerts = alerts.filter(a => a.source === 'dex');

  let body = 'VOLUME SPIKE DETECTED\n';
  if (miningAlerts.length > 0) {
    body += '\nMINING:\n' + miningAlerts.map(a =>
      `${a.ticker} ${a.ratio}x vol | ${a.archetype || '?'} score:${a.score || '?'} F&G:${a.fg?.toFixed(0) || '?'} | ${a.commodity || ''}`
    ).join('\n');
  }
  if (dexAlerts.length > 0) {
    body += '\nDEX:\n' + dexAlerts.map(a =>
      `${a.ticker} ${a.ratio}x vol | $${Math.round(a.volume || 0)} vol | ${a.change24h?.toFixed(0) || '?'}% 24h`
    ).join('\n');
  }

  const priority = alerts.some(a => a.source === 'mining' && a.score >= 50) ? 'high' : 'default';

  try {
    const req = https.request({
      hostname: 'ntfy.sh',
      path: '/kieran-fg-signals',
      method: 'POST',
      headers: {
        'Title': 'VOL SPIKE: ' + alerts.map(a => a.ticker).slice(0, 3).join(', ') + (alerts.length > 3 ? ' +' + (alerts.length - 3) : ''),
        'Priority': priority,
        'Tags': 'chart_with_upwards_trend',
      }
    }, res => res.resume());
    req.write(body);
    req.end();
    log('Sent ntfy alert for ' + alerts.length + ' triggers');
  } catch (e) {
    log('ntfy error: ' + e.message);
  }
} else {
  log('No new volume triggers');
}

// ─── Summary ───

const totalAlerts = db.prepare('SELECT COUNT(*) as n FROM volume_alerts WHERE alert_date = ?').get(today)?.n || 0;
log('Run complete: ' + alerts.length + ' new alerts, ' + totalAlerts + ' total today');

// Print to stdout for manual runs
if (process.stdout.isTTY || process.argv.includes('--verbose')) {
  console.log('Volume Monitor — ' + new Date().toISOString());
  console.log('  Miners checked: ' + miners.length);
  console.log('  DEX tokens checked: ' + dexTokens.length);
  console.log('  New triggers: ' + alerts.length);
  console.log('  Total alerts today: ' + totalAlerts);
  if (alerts.length > 0) {
    console.log('  Alerts:');
    for (const a of alerts) {
      console.log('    ' + a.ticker.padEnd(20) + a.ratio + 'x vol  ' + (a.source === 'mining' ? a.archetype + ' score:' + a.score : '$' + Math.round(a.volume || 0) + ' vol'));
    }
  }
}

db.close();
