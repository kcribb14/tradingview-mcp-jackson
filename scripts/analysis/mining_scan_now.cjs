const Database = require('better-sqlite3');
const db = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db', { readonly: true });

// Load profile
const profile = {};
db.prepare('SELECT characteristic, median_value FROM mining_pump_characteristics').all()
  .forEach(r => profile[r.characteristic.replace('mining_', '')] = r.median_value);

// Get miners with recent data
const miners = db.prepare("SELECT mp.ticker, mp.name, mp.primary_commodity, mp.stage, mp.exchange, mp.current_price, mp.pct_from_ath, mp.current_fg, mp.ytd_return_pct, mp.commodity_correlation, mp.market_cap_aud, mp.total_bars FROM mining_performance mp WHERE mp.total_bars > 200 AND mp.current_price > 0").all();

const commNowQ = db.prepare("SELECT price_usd FROM commodity_prices WHERE commodity=? ORDER BY date DESC LIMIT 1");
const comm30Q = db.prepare("SELECT price_usd FROM commodity_prices WHERE commodity=? AND date <= date('now', '-30 days') ORDER BY date DESC LIMIT 1");

const results = [];

for (const m of miners) {
  const prices = db.prepare("SELECT date,high,low,close,volume FROM prices WHERE ticker=? ORDER BY date DESC LIMIT 100").all(m.ticker);
  if (prices.length < 30) continue;

  const cur = prices[0], p7 = prices.slice(0, 7), p14 = prices.slice(0, 14), p30 = prices.slice(0, 30);
  const ret7d = p7.length >= 7 && p7[p7.length-1].close > 0 ? ((p7[0].close - p7[p7.length-1].close) / p7[p7.length-1].close) * 100 : null;
  const ret30d = p30.length >= 20 && p30[p30.length-1].close > 0 ? ((p30[0].close - p30[p30.length-1].close) / p30[p30.length-1].close) * 100 : null;
  const h30 = Math.max(...p30.map(p => p.high || p.close));
  const dd = h30 > 0 ? ((cur.close - h30) / h30) * 100 : 0;
  const l14 = Math.min(...p14.filter(p => p.low > 0).map(p => p.low));
  const rec = l14 > 0 ? ((cur.close - l14) / l14) * 100 : 0;
  const avgV = p7.reduce((s, p) => s + (p.volume || 0), 0) / p7.length;
  const vr = avgV > 0 ? (cur.volume || 0) / avgV : 0;
  const fg = m.current_fg;

  // Commodity context
  let c30ret = null, cTrend = null;
  if (m.primary_commodity) {
    try {
      const cn = commNowQ.get(m.primary_commodity);
      const c30 = comm30Q.get(m.primary_commodity);
      if (cn && c30 && c30.price_usd > 0) {
        c30ret = ((cn.price_usd - c30.price_usd) / c30.price_usd) * 100;
        cTrend = c30ret > 5 ? 'rising' : c30ret < -5 ? 'falling' : 'flat';
      }
    } catch {}
  }

  // Sector F&G
  let secFg = null;
  if (m.primary_commodity) {
    const sf = db.prepare("SELECT ROUND(AVG(current_fg),1) as a FROM mining_performance WHERE primary_commodity=? AND current_fg IS NOT NULL").get(m.primary_commodity);
    secFg = sf?.a || null;
  }

  // Score
  let score = 0, reasons = [], max = 100;
  if (dd < -20) { const diff = Math.abs(dd - (profile.drawdown || -36)); score += diff < 15 ? 20 : diff < 25 ? 12 : 8; reasons.push('DD ' + dd.toFixed(0) + '%'); }
  if (fg !== null && fg < -10) { const diff = Math.abs(fg - (profile.fg_score || -17)); score += diff < 10 ? 20 : fg < -15 ? 15 : 8; reasons.push('F&G ' + fg.toFixed(0)); }
  if (rec > 0 && rec < 20) { score += 15; reasons.push('Recovery +' + rec.toFixed(1) + '%'); } else if (rec >= 0 && rec < 5) { score += 8; }
  if (vr > 1.0 && vr < 3.0) { score += 10; reasons.push('Vol ' + vr.toFixed(1) + 'x'); } else if (vr >= 0.5) score += 5;
  if (ret30d !== null && ret30d < -10 && ret7d !== null && ret7d > -5) { score += 10; reasons.push('Bottoming'); }
  if (c30ret !== null && c30ret > 3 && ret30d !== null && ret30d < 0) { score += 15; reasons.push('CATCH-UP: comm +' + c30ret.toFixed(0) + '% stock ' + ret30d.toFixed(0) + '%'); }
  else if (c30ret !== null && c30ret > 0 && ret30d !== null && ret30d < c30ret - 5) { score += 8; reasons.push('Lagging comm'); }
  if (secFg !== null && secFg < -15) { score += 10; reasons.push('Sector fear ' + secFg.toFixed(0)); } else if (secFg !== null && secFg < -10) score += 5;

  results.push({ ticker: m.ticker, name: m.name, commodity: m.primary_commodity, stage: m.stage, exchange: m.exchange, score, reasons, dd, fg, ret7d, ret30d, rec, vr, c30ret, cTrend, secFg, pctATH: m.pct_from_ath, commCorr: m.commodity_correlation, price: m.current_price });
}

results.sort((a, b) => b.score - a.score);

