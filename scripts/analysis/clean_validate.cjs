const Database = require('better-sqlite3');
const db = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');

function median(arr) {
  const s = arr.filter(v => v !== null && !isNaN(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m-1]+s[m])/2;
}

console.log('══════════════════════════════════════════════════════════');
console.log('  CLEANING + RE-VALIDATING MINING PUMP PROFILE');
console.log('══════════════════════════════════════════════════════════\n');

// 1. CONTAMINATION AUDIT
console.log('═══ 1. CONTAMINATION AUDIT ═══\n');
const totalBefore = db.prepare('SELECT COUNT(*) as n FROM mining_pump_events WHERE pump_pct >= 40').get().n;
const repeaters = db.prepare('SELECT ticker, COUNT(*) as n, ROUND(AVG(pump_pct),1) as avg FROM mining_pump_events WHERE pump_pct>=40 GROUP BY ticker ORDER BY n DESC LIMIT 10').all();
let repTotal = 0;
for (const r of repeaters) { repTotal += r.n; console.log('  '+r.ticker.padEnd(12)+r.n+' pumps, avg '+r.avg+'%'); }
console.log('\n  Top 10 = '+repTotal+' / '+totalBefore+' = '+(repTotal/totalBefore*100).toFixed(0)+'%');
console.log('  Pumps > 500%: '+db.prepare('SELECT COUNT(*) as n FROM mining_pump_events WHERE pump_pct>=40 AND pump_pct>500').get().n);

// 2. CLEAN
console.log('\n═══ 2. APPLYING FILTERS ═══\n');
db.exec('DROP TABLE IF EXISTS mining_pump_events_clean');
db.exec(`CREATE TABLE mining_pump_events_clean AS
  SELECT * FROM mining_pump_events
  WHERE pump_pct >= 40 AND pump_pct < 500
    AND ticker NOT IN (SELECT ticker FROM mining_pump_events WHERE pump_pct>=40 GROUP BY ticker HAVING COUNT(*)>50)`);

const cleanN = db.prepare('SELECT COUNT(*) as n FROM mining_pump_events_clean').get().n;
const cleanT = db.prepare('SELECT COUNT(DISTINCT ticker) as n FROM mining_pump_events_clean').get().n;
const maxRep = db.prepare('SELECT ticker, COUNT(*) as n FROM mining_pump_events_clean GROUP BY ticker ORDER BY n DESC LIMIT 1').get();
console.log('  Removed: pumps>500% + tickers with >50 events');
console.log('  Before: '+totalBefore+'  After: '+cleanN+' (-'+(totalBefore-cleanN)+')');
console.log('  Tickers: '+cleanT+'  Max/ticker: '+maxRep.n+' ('+maxRep.ticker+', '+(maxRep.n/cleanN*100).toFixed(1)+'%)');

// 3. CLEAN PROFILE
console.log('\n═══ 3. CLEANED PRE-PUMP PROFILE ═══\n');
const all = db.prepare('SELECT * FROM mining_pump_events_clean').all();
const fields = [
  ['drawdown_from_high','Drawdown from 30d high'],
  ['pre_7d_return','7d return before pump'],
  ['pre_30d_return','30d return before pump'],
  ['pre_90d_return','90d return before pump'],
  ['recovery_off_bottom','Recovery off 14d low'],
  ['volume_ratio','Volume ratio pump/7d'],
  ['pre_7d_volatility','7d volatility %'],
  ['pre_fg_score','F&G score before pump'],
  ['pump_pct','Pump size'],
  ['post_5d_return','5d post-pump'],
  ['post_10d_return','10d post-pump'],
  ['post_30d_return','30d post-pump']
];

