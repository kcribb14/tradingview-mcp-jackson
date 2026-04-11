const Database = require('better-sqlite3');
const db = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');

const insertChar = db.prepare('INSERT OR REPLACE INTO pump_characteristics (characteristic, avg_value, median_value, min_value, max_value, std_dev, sample_count, description) VALUES (?,?,?,?,?,?,?,?)');

function median(a) { const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m-1]+s[m])/2; }
function sd(a) { const avg = a.reduce((s,v)=>s+v,0)/a.length; return Math.sqrt(a.reduce((s,v)=>s+(v-avg)**2,0)/(a.length-1)); }

function analyze(name, vals, desc) {
  const c = vals.filter(v => v != null && isFinite(v));
  if (c.length < 10) { console.log('  ' + name.padEnd(32) + 'n=' + c.length + ' (insufficient)'); return; }
  const avg = c.reduce((s,v)=>s+v,0)/c.length, med = median(c), s = sd(c);
  insertChar.run(name, avg, med, Math.min(...c), Math.max(...c), s, c.length, desc);
  console.log('  ' + name.padEnd(32) + 'avg:' + avg.toFixed(1).padStart(8) + ' med:' + med.toFixed(1).padStart(8) + ' std:' + s.toFixed(1).padStart(8) + ' n=' + c.length);
}

// Focus on 60%+ pumps for the primary analysis
const pumps = db.prepare('SELECT * FROM pump_events WHERE pump_pct >= 60').all();
console.log('═══ PRE-PUMP CHARACTERISTICS (60%+ pumps, n=' + pumps.length + ') ═══\n');

console.log('▸ PRICE CONTEXT');
analyze('pre_7d_return', pumps.map(p => p.pre_7d_return), '7d return before pump');
analyze('pre_14d_return', pumps.map(p => p.pre_14d_return), '14d return before pump');
analyze('pre_30d_return', pumps.map(p => p.pre_30d_return), '30d return before pump');
analyze('drawdown_from_high', pumps.map(p => p.drawdown_from_high), 'Drawdown from 30d high');
analyze('recovery_before_pump', pumps.map(p => p.recovery_pct_before_pump), 'Recovery from 14d low');

console.log('\n▸ VOLUME');
analyze('volume_ratio', pumps.map(p => p.volume_ratio), 'Pump vol / 7d avg vol');

console.log('\n▸ VOLATILITY');
analyze('pre_7d_volatility', pumps.map(p => p.pre_7d_volatility), '7d std dev of daily returns %');

console.log('\n▸ F&G SENTIMENT');
analyze('fg_score', pumps.map(p => p.pre_fg_score), 'F&G at time of pump');

console.log('\n▸ TIMING');
analyze('day_of_week', pumps.map(p => p.day_of_week), '0=Sun..6=Sat');

console.log('\n▸ OUTCOME');
analyze('pump_pct', pumps.map(p => p.pump_pct), 'Pump magnitude');
analyze('post_24h', pumps.map(p => p.post_24h_return), 'Return 24h after');
analyze('post_72h', pumps.map(p => p.post_72h_return), 'Return 72h after');
analyze('post_7d', pumps.map(p => p.post_7d_return), 'Return 7d after');

const held = pumps.filter(p => p.held_gains != null);
console.log('\n  Held gains 7d: ' + (held.filter(p=>p.held_gains===1).length/held.length*100).toFixed(1) + '% (n=' + held.length + ')');

// === CROSS-TABS ===
console.log('\n═══ PATTERN DISCOVERY ═══\n');

// Deep drawdown + pump
const deep = pumps.filter(p => p.drawdown_from_high != null && p.drawdown_from_high < -50);
const shallow = pumps.filter(p => p.drawdown_from_high != null && p.drawdown_from_high >= -20);
console.log('▸ Deep (>50%) drawdown: avg pump ' + (deep.length > 0 ? (deep.reduce((s,p)=>s+p.pump_pct,0)/deep.length).toFixed(0) + '% (n=' + deep.length + ')' : 'no data'));
console.log('  Shallow (<20%) drawdown: avg pump ' + (shallow.length > 0 ? (shallow.reduce((s,p)=>s+p.pump_pct,0)/shallow.length).toFixed(0) + '% (n=' + shallow.length + ')' : 'no data'));

