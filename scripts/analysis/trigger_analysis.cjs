const Database = require('better-sqlite3');
const db = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db', { readonly: true });

function median(arr) {
  const s = arr.filter(v => v !== null && !isNaN(v) && isFinite(v)).sort((a,b) => a-b);
  return s.length > 0 ? s[Math.floor(s.length / 2)] : null;
}
function q25(a) { const s=a.filter(v=>v!==null&&!isNaN(v)&&isFinite(v)).sort((a,b)=>a-b); return s.length>0?s[Math.floor(s.length*0.25)]:null; }
function q75(a) { const s=a.filter(v=>v!==null&&!isNaN(v)&&isFinite(v)).sort((a,b)=>a-b); return s.length>0?s[Math.floor(s.length*0.75)]:null; }

console.log('══════════════════════════════════════════════════════════════');
console.log('  TRIGGER ANALYSIS: What separates pump-days from non-pump days?');
console.log('══════════════════════════════════════════════════════════════\n');

// Group A: pump events from clean dataset
const groupA = db.prepare("SELECT * FROM mining_pump_events_clean WHERE drawdown_from_high < -20 AND pump_pct >= 40").all();
console.log('Group A (pumped): ' + groupA.length + ' events');

// Group B: condition-days that went NOWHERE (DD<-20%, F&G<0, but 30d return -15% to +15%)
const groupB = db.prepare(`
  SELECT p1.ticker, p1.date, p1.close, p1.volume, h.fg_score,
         (SELECT AVG(volume) FROM prices pv WHERE pv.ticker=p1.ticker AND pv.date>date(p1.date,'-7 days') AND pv.date<p1.date) as avg_vol_7d,
         (SELECT close FROM prices py WHERE py.ticker=p1.ticker AND py.date=(SELECT MAX(date) FROM prices WHERE ticker=p1.ticker AND date<p1.date AND date>=date(p1.date,'-7 days'))) as price_7d_ago,
         (p2.close-p1.close)/NULLIF(p1.close,0)*100 as fwd_30d
  FROM prices p1
  JOIN mining_companies mc ON mc.ticker=p1.ticker
  JOIN fg_history h ON h.ticker=p1.ticker AND h.date=p1.date
  JOIN prices p2 ON p2.ticker=p1.ticker AND p2.date=(SELECT MIN(date) FROM prices WHERE ticker=p1.ticker AND date>=date(p1.date,'+30 days'))
  WHERE h.fg_score<0
    AND p1.close<(SELECT MAX(high) FROM prices px WHERE px.ticker=p1.ticker AND px.date>date(p1.date,'-30 days') AND px.date<=p1.date)*0.80
    AND ABS((p2.close-p1.close)/NULLIF(p1.close,0)*100)<15
    AND p1.date>'2015-01-01' AND p1.close>0 AND p2.close>0
  ORDER BY RANDOM() LIMIT 5000
`).all();
console.log('Group B (no pump): ' + groupB.length + ' condition-days that went nowhere\n');

// === 2. VOLUME ===
console.log('═══ 2. VOLUME — Is volume spike the trigger? ═══\n');
const aVol = groupA.map(p => p.volume_ratio).filter(v => v !== null && v < 100);
const bVol = groupB.map(p => p.avg_vol_7d > 0 ? p.volume / p.avg_vol_7d : null).filter(v => v !== null && v < 100);

console.log('  Volume ratio (day vol / 7d avg):');
console.log('                Q25      Median      Q75');
console.log('  PUMP days:  ' + (q25(aVol)||0).toFixed(1).padStart(6) + 'x   ' + (median(aVol)||0).toFixed(1).padStart(6) + 'x   ' + (q75(aVol)||0).toFixed(1).padStart(6) + 'x  (n=' + aVol.length + ')');
console.log('  NON-pump:   ' + (q25(bVol)||0).toFixed(1).padStart(6) + 'x   ' + (median(bVol)||0).toFixed(1).padStart(6) + 'x   ' + (q75(bVol)||0).toFixed(1).padStart(6) + 'x  (n=' + bVol.length + ')');
const volDiff = (median(aVol)||0) - (median(bVol)||0);
console.log('\n  Difference: ' + (volDiff > 0 ? '+' : '') + volDiff.toFixed(1) + 'x');
console.log('  ' + (volDiff > 1.5 ? '✅ VOLUME SPIKE IS A TRIGGER' : volDiff > 0.5 ? '⚠️ Moderate volume signal' : '❌ Volume not differentiating'));