// Output
console.log('\n═══ TOP 25 MINERS MATCHING PRE-PUMP CONDITIONS ═══\n');
console.log('Rk  Score  Ticker        Commodity        F&G   DD30d  Ret7d Ret30d VolR CommTrend  Reasons');
console.log('-'.repeat(115));
for (let i = 0; i < 25 && i < results.length; i++) {
  const r = results[i];
  if (r.score < 25) break;
  console.log(
    String(i+1).padStart(2) + '  ' + String(r.score).padStart(3) + '%  ' +
    (r.ticker||'').padEnd(14) + (r.commodity||'?').padEnd(17) +
    (r.fg !== null ? r.fg.toFixed(0) : '?').padStart(5) +
    (r.dd?.toFixed(0)+'%').padStart(7) +
    (r.ret7d !== null ? r.ret7d.toFixed(0)+'%' : '?').padStart(6) +
    (r.ret30d !== null ? r.ret30d.toFixed(0)+'%' : '?').padStart(7) +
    (r.vr?.toFixed(1)+'x').padStart(5) +
    (r.cTrend||'?').padStart(10) +
    '  ' + r.reasons.join(' | ')
  );
}

// Catch-up trades
console.log('\n═══ CATCH-UP TRADES (commodity up, stock still down) ═══\n');
const catchUps = results.filter(r => r.c30ret > 3 && r.ret30d !== null && r.ret30d < 0 && r.fg !== null && r.fg < -10);
if (catchUps.length > 0) {
  for (const r of catchUps.slice(0, 10)) {
    console.log('  🟢 ' + (r.ticker||'').padEnd(12) + (r.commodity||'').padEnd(14) + 'Score:' + r.score + '%  Comm +' + r.c30ret.toFixed(1) + '% BUT stock ' + r.ret30d.toFixed(0) + '%  F&G:' + r.fg.toFixed(0) + (r.commCorr > 0.25 ? '  corr:' + r.commCorr.toFixed(2) : ''));
  }
} else {
  console.log('  None — commodity prices missing for: Lithium, Nickel, Zinc, Cobalt, Rare Earths, Tin');
  console.log('  Available: Gold, Silver, Copper, Platinum, Palladium, Oil, Gas, Uranium');
}

// Sector washout
console.log('\n═══ SECTOR WASHOUT ═══\n');
const sectors = {};
for (const r of results) { if (!r.commodity) continue; if (!sectors[r.commodity]) sectors[r.commodity] = []; sectors[r.commodity].push(r); }
Object.entries(sectors).filter(([, m]) => m.length >= 3).sort(([,a],[,b]) => {
  const aFg = a.filter(m=>m.fg!==null).reduce((s,m)=>s+m.fg,0)/(a.filter(m=>m.fg!==null).length||1);
  const bFg = b.filter(m=>m.fg!==null).reduce((s,m)=>s+m.fg,0)/(b.filter(m=>m.fg!==null).length||1);
  return aFg - bFg;
}).forEach(([comm, ms]) => {
  const fgMs = ms.filter(m => m.fg !== null);
  const avgFg = fgMs.length > 0 ? fgMs.reduce((s, m) => s + m.fg, 0) / fgMs.length : null;
  const inFear = fgMs.filter(m => m.fg < -20).length;
  const best = ms.sort((a, b) => b.score - a.score)[0];
  if (avgFg === null || avgFg >= -5) return;
  const sig = avgFg < -20 ? '🟢🟢' : avgFg < -12 ? '🟢 ' : '🟡 ';
  console.log('  ' + sig + ' ' + comm.padEnd(16) + 'avg F&G:' + avgFg.toFixed(1) + '  ' + inFear + '/' + fgMs.length + ' extreme  best: ' + best.ticker + ' (score:' + best.score + '%)');
});

// Strongest setups
console.log('\n═══ STRONGEST (deep fear + high commodity correlation) ═══\n');
const strong = results.filter(r => r.fg !== null && r.fg < -20 && r.commCorr !== null && r.commCorr > 0.2 && r.dd < -25 && r.score >= 35);
if (strong.length > 0) {
  for (const r of strong.slice(0, 10)) {
    console.log('  ⭐ ' + (r.ticker||'').padEnd(12) + (r.commodity||'').padEnd(14) + 'Score:' + r.score + '% F&G:' + r.fg.toFixed(0) + ' DD:' + r.dd.toFixed(0) + '% Corr:' + r.commCorr.toFixed(2) + ' ' + (r.cTrend === 'rising' ? '🟢 comm rising' : r.cTrend === 'flat' ? '🟡 comm flat' : r.cTrend || 'no data'));
  }
} else {
  console.log('  None at current thresholds');
}

// Summary
const a50 = results.filter(r => r.score >= 50).length, a70 = results.filter(r => r.score >= 70).length;
console.log('\n╔══════════════════════════════════════════════════════╗');
console.log('║   SUMMARY — ' + new Date().toISOString().split('T')[0] + '                          ║');
console.log('╠══════════════════════════════════════════════════════╣');
console.log('║  Miners evaluated: ' + String(results.length).padStart(4) + '                            ║');
console.log('║  Score 50%+: ' + String(a50).padStart(4) + '  Score 70%+: ' + String(a70).padStart(4) + '                ║');
console.log('║  Catch-up trades: ' + String(catchUps.length).padStart(4) + '                            ║');
console.log('╚══════════════════════════════════════════════════════╝');

// Phone notification
const body = 'MINING SCAN\n\nTop matches:\n' + results.filter(r=>r.score>=50).slice(0,5).map(r=>r.ticker+' '+r.commodity+' score:'+r.score+'% F&G:'+(r.fg?.toFixed(0)||'?')).join('\n');
try { const https = require('https'); const req = https.request({ hostname:'ntfy.sh', path:'/kieran-fg-signals', method:'POST', headers:{'Title':'Mining Scan '+new Date().toISOString().split('T')[0],'Priority':'default'}},res=>res.resume()); req.write(body); req.end(); } catch {}

db.close();