console.log('Metric'.padEnd(28)+'Median'.padStart(10)+'Mean'.padStart(10)+'  n'.padStart(7));
console.log('-'.repeat(55));
for (const [f, desc] of fields) {
  const vals = all.map(p => p[f]).filter(v => v !== null && !isNaN(v));
  const med = median(vals);
  const avg = vals.length > 0 ? vals.reduce((s,v)=>s+v,0)/vals.length : null;
  console.log(f.padEnd(28)+(med!==null?med.toFixed(1):'?').padStart(10)+(avg!==null?avg.toFixed(1):'?').padStart(10)+String(vals.length).padStart(7));
}
const held = all.filter(p => p.held_gains_30d !== null);
const heldPct = held.length > 0 ? (held.filter(p=>p.held_gains_30d===1).length/held.length*100).toFixed(1) : '?';
console.log('\nHeld 30d: '+heldPct+'% (n='+held.length+')');

// 4. TIME CONSISTENCY
console.log('\n═══ 4. TIME CONSISTENCY (cleaned, medians) ═══\n');
const periods = [["Pre-2015","pump_date<'2015-01-01'"],["2015-2018","pump_date>='2015-01-01' AND pump_date<'2019-01-01'"],["2019-2021","pump_date>='2019-01-01' AND pump_date<'2022-01-01'"],["2022-2024","pump_date>='2022-01-01' AND pump_date<'2025-01-01'"],["2025-2026","pump_date>='2025-01-01'"]];
console.log('Period        Events  MedDD   MedF&G  MedVol  MedPump Held%');
console.log('-'.repeat(65));
for (const [label, where] of periods) {
  const rows = db.prepare('SELECT * FROM mining_pump_events_clean WHERE '+where).all();
  if (rows.length < 10) { console.log(label.padEnd(14)+String(rows.length).padStart(6)+'  (too few)'); continue; }
  const hR = rows.filter(r=>r.held_gains_30d!==null);
  const hp = hR.length>0?(hR.filter(r=>r.held_gains_30d===1).length/hR.length*100).toFixed(0)+'%':'?';
  console.log(label.padEnd(14)+String(rows.length).padStart(6)+(median(rows.map(r=>r.drawdown_from_high))?.toFixed(0)+'%').padStart(8)+(median(rows.map(r=>r.pre_fg_score))!==null?median(rows.map(r=>r.pre_fg_score)).toFixed(0):'?').padStart(8)+(median(rows.map(r=>r.volume_ratio))?.toFixed(1)+'x').padStart(8)+(median(rows.map(r=>r.pump_pct))?.toFixed(0)+'%').padStart(9)+hp.padStart(6));
}

// 5. COMMODITY CONSISTENCY
console.log('\n═══ 5. COMMODITY CONSISTENCY (cleaned, medians) ═══\n');
const byCom = {};
for (const p of all) { if (!p.primary_commodity) continue; if (!byCom[p.primary_commodity]) byCom[p.primary_commodity] = []; byCom[p.primary_commodity].push(p); }
console.log('Commodity         Events  MedDD   MedF&G  MedPump MedP30d Held%');
console.log('-'.repeat(68));
for (const [c, ps] of Object.entries(byCom).filter(([,p])=>p.length>=20).sort((a,b)=>b[1].length-a[1].length)) {
  const hR=ps.filter(p=>p.held_gains_30d!==null);const hp=hR.length>0?(hR.filter(p=>p.held_gains_30d===1).length/hR.length*100).toFixed(0)+'%':'?';
  console.log(c.padEnd(18)+String(ps.length).padStart(6)+(median(ps.map(p=>p.drawdown_from_high))?.toFixed(0)+'%').padStart(8)+(median(ps.map(p=>p.pre_fg_score))!==null?String(median(ps.map(p=>p.pre_fg_score)).toFixed(0)):'?').padStart(8)+(median(ps.map(p=>p.pump_pct))?.toFixed(0)+'%').padStart(9)+(median(ps.map(p=>p.post_30d_return))?.toFixed(0)+'%').padStart(8)+hp.padStart(6));
}

