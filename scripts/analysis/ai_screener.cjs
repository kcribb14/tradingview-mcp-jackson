#!/usr/bin/env node
/**
 * AI Screener — Gemma local inference on top scanner candidates.
 * Reads top 20 miners from scanner_results, sends to Ollama for AI review,
 * stores results in ai_screening_results table.
 */
const Database = require('better-sqlite3');
const http = require('http');
const https = require('https');
const db = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
db.pragma('journal_mode = WAL');
db.pragma('synchronous = normal');

const today = new Date().toISOString().split('T')[0];
const OLLAMA_URL = 'http://localhost:11434/api/generate';
const MODEL = 'gemma4-screener'; // Falls back to base model if custom not found

console.log('═══ AI MINING SCREENER ═══');
console.log('Date: ' + today + '\n');

// ─── Create tables ───

db.exec(`
CREATE TABLE IF NOT EXISTS ai_screening_results (
  scan_date TEXT,
  ticker TEXT,
  archetype TEXT,
  confidence REAL,
  thesis TEXT,
  risks TEXT,
  action TEXT,
  raw_response TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (scan_date, ticker)
);
CREATE INDEX IF NOT EXISTS idx_ai_scan_date ON ai_screening_results(scan_date);
CREATE INDEX IF NOT EXISTS idx_ai_action ON ai_screening_results(action);

CREATE TABLE IF NOT EXISTS ai_screening_outcomes (
  scan_date TEXT,
  ticker TEXT,
  predicted_action TEXT,
  predicted_confidence REAL,
  actual_7d_return REAL,
  actual_30d_return REAL,
  held_gains INTEGER,
  outcome_date TEXT,
  PRIMARY KEY (scan_date, ticker)
);
`);

// ─── Get top 20 from scanner ───

const scanDate = db.prepare('SELECT MAX(scan_date) as d FROM scanner_results').get()?.d;
if (!scanDate) { console.log('No scanner results found. Run full_mining_scanner.cjs first.'); process.exit(0); }

const candidates = db.prepare(`
  SELECT sr.ticker, sr.primary_commodity, sr.stage, sr.exchange,
         sr.score, sr.drawdown_pct, sr.fg_score, sr.volume_ratio,
         sr.volatility_7d, sr.commodity_30d_return, sr.commodity_trend,
         sr.exploration_intensity, sr.archetype, sr.archetype_held_pct,
         sr.signals, sr.volume_triggered, sr.gap_up_detected,
         sr.current_price
  FROM scanner_results sr
  WHERE sr.scan_date = ?
  ORDER BY sr.score DESC
  LIMIT 20
`).all(scanDate);

console.log('Candidates: ' + candidates.length + ' (from scan: ' + scanDate + ')\n');

// ─── Ollama helper ───

function ollamaGenerate(prompt, model) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: model,
      prompt: prompt,
      stream: false,
      options: { temperature: 0.2, num_ctx: 4096 }
    });

    const url = new URL(OLLAMA_URL);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 120000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.response || '');
        } catch (e) { reject(new Error('Invalid JSON from Ollama: ' + data.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timeout')); });
    req.write(payload);
    req.end();
  });
}

async function detectModel() {
  // Try custom model first, then base model
  for (const m of ['gemma4-screener', 'gemma4:27b', 'gemma3:27b', 'gemma2:27b', 'gemma3:12b', 'llama3.2:latest']) {
    try {
      const test = await ollamaGenerate('Say OK', m);
      if (test && test.length > 0) {
        console.log('Using model: ' + m);
        return m;
      }
    } catch {}
  }
  return null;
}

// ─── Build prompt for a miner ───

function buildPrompt(m) {
  return `Analyze this mining stock for pump potential:

Ticker: ${m.ticker}
Commodity: ${m.primary_commodity || '?'}
Stage: ${m.stage || '?'}
Exchange: ${m.exchange}
Scanner Score: ${m.score}/100
Current Price: $${m.current_price}
Drawdown from 30d high: ${m.drawdown_pct?.toFixed(0) || '?'}%
F&G Score: ${m.fg_score?.toFixed(0) || '?'}
Volume Ratio (vs 20d median): ${m.volume_ratio?.toFixed(1) || '?'}x
7d Volatility: ${m.volatility_7d?.toFixed(1) || '?'}%
Commodity 30d Return: ${m.commodity_30d_return !== null ? (m.commodity_30d_return > 0 ? '+' : '') + m.commodity_30d_return.toFixed(0) + '%' : '?'}
Commodity Trend: ${m.commodity_trend || '?'}
Exploration Intensity: ${m.exploration_intensity || '?'}
Scanner Archetype: ${m.archetype} (hist ${m.archetype_held_pct}% held)
Volume Triggered: ${m.volume_triggered ? 'YES' : 'no'}
Gap Up Detected: ${m.gap_up_detected ? 'YES' : 'no'}
Signals: ${m.signals || 'none'}

Respond with JSON only.`;
}