// Volume ratio
const bigVol = pumps.filter(p => p.volume_ratio > 5);
const lowVol = pumps.filter(p => p.volume_ratio < 2 && p.volume_ratio > 0);
console.log('\n▸ Volume ratio >5x: avg pump ' + (bigVol.length > 0 ? (bigVol.reduce((s,p)=>s+p.pump_pct,0)/bigVol.length).toFixed(0) + '% (n=' + bigVol.length + ')' : 'n/a'));
console.log('  Volume ratio <2x: avg pump ' + (lowVol.length > 0 ? (lowVol.reduce((s,p)=>s+p.pump_pct,0)/lowVol.length).toFixed(0) + '% (n=' + lowVol.length + ')' : 'n/a'));

// F&G fear
const inFear = pumps.filter(p => p.pre_fg_score != null && p.pre_fg_score < -15);
const notFear = pumps.filter(p => p.pre_fg_score != null && p.pre_fg_score >= 0);
console.log('\n▸ F&G in fear (<-15): avg pump ' + (inFear.length > 0 ? (inFear.reduce((s,p)=>s+p.pump_pct,0)/inFear.length).toFixed(0) + '% (n=' + inFear.length + ')' : 'n/a'));
console.log('  F&G neutral/greed (>=0): avg pump ' + (notFear.length > 0 ? (notFear.reduce((s,p)=>s+p.pump_pct,0)/notFear.length).toFixed(0) + '% (n=' + notFear.length + ')' : 'n/a'));

// Quiet then spike
const quiet = pumps.filter(p => p.pre_7d_volatility != null && p.pre_7d_volatility < 3 && p.volume_ratio > 3);
console.log('\n▸ Low volatility + volume spike (accumulation pattern):');
console.log('  ' + quiet.length + ' events, avg pump ' + (quiet.length > 0 ? (quiet.reduce((s,p)=>s+p.pump_pct,0)/quiet.length).toFixed(0) + '%' : 'n/a'));

// Day of week
console.log('\n▸ Day of week:');
['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach((d, i) => {
  const dp = pumps.filter(p => p.day_of_week === i);
  if (dp.length > 0) console.log('  ' + d + ': ' + dp.length + ' pumps, avg ' + (dp.reduce((s,p)=>s+p.pump_pct,0)/dp.length).toFixed(0) + '%');
});

// Held vs dumped
console.log('\n▸ HELD GAINS ANALYSIS:');
const heldTrue = pumps.filter(p => p.held_gains === 1);
const heldFalse = pumps.filter(p => p.held_gains === 0);
if (heldTrue.length > 10 && heldFalse.length > 10) {
  const heldDD = heldTrue.filter(p=>p.drawdown_from_high!=null).map(p=>p.drawdown_from_high);
  const dumpDD = heldFalse.filter(p=>p.drawdown_from_high!=null).map(p=>p.drawdown_from_high);
  console.log('  Held (7d): avg drawdown before = ' + (heldDD.reduce((s,v)=>s+v,0)/heldDD.length).toFixed(1) + '%, avg pump = ' + (heldTrue.reduce((s,p)=>s+p.pump_pct,0)/heldTrue.length).toFixed(0) + '%');
  console.log('  Dumped:    avg drawdown before = ' + (dumpDD.reduce((s,v)=>s+v,0)/dumpDD.length).toFixed(1) + '%, avg pump = ' + (heldFalse.reduce((s,p)=>s+p.pump_pct,0)/heldFalse.length).toFixed(0) + '%');
}

console.log('\n' + db.prepare('SELECT COUNT(*) as n FROM pump_characteristics').get().n + ' characteristics stored.');
db.close();