// 6. STACKING
console.log('\n═══ 6. CONDITION STACKING (cleaned) ═══\n');
function stack(label, fn) {
  const f=all.filter(fn);const hR=f.filter(p=>p.held_gains_30d!==null);const hp=hR.length>0?(hR.filter(p=>p.held_gains_30d===1).length/hR.length*100).toFixed(0)+'%':'?';
  console.log(label.padEnd(55)+String(f.length).padStart(6)+hp.padStart(7)+(median(f.map(p=>p.post_30d_return))!==null?median(f.map(p=>p.post_30d_return)).toFixed(0)+'%':'?').padStart(10)+(median(f.map(p=>p.pump_pct))?.toFixed(0)+'%').padStart(10));
}
console.log('Conditions'.padEnd(55)+'Events'.padStart(6)+'Held%'.padStart(7)+'MedP30d'.padStart(10)+'MedPump'.padStart(10));
console.log('-'.repeat(88));
stack('All clean',p=>true);
stack('DD<-20%',p=>p.drawdown_from_high<-20);
stack('DD<-20% + F&G<-10',p=>p.drawdown_from_high<-20&&p.pre_fg_score!==null&&p.pre_fg_score<-10);
stack('DD<-20% + F&G<-10 + Vol>1x',p=>p.drawdown_from_high<-20&&p.pre_fg_score!==null&&p.pre_fg_score<-10&&p.volume_ratio>1);
stack('DD<-20% + F&G<-10 + Vol>1x + 7d flat',p=>p.drawdown_from_high<-20&&p.pre_fg_score!==null&&p.pre_fg_score<-10&&p.volume_ratio>1&&p.pre_7d_return!==null&&p.pre_7d_return>-5);
stack('DD<-30% + F&G<-15 + Vol>1x + 7d flat',p=>p.drawdown_from_high<-30&&p.pre_fg_score!==null&&p.pre_fg_score<-15&&p.volume_ratio>1&&p.pre_7d_return!==null&&p.pre_7d_return>-5);
stack('DD<-30% + F&G<-15 + Vol>1x + bottoming + rec 0-15%',p=>p.drawdown_from_high<-30&&p.pre_fg_score!==null&&p.pre_fg_score<-15&&p.volume_ratio>1&&p.pre_7d_return!==null&&p.pre_7d_return>-5&&p.pre_30d_return!==null&&p.pre_30d_return<-5&&p.recovery_off_bottom>0&&p.recovery_off_bottom<15);

// 7. EDGE vs BASELINE (median-based)
console.log('\n═══ 7. EDGE vs BASELINE (median, clean, post-2018) ═══\n');
const baseRows = db.prepare("SELECT (p2.close-p1.close)/NULLIF(p1.close,0)*100 as ret FROM prices p1 JOIN mining_companies mc ON mc.ticker=p1.ticker JOIN prices p2 ON p2.ticker=p1.ticker AND p2.date=(SELECT MIN(date) FROM prices WHERE ticker=p1.ticker AND date>=date(p1.date,'+30 days')) WHERE p1.date>'2018-01-01' AND p1.close>0 AND p2.close>0 ORDER BY RANDOM() LIMIT 50000").all().map(r=>r.ret).filter(r=>r!==null&&!isNaN(r)&&Math.abs(r)<500);
const condRows = db.prepare("SELECT (p2.close-p1.close)/NULLIF(p1.close,0)*100 as ret FROM prices p1 JOIN mining_companies mc ON mc.ticker=p1.ticker JOIN fg_history h ON h.ticker=p1.ticker AND h.date=p1.date JOIN prices p2 ON p2.ticker=p1.ticker AND p2.date=(SELECT MIN(date) FROM prices WHERE ticker=p1.ticker AND date>=date(p1.date,'+30 days')) WHERE h.fg_score<-10 AND p1.date>'2018-01-01' AND p1.close>0 AND p2.close>0 AND p1.close<(SELECT MAX(high) FROM prices px WHERE px.ticker=p1.ticker AND px.date>date(p1.date,'-30 days') AND px.date<=p1.date)*0.75 ORDER BY RANDOM() LIMIT 50000").all().map(r=>r.ret).filter(r=>r!==null&&!isNaN(r)&&Math.abs(r)<500);