// Volume buckets
console.log('\n  Volume breakdown of pump events:');
const volBuckets = [[0,0.5,'<0.5x dead'],[0.5,1,'0.5-1x normal'],[1,2,'1-2x elevated'],[2,5,'2-5x spike'],[5,10,'5-10x major'],[10,100,'10x+ extreme']];
for (const [lo,hi,label] of volBuckets) {
  const n = groupA.filter(p => p.volume_ratio >= lo && p.volume_ratio < hi).length;
  console.log('    ' + label.padEnd(16) + (n/groupA.length*100).toFixed(1) + '% of pumps');
}

// === 3. 7-DAY MOMENTUM ===
console.log('\n═══ 3. 7-DAY MOMENTUM — Does the stock turn before pumping? ═══\n');
const a7d = groupA.map(p => p.pre_7d_return).filter(v => v !== null && isFinite(v));
const b7d = groupB.map(p => p.price_7d_ago > 0 ? (p.close - p.price_7d_ago) / p.price_7d_ago * 100 : null).filter(v => v !== null && isFinite(v));

console.log('  7-day return before:');
console.log('                Q25      Median      Q75');
console.log('  PUMP days:  ' + (q25(a7d)||0).toFixed(1).padStart(6) + '%   ' + (median(a7d)||0).toFixed(1).padStart(6) + '%   ' + (q75(a7d)||0).toFixed(1).padStart(6) + '%');
console.log('  NON-pump:   ' + (q25(b7d)||0).toFixed(1).padStart(6) + '%   ' + (median(b7d)||0).toFixed(1).padStart(6) + '%   ' + (q75(b7d)||0).toFixed(1).padStart(6) + '%');
const momDiff = (median(a7d)||0) - (median(b7d)||0);
console.log('\n  Difference: ' + (momDiff > 0 ? '+' : '') + momDiff.toFixed(1) + '%');
console.log('  ' + (momDiff > 3 ? '✅ MOMENTUM TURN IS A TRIGGER' : momDiff > 1 ? '⚠️ Slight momentum edge' : '❌ No momentum difference'));

// === 4. COMMODITY TREND ===
console.log('\n═══ 4. COMMODITY TREND AT TIME OF PUMP ═══\n');
const ct = { rising: 0, flat: 0, falling: 0, none: 0 };
for (const p of groupA) {
  if (p.commodity_trend === 'rising') ct.rising++;
  else if (p.commodity_trend === 'falling') ct.falling++;
  else if (p.commodity_trend === 'flat') ct.flat++;
  else ct.none++;
}
console.log('  Rising:  ' + ct.rising + ' (' + (ct.rising/groupA.length*100).toFixed(1) + '%)');
console.log('  Flat:    ' + ct.flat + ' (' + (ct.flat/groupA.length*100).toFixed(1) + '%)');
console.log('  Falling: ' + ct.falling + ' (' + (ct.falling/groupA.length*100).toFixed(1) + '%)');
console.log('  No data: ' + ct.none + ' (' + (ct.none/groupA.length*100).toFixed(1) + '%)');

if (ct.none / groupA.length > 0.5) {
  console.log('\n  ⚠️ >50% missing commodity data → CANNOT validate commodity trigger');
  console.log('  Missing: Lithium, Nickel, Zinc, Cobalt, Rare Earths, Tin');
} else {
  const rising = groupA.filter(p => p.commodity_trend === 'rising');
  const falling = groupA.filter(p => p.commodity_trend === 'falling');
  if (rising.length > 10 && falling.length > 10) {
    const rH = rising.filter(p=>p.held_gains_30d!==null), fH = falling.filter(p=>p.held_gains_30d!==null);
    console.log('\n  Commodity rising → held: ' + (rH.filter(p=>p.held_gains_30d===1).length/rH.length*100).toFixed(0) + '% med pump: ' + (median(rising.map(p=>p.pump_pct))||0).toFixed(0) + '% (n=' + rising.length + ')');
    console.log('  Commodity falling → held: ' + (fH.filter(p=>p.held_gains_30d===1).length/fH.length*100).toFixed(0) + '% med pump: ' + (median(falling.map(p=>p.pump_pct))||0).toFixed(0) + '% (n=' + falling.length + ')');
  }
}

