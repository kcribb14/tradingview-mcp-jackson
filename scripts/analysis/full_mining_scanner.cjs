const Database = require('better-sqlite3');
const https = require('https');
const db = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');

db.exec(`
CREATE TABLE IF NOT EXISTS scanner_results (
  scan_date TEXT,
  ticker TEXT,
  primary_commodity TEXT,
  stage TEXT,
  exchange TEXT,
  current_price REAL,
  -- Current metrics
  drawdown_pct REAL,
  fg_score REAL,
  ret_7d REAL,
  ret_30d REAL,
  volume_ratio REAL,
  volatility_7d REAL,
  commodity_30d_return REAL,
  commodity_trend TEXT,
  exploration_intensity TEXT,
  -- Archetype classification
  archetype TEXT,
  archetype_held_pct REAL,
  archetype_risk_score REAL,
  -- Overall score
  score REAL,
  -- Trigger status
  volume_triggered INTEGER,
  gap_up_detected INTEGER,
  flat_breakout_candidate INTEGER,
  -- Signal details
  signals TEXT,
  PRIMARY KEY (scan_date, ticker)
);
CREATE INDEX IF NOT EXISTS idx_scan_date ON scanner_results(scan_date);
CREATE INDEX IF NOT EXISTS idx_scan_score ON scanner_results(score);
CREATE INDEX IF NOT EXISTS idx_scan_arch ON scanner_results(archetype);
`);

const today = new Date().toISOString().split('T')[0];
console.log('═══ FULL ARCHETYPE MINING SCANNER ═══');
console.log('Date: ' + today + '\n');

// Archetype definitions with historical stats
const ARCHETYPES = {
  GAP_UP:        { held: 76, riskAdj: 43.0, medPump: 56, weight: 'BEST HOLD RATE' },
  FLAT_BREAKOUT: { held: 75, riskAdj: 39.1, medPump: 52, weight: 'EMERGING PATTERN' },
  DEAD_CAT:      { held: 69, riskAdj: 43.8, medPump: 64, weight: 'HIGHEST RISK-ADJ' },
  VOLUME_EXPLOSION: { held: 70, riskAdj: 38.0, medPump: 54, weight: 'MOST COMMON' },
  QUIET_ACCUM:   { held: 67, riskAdj: 33.5, medPump: 50, weight: 'STEALTH' },
  CATCH_UP:      { held: 72, riskAdj: 37.0, medPump: 52, weight: 'COMMODITY DRIVEN' },
  MOMENTUM:      { held: 66, riskAdj: 33.8, medPump: 51, weight: 'CAUTION - FADES' },
  EXTREME_FEAR:  { held: 57, riskAdj: 29.2, medPump: 51, weight: 'AVOID' },
};

// Get all miners with recent price data
const miners = db.prepare(`
  SELECT mp.ticker, mp.name, mp.primary_commodity, mp.stage, mp.exchange,
         mp.current_price, mp.pct_from_ath, mp.current_fg, mp.ytd_return_pct,
         mp.commodity_correlation, mp.volatility_annual, mp.total_bars,
         cdc.exploration_intensity
  FROM mining_performance mp
  LEFT JOIN company_drillhole_context cdc ON mp.ticker = cdc.ticker
  WHERE mp.total_bars > 200 AND mp.current_price > 0
`).all();

console.log('Miners to scan: ' + miners.length + '\n');