const baseMed = median(baseRows), condMed = median(condRows);
console.log('  Random mining day → 30d median: '+(baseMed!==null?baseMed.toFixed(1)+'%':'?')+' (n='+baseRows.length+')');
console.log('  Condition match  → 30d median:  '+(condMed!==null?condMed.toFixed(1)+'%':'?')+' (n='+condRows.length+')');
if (baseMed!==null && condMed!==null) {
  const edge = condMed - baseMed;
  console.log('  Edge: '+(edge>0?'+':'')+edge.toFixed(1)+'% → '+(edge>3?'✅ STRONG':edge>1?'✅ Moderate':edge>0?'⚠️ Small':'❌ None'));
}
// Quartiles
const bQ = baseRows.sort((a,b)=>a-b), cQ = condRows.sort((a,b)=>a-b);
console.log('\n                Q25        Median       Q75');
console.log('  Random:   '+(bQ[Math.floor(bQ.length*0.25)]||0).toFixed(1).padStart(8)+'%  '+(baseMed||0).toFixed(1).padStart(8)+'%  '+(bQ[Math.floor(bQ.length*0.75)]||0).toFixed(1).padStart(8)+'%');
console.log('  Condition:'+(cQ[Math.floor(cQ.length*0.25)]||0).toFixed(1).padStart(8)+'%  '+(condMed||0).toFixed(1).padStart(8)+'%  '+(cQ[Math.floor(cQ.length*0.75)]||0).toFixed(1).padStart(8)+'%');

// 8. EXCHANGE
console.log('\n═══ 8. BY EXCHANGE ═══\n');
const byEx = {};
for (const p of all) { if (!p.exchange) continue; if (!byEx[p.exchange]) byEx[p.exchange]=[]; byEx[p.exchange].push(p); }
for (const [ex,ps] of Object.entries(byEx).filter(([,p])=>p.length>=20).sort((a,b)=>b[1].length-a[1].length)) {
  const hR=ps.filter(p=>p.held_gains_30d!==null);const hp=hR.length>0?(hR.filter(p=>p.held_gains_30d===1).length/hR.length*100).toFixed(0)+'%':'?';
  console.log('  '+ex.padEnd(8)+String(ps.length).padStart(6)+' events  medDD:'+(median(ps.map(p=>p.drawdown_from_high))?.toFixed(0))+'%  medPump:'+(median(ps.map(p=>p.pump_pct))?.toFixed(0))+'%  held:'+hp);
}

// 9. STAGE
console.log('\n═══ 9. BY STAGE ═══\n');
const bySt = {};
for (const p of all) { const st=p.stage||'Unknown'; if (!bySt[st]) bySt[st]=[]; bySt[st].push(p); }
for (const [st,ps] of Object.entries(bySt).filter(([,p])=>p.length>=10).sort((a,b)=>b[1].length-a[1].length)) {
  const hR=ps.filter(p=>p.held_gains_30d!==null);const hp=hR.length>0?(hR.filter(p=>p.held_gains_30d===1).length/hR.length*100).toFixed(0)+'%':'?';
  console.log('  '+st.padEnd(20)+String(ps.length).padStart(6)+' events  medPump:'+(median(ps.map(p=>p.pump_pct))?.toFixed(0))+'%  medPost30d:'+(median(ps.map(p=>p.post_30d_return))?.toFixed(0))+'%  held:'+hp);
}

// VERDICT
console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║              CLEANED VALIDATION VERDICT                     ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');
console.log('  CLEANED PROFILE (medians):');
for (const f of ['drawdown_from_high','pre_fg_score','recovery_off_bottom','volume_ratio','pre_30d_return','pre_7d_return']) {
  const v=all.map(p=>p[f]).filter(v=>v!==null&&!isNaN(v));const m=median(v);
  if (m!==null) console.log('    '+f.padEnd(25)+m.toFixed(1)+'  (n='+v.length+')');
}
console.log('    held_gains_30d           '+heldPct+'%');
console.log('\n  vs CONTAMINATED (old):');
console.log('    Repeat pumper concentration: was 23% → now '+(maxRep.n/cleanN*100).toFixed(1)+'%');
console.log('    Avg pump was >1M% → now medians used (no outlier influence)');
console.log('    Edge calculation was garbage → now median-based with n='+condRows.length);
db.close();