// === 5. DIVERGENCE ===
console.log('\n═══ 5. STOCK-COMMODITY DIVERGENCE ═══\n');
const withDiv = groupA.filter(p => p.stock_commodity_divergence !== null && isFinite(p.stock_commodity_divergence));
console.log('  Events with divergence data: ' + withDiv.length);
if (withDiv.length > 20) {
  const bigDiv = withDiv.filter(p => p.stock_commodity_divergence < -10);
  const smallDiv = withDiv.filter(p => p.stock_commodity_divergence >= -5);
  console.log('  Stock lagging commodity >10pts: ' + bigDiv.length + ' → med pump: ' + (median(bigDiv.map(p=>p.pump_pct))||0).toFixed(0) + '%');
  console.log('  Stock near commodity (±5pts):   ' + smallDiv.length + ' → med pump: ' + (median(smallDiv.map(p=>p.pump_pct))||0).toFixed(0) + '%');
}

// === 6. DAY OF WEEK ===
console.log('\n═══ 6. DAY OF WEEK ═══\n');
const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
for (let d = 0; d < 7; d++) {
  const dp = groupA.filter(p => p.day_of_week === d);
  if (dp.length > 0) {
    const hR = dp.filter(p=>p.held_gains_30d!==null);
    const hp = hR.length>0?(hR.filter(p=>p.held_gains_30d===1).length/hR.length*100).toFixed(0)+'%':'?';
    console.log('  ' + dayNames[d].padEnd(5) + String(dp.length).padStart(5) + ' pumps (' + (dp.length/groupA.length*100).toFixed(1) + '%)  held: ' + hp);
  }
}

// === 7. F&G DEPTH — Does deeper fear = bigger pump? ===
console.log('\n═══ 7. F&G DEPTH — Does deeper fear produce better pumps? ═══\n');
const fgBuckets = [[-999,-25,'Extreme fear <-25'],[-25,-15,'Deep fear -25 to -15'],[-15,-5,'Mild fear -15 to -5'],[-5,5,'Neutral -5 to +5'],[5,999,'Greed >5']];
for (const [lo,hi,label] of fgBuckets) {
  const fp = groupA.filter(p => p.pre_fg_score !== null && p.pre_fg_score >= lo && p.pre_fg_score < hi);
  if (fp.length >= 5) {
    const hR = fp.filter(p=>p.held_gains_30d!==null);
    const hp = hR.length>0?(hR.filter(p=>p.held_gains_30d===1).length/hR.length*100).toFixed(0)+'%':'?';
    console.log('  ' + label.padEnd(25) + String(fp.length).padStart(5) + ' pumps  med pump: ' + (median(fp.map(p=>p.pump_pct))||0).toFixed(0) + '%  held: ' + hp);
  }
}

// === VERDICT ===
console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║                    TRIGGER VERDICT                          ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');
console.log('  BASE (narrows field, no edge alone):');
console.log('    DD > 20% + F&G < -10 → identifies ~50 candidates\n');
console.log('  TRIGGER CANDIDATES:');
console.log('    1. Volume spike:  pump median ' + (median(aVol)||0).toFixed(1) + 'x vs non-pump ' + (median(bVol)||0).toFixed(1) + 'x');
console.log('       ' + (volDiff > 1.5 ? '✅ CONFIRMED' : volDiff > 0.5 ? '⚠️ POSSIBLE' : '❌ NOT confirmed'));
console.log('    2. 7d momentum:   pump median ' + (median(a7d)||0).toFixed(1) + '% vs non-pump ' + (median(b7d)||0).toFixed(1) + '%');
console.log('       ' + (momDiff > 3 ? '✅ CONFIRMED' : momDiff > 1 ? '⚠️ POSSIBLE' : '❌ NOT confirmed'));
console.log('    3. Commodity turn: ' + (ct.none > groupA.length * 0.5 ? '❓ UNTESTABLE (50%+ missing data)' : 'tested above'));
console.log('    4. Insider buying: ❓ UNTESTABLE (insider_trades coverage unknown for ASX)');
console.log('    5. Sector washout: tested above');
console.log('\n  RECOMMENDED STRATEGY:');
console.log('    Conditions (DD + F&G) → narrow to ~50 miners');
console.log('    THEN wait for trigger (volume spike OR commodity turn OR catalyst)');
console.log('    Do NOT enter on conditions alone — zero edge proven');

db.close();