// ─── Parse AI response ───

function parseResponse(raw, ticker) {
  try {
    // Try direct JSON parse
    let json = JSON.parse(raw);
    return json;
  } catch {}

  // Try extracting JSON from markdown code block
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) {
    try { return JSON.parse(match[1].trim()); } catch {}
  }

  // Try finding JSON object in text
  const jsonMatch = raw.match(/\{[\s\S]*"ticker"[\s\S]*\}/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]); } catch {}
  }

  // Failed to parse — return minimal
  return { ticker, archetype: 'UNKNOWN', confidence: 0, thesis: 'Parse failed', risks: raw.substring(0, 100), action: 'watch' };
}

// ─── Main ───

const insertResult = db.prepare(`
  INSERT OR REPLACE INTO ai_screening_results
  (scan_date, ticker, archetype, confidence, thesis, risks, action, raw_response)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

async function main() {
  const model = await detectModel();
  if (!model) {
    console.log('ERROR: No Ollama model available. Install with: ollama pull gemma3:27b');
    console.log('Skipping AI screening.');
    process.exit(0);
  }

  const results = [];
  let alerts = [];

  for (let i = 0; i < candidates.length; i++) {
    const m = candidates[i];
    process.stdout.write('\r  [' + (i + 1) + '/' + candidates.length + '] Screening ' + m.ticker + '...          ');

    try {
      const prompt = buildPrompt(m);
      const raw = await ollamaGenerate(prompt, model);
      const parsed = parseResponse(raw, m.ticker);

      // Normalize
      const result = {
        ticker: m.ticker,
        archetype: parsed.archetype || m.archetype || 'UNKNOWN',
        confidence: Math.min(100, Math.max(0, parsed.confidence || 0)),
        thesis: (parsed.thesis || '').substring(0, 500),
        risks: (parsed.risks || '').substring(0, 500),
        action: ['watch', 'alert', 'avoid'].includes(parsed.action) ? parsed.action : 'watch',
        raw: raw.substring(0, 2000),
      };

      insertResult.run(today, result.ticker, result.archetype, result.confidence, result.thesis, result.risks, result.action, result.raw);
      results.push(result);

      if (result.action === 'alert' && result.confidence >= 70) {
        alerts.push(result);
      }
    } catch (e) {
      console.log('\n  Error on ' + m.ticker + ': ' + e.message);
      results.push({ ticker: m.ticker, archetype: 'ERROR', confidence: 0, thesis: e.message, risks: '', action: 'watch' });
    }
  }

  // ─── Print results ───

  console.log('\n\n═══ AI SCREENING RESULTS ═══\n');
  console.log('Ticker'.padEnd(12) + 'Action'.padEnd(8) + 'Conf'.padStart(5) + '  Archetype'.padEnd(22) + 'Thesis');
  console.log('─'.repeat(90));

  for (const r of results) {
    const actionIcon = r.action === 'alert' ? '🔔' : r.action === 'avoid' ? '⛔' : '👁️';
    console.log(
      r.ticker.padEnd(12) +
      (actionIcon + ' ' + r.action).padEnd(10) +
      String(r.confidence).padStart(3) + '%' +
      ('  ' + r.archetype).padEnd(22) +
      (r.thesis || '').substring(0, 50)
    );
  }

  // ─── Stats ───

  const alertCount = results.filter(r => r.action === 'alert').length;
  const avoidCount = results.filter(r => r.action === 'avoid').length;
  const watchCount = results.filter(r => r.action === 'watch').length;
  const avgConf = results.length > 0 ? Math.round(results.reduce((s, r) => s + r.confidence, 0) / results.length) : 0;

  console.log('\n═══ SUMMARY ═══');
  console.log('  Screened: ' + results.length);
  console.log('  Alert: ' + alertCount + ' | Watch: ' + watchCount + ' | Avoid: ' + avoidCount);
  console.log('  Avg confidence: ' + avgConf + '%');
  console.log('  High-confidence alerts: ' + alerts.length);

  // ─── Send ntfy for high-confidence alerts ───

  if (alerts.length > 0) {
    const body = 'AI SCREENER ALERTS\n\n' +
      alerts.map(a => a.ticker + ' (' + a.confidence + '%) ' + a.archetype + '\n  ' + a.thesis).join('\n\n');

    try {
      const req = https.request({
        hostname: 'ntfy.sh', path: '/kieran-fg-signals', method: 'POST',
        headers: { 'Title': 'AI Alert: ' + alerts.map(a => a.ticker).join(', '), 'Priority': 'high', 'Tags': 'brain' }
      }, res => res.resume());
      req.write(body);
      req.end();
      console.log('\n  Sent ' + alerts.length + ' high-confidence alerts to phone');
    } catch {}
  }

  db.close();
}

main().catch(e => { console.error('FATAL:', e.message); db.close(); });