const insertResult = db.prepare(`
  INSERT OR REPLACE INTO scanner_results
  (scan_date, ticker, primary_commodity, stage, exchange, current_price,
   drawdown_pct, fg_score, ret_7d, ret_30d, volume_ratio, volatility_7d,
   commodity_30d_return, commodity_trend, exploration_intensity,
   archetype, archetype_held_pct, archetype_risk_score, score,
   volume_triggered, gap_up_detected, flat_breakout_candidate, signals)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const results = [];

for (const m of miners) {
  // Calculate current metrics from prices
  const prices = db.prepare('SELECT date, open, high, low, close, volume FROM prices WHERE ticker = ? ORDER BY date DESC LIMIT 30').all(m.ticker);
  if (prices.length < 10) continue;

  const current = prices[0];
  const p7d = prices.slice(0, 7);
  const p14d = prices.slice(0, 14);
  const p30d = prices.slice(0, Math.min(30, prices.length));

  const high30d = Math.max(...p30d.map(p => p.high || p.close));
  const low14d = Math.min(...p14d.filter(p => p.low > 0).map(p => p.low));
  const drawdown = high30d > 0 ? ((current.close - high30d) / high30d) * 100 : 0;
  const recovery = low14d > 0 ? ((current.close - low14d) / low14d) * 100 : 0;

  const ret7d = p7d.length >= 7 && p7d[p7d.length-1].close > 0
    ? ((p7d[0].close - p7d[p7d.length-1].close) / p7d[p7d.length-1].close) * 100 : null;
  const ret30d = p30d.length >= 20 && p30d[p30d.length-1].close > 0
    ? ((p30d[0].close - p30d[p30d.length-1].close) / p30d[p30d.length-1].close) * 100 : null;

  // Volume: today vs 20d median
  const volumes = p30d.map(p => p.volume || 0).filter(v => v > 0);
  const sortedVols = [...volumes].sort((a,b) => a-b);
  const medianVol = sortedVols.length > 0 ? sortedVols[Math.floor(sortedVols.length/2)] : 0;
  const volRatio = medianVol > 0 ? (current.volume || 0) / medianVol : 0;

  // Last 5 days volume ratios (to catch recent spikes)
  const recentVolSpikes = p7d.filter(p => medianVol > 0 && (p.volume||0) / medianVol >= 3).length;

  // Volatility (7d std dev of daily returns)
  const dReturns = [];
  for (let i = 0; i < p7d.length - 1; i++) {
    if (p7d[i+1].close > 0) dReturns.push((p7d[i].close - p7d[i+1].close) / p7d[i+1].close);
  }
  const avgDR = dReturns.length > 0 ? dReturns.reduce((s,r) => s+r, 0) / dReturns.length : 0;
  const vol7d = dReturns.length > 1 ? Math.sqrt(dReturns.reduce((s,r) => s + (r-avgDR)**2, 0) / (dReturns.length-1)) * 100 : 0;

  // Gap detection: did price gap up >10% on below-average volume in last 5 days?
  let gapUp = 0;
  for (let i = 0; i < Math.min(5, p7d.length - 1); i++) {
    const dayReturn = p7d[i+1].close > 0 ? ((p7d[i].close - p7d[i+1].close) / p7d[i+1].close) * 100 : 0;
    const dayVol = medianVol > 0 ? (p7d[i].volume||0) / medianVol : 1;
    if (dayReturn > 10 && dayVol < 1.5) gapUp = 1;
  }

  // Commodity trend
  let comm30dRet = null, commTrend = null;
  if (m.primary_commodity) {
    const cr = db.prepare(`
      SELECT ROUND((cp1.price_usd - cp2.price_usd) / NULLIF(cp2.price_usd, 0) * 100, 1) as ret
      FROM commodity_prices cp1
      JOIN commodity_prices cp2 ON cp2.commodity = cp1.commodity
        AND cp2.date = (SELECT MAX(date) FROM commodity_prices WHERE commodity = cp1.commodity AND date <= date('now', '-30 days'))
      WHERE cp1.commodity = ? AND cp1.date = (SELECT MAX(date) FROM commodity_prices WHERE commodity = ?)
    `).get(m.primary_commodity, m.primary_commodity);
    comm30dRet = cr?.ret || null;
    commTrend = comm30dRet !== null ? (comm30dRet > 5 ? 'rising' : comm30dRet < -5 ? 'falling' : 'flat') : null;
  }

  // ═══ ARCHETYPE CLASSIFICATION ═══
  const signals = [];
  let archetype = 'NONE';
  let archHeld = 0;
  let archRisk = 0;
  let score = 0;

  // Check each archetype (order matters — first match wins for primary, but collect all)
  const matchedArchetypes = [];

  // FLAT BREAKOUT: low volatility + any recent volume spike
  if (vol7d < 3 && recentVolSpikes > 0) {
    matchedArchetypes.push('FLAT_BREAKOUT');
    signals.push('FLAT BREAKOUT: vol7d=' + vol7d.toFixed(1) + '% + recent vol spike');
  }

  // CATCH-UP TRADE: commodity rising + stock lagging
  if (comm30dRet !== null && comm30dRet > 3 && ret30d !== null && ret30d < 0 && m.current_fg < -5) {
    matchedArchetypes.push('CATCH_UP');
    signals.push('CATCH-UP: comm+' + comm30dRet.toFixed(0) + '% stock' + ret30d.toFixed(0) + '%');
  }

  // VOLUME EXPLOSION: volume 3x+ right now
  if (volRatio >= 3) {
    matchedArchetypes.push('VOLUME_EXPLOSION');
    signals.push('VOLUME: ' + volRatio.toFixed(1) + 'x median');
  }

  // GAP UP: recent gap up on low volume
  if (gapUp) {
    matchedArchetypes.push('GAP_UP');
    signals.push('GAP UP detected in last 5 days');
  }

  // DEAD CAT BOUNCE: massive drawdown + massive recent decline
  if (drawdown < -60 && ret30d !== null && ret30d < -30) {
    matchedArchetypes.push('DEAD_CAT');
    signals.push('DEAD CAT: DD' + drawdown.toFixed(0) + '% ret30d' + ret30d.toFixed(0) + '%');
  }

  // QUIET ACCUMULATION: deep drawdown, mild fear, normal volume
  if (drawdown < -25 && m.current_fg !== null && m.current_fg > -20 && m.current_fg < -5 && volRatio < 2) {
    matchedArchetypes.push('QUIET_ACCUM');
    signals.push('QUIET ACCUM: DD' + drawdown.toFixed(0) + '% F&G' + m.current_fg.toFixed(0) + ' normal vol');
  }

  // MOMENTUM: already moving up
  if (ret7d !== null && ret7d > 5) {
    matchedArchetypes.push('MOMENTUM');
    signals.push('MOMENTUM: 7d+' + ret7d.toFixed(0) + '%');
  }

  // EXTREME FEAR: F&G < -30 (flagged but PENALIZED per validation)
  if (m.current_fg !== null && m.current_fg < -30) {
    matchedArchetypes.push('EXTREME_FEAR');
    signals.push('EXTREME FEAR: F&G' + m.current_fg.toFixed(0) + ' (CAUTION: 57% held, worst archetype)');
  }

  // Pick primary archetype (best risk-adjusted from matches)
  if (matchedArchetypes.length > 0) {
    matchedArchetypes.sort((a,b) => ARCHETYPES[b].riskAdj - ARCHETYPES[a].riskAdj);
    archetype = matchedArchetypes[0];
    archHeld = ARCHETYPES[archetype].held;
    archRisk = ARCHETYPES[archetype].riskAdj;
  }

  // ═══ SCORING (archetype-aware) ═══
  // Base: drawdown depth
  if (drawdown < -30) score += 15;
  else if (drawdown < -20) score += 10;

  // F&G sweet spot: mild fear (-15 to -5) = best, extreme = penalized
  if (m.current_fg !== null) {
    if (m.current_fg >= -15 && m.current_fg <= -5) score += 20;
    else if (m.current_fg >= -25 && m.current_fg < -15) score += 12;
    else if (m.current_fg < -25) score += 5; // PENALIZED per validation
  }

  // Archetype bonus (weighted by historical held rate)
  score += Math.round(archHeld * 0.3);

  // Active trigger bonuses
  if (volRatio >= 3) score += 15;
  if (gapUp) score += 15;
  if (vol7d < 3 && recentVolSpikes > 0) score += 15;
  if (comm30dRet > 3 && ret30d < 0) score += 12;
  if (recovery > 0 && recovery < 15) score += 8;
  if (m.exploration_intensity === 'low' && comm30dRet > 0) score += 8;

  // Stage adjustment
  if (m.stage && m.stage.includes('Producer')) score += 5;
  if (m.stage && m.stage.includes('Explorer')) score -= 10;

  // Exchange adjustment
  if (m.exchange === 'ASX' || m.exchange === 'JSE') score += 3;
  if (m.exchange === 'NYSE') score -= 5;

  // Extreme fear penalty
  if (m.current_fg !== null && m.current_fg < -30) score -= 10;

  // Commodity falling penalty
  if (commTrend === 'falling') score -= 8;

  const r = {
    ticker: m.ticker, commodity: m.primary_commodity, stage: m.stage,
    exchange: m.exchange, price: m.current_price,
    drawdown, fg: m.current_fg, ret7d, ret30d, volRatio, vol7d,
    comm30dRet, commTrend, exploration: m.exploration_intensity,
    archetype, archHeld, archRisk, score,
    volTriggered: volRatio >= 3 || recentVolSpikes > 0 ? 1 : 0,
    gapUp, flatBreakout: vol7d < 3 && drawdown < -20 ? 1 : 0,
    signals: signals.join(' | '),
    matchedArchetypes
  };

  results.push(r);

  try {
    insertResult.run(
      today, m.ticker, m.primary_commodity, m.stage, m.exchange, m.current_price,
      drawdown, m.current_fg, ret7d, ret30d, volRatio, vol7d,
      comm30dRet, commTrend, m.exploration_intensity,
      archetype, archHeld, archRisk, score,
      r.volTriggered, gapUp, r.flatBreakout, r.signals
    );
  } catch(e) {}
}

results.sort((a,b) => b.score - a.score);

// ═══ OUTPUT BY ARCHETYPE ═══
console.log('═══ OPPORTUNITIES BY ARCHETYPE ═══\n');

const byArch = {};
for (const r of results) {
  if (r.archetype === 'NONE') continue;
  if (!byArch[r.archetype]) byArch[r.archetype] = [];
  byArch[r.archetype].push(r);
}

const archOrder = Object.entries(byArch).sort((a,b) => ARCHETYPES[b[0]].riskAdj - ARCHETYPES[a[0]].riskAdj);

for (const [arch, miners] of archOrder) {
  const info = ARCHETYPES[arch];
  console.log('── ' + arch + ' (' + info.weight + ') ──');
  console.log('   Historical: ' + info.held + '% held, ' + info.medPump + '% median pump, risk-adj: ' + info.riskAdj);
  console.log('   Current matches: ' + miners.length + '\n');

  const top = miners.sort((a,b) => b.score - a.score).slice(0, 8);
  console.log('   Ticker'.padEnd(15) + 'Commodity'.padEnd(14) + 'Score'.padStart(6) + 'F&G'.padStart(6) + 'DD'.padStart(7) + 'VolR'.padStart(6) + 'Comm30d'.padStart(8) + '  Signals');
  console.log('   ' + '─'.repeat(80));

  for (const r of top) {
    console.log(
      '   ' + (r.ticker||'').padEnd(12) + (r.commodity||'').padEnd(14) +
      String(r.score).padStart(6) +
      (r.fg !== null ? r.fg.toFixed(0) : '?').padStart(6) +
      (r.drawdown?.toFixed(0)+'%').padStart(7) +
      (r.volRatio?.toFixed(1)+'x').padStart(6) +
      (r.comm30dRet !== null ? (r.comm30dRet > 0 ? '+' : '') + r.comm30dRet.toFixed(0) + '%' : '?').padStart(8) +
      '  ' + (r.signals||'').slice(0, 60)
    );
  }
  console.log('');
}

// ═══ TOP 20 OVERALL ═══
console.log('\n═══ TOP 20 OVERALL (all archetypes combined) ═══\n');
console.log('Rk  Score Ticker'.padEnd(24) + 'Archetype'.padEnd(20) + 'Held%'.padStart(6) + 'F&G'.padStart(6) + 'DD'.padStart(7) + 'Comm'.padStart(7) + '  Signals');
console.log('─'.repeat(100));

for (let i = 0; i < Math.min(20, results.length); i++) {
  const r = results[i];
  if (r.score < 20) break;
  console.log(
    String(i+1).padStart(2) + '  ' + String(r.score).padStart(4) + '  ' +
    (r.ticker||'').padEnd(14) + (r.archetype||'NONE').padEnd(20) +
    (r.archHeld ? r.archHeld + '%' : '?').padStart(6) +
    (r.fg !== null ? r.fg.toFixed(0) : '?').padStart(6) +
    (r.drawdown?.toFixed(0)+'%').padStart(7) +
    (r.comm30dRet !== null ? (r.comm30dRet > 0 ? '+' : '') + r.comm30dRet.toFixed(0) + '%' : '?').padStart(7) +
    '  ' + (r.signals||'').slice(0, 50)
  );
}

// ═══ ACTIVE TRIGGERS (fired in last 5 days) ═══
console.log('\n═══ ACTIVE TRIGGERS (volume spike or gap up in last 5 days) ═══\n');
const triggered = results.filter(r => r.volTriggered || r.gapUp);
if (triggered.length > 0) {
  for (const r of triggered.sort((a,b) => b.score - a.score).slice(0, 15)) {
    console.log('  ' + (r.volTriggered ? 'VOL' : 'GAP') + ' ' + (r.ticker||'').padEnd(12) + (r.archetype||'').padEnd(18) + 'score:' + r.score + ' held%:' + r.archHeld + '% ' + (r.signals||'').slice(0, 60));
  }
} else {
  console.log('  No volume spikes or gap ups in last 5 trading days');
  console.log('  These are the WATCHLIST — waiting for trigger to fire');
}

// ═══ SUMMARY STATS ═══
console.log('\n═══ SCAN SUMMARY ═══\n');
console.log('  Total miners scanned: ' + results.length);
console.log('  Archetype matches: ' + results.filter(r => r.archetype !== 'NONE').length);
console.log('  Score 50+: ' + results.filter(r => r.score >= 50).length);
console.log('  Active triggers: ' + triggered.length);
for (const [arch, miners] of archOrder) {
  console.log('  ' + arch.padEnd(22) + miners.length + ' matches (hist ' + ARCHETYPES[arch].held + '% held)');
}

// ═══ NTFY ═══
const top5 = results.filter(r => r.score >= 40).slice(0, 5);
const trigTop = triggered.slice(0, 3);
const body = 'MINING ARCHETYPE SCAN\n\nTop scores:\n' +
  top5.map(r => r.ticker + ' ' + r.archetype + ' score:' + r.score + ' held:' + r.archHeld + '%').join('\n') +
  (trigTop.length > 0 ? '\n\nTRIGGERED:\n' + trigTop.map(r => r.ticker + ' ' + (r.volTriggered ? 'VOL SPIKE' : 'GAP UP') + ' ' + r.archetype).join('\n') : '\n\nNo triggers fired');

const req = https.request({ hostname: 'ntfy.sh', path: '/kieran-fg-signals', method: 'POST',
  headers: { 'Title': 'Mining Archetype Scan ' + today, 'Priority': triggered.length > 0 ? 'high' : 'default' }
}, res => res.resume());
req.write(body); req.end();
console.log('\nSent to phone');

db.close();
