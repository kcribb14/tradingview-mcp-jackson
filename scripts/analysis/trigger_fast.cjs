// Fast trigger analysis — reads only mining_pump_events_clean (small table)
const Database = require('better-sqlite3');
const db = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db', { readonly: true });

function med(a) {
  const s = a.filter(v => v != null && !isNaN(v) && isFinite(v) && Math.abs(v) < 1e6).sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
}

const A = db.prepare("SELECT volume_ratio, pre_7d_return, pre_fg_score, commodity_trend, pump_pct, held_gains_30d, day_of_week FROM mining_pump_events_clean WHERE drawdown_from_high < -20 AND pump_pct >= 40").all();

console.log("TRIGGER ANALYSIS (" + A.length + " pump events)\n");

// VOLUME
const aVol = A.map(p => p.volume_ratio).filter(v => v > 0 && v < 100);
console.log("=== VOLUME ===");
console.log("Pump day median: " + med(aVol).toFixed(1) + "x (normal = 1.0x)");
console.log("Diff: +" + (med(aVol) - 1).toFixed(1) + "x above normal");
console.log("<1x: " + (A.filter(p => p.volume_ratio < 1).length / A.length * 100).toFixed(0) + "% | 1-2x: " + (A.filter(p => p.volume_ratio >= 1 && p.volume_ratio < 2).length / A.length * 100).toFixed(0) + "% | 2-5x: " + (A.filter(p => p.volume_ratio >= 2 && p.volume_ratio < 5).length / A.length * 100).toFixed(0) + "% | 5-10x: " + (A.filter(p => p.volume_ratio >= 5 && p.volume_ratio < 10).length / A.length * 100).toFixed(0) + "% | 10x+: " + (A.filter(p => p.volume_ratio >= 10 && p.volume_ratio < 100).length / A.length * 100).toFixed(0) + "%");

// MOMENTUM
const a7d = A.map(p => p.pre_7d_return).filter(v => v != null && isFinite(v));
console.log("\n=== 7-DAY MOMENTUM ===");
console.log("Pump 7d return median: " + med(a7d).toFixed(1) + "%");

// COMMODITY
let r = 0, fl = 0, fa = 0, no = 0;
for (const p of A) { if (p.commodity_trend === 'rising') r++; else if (p.commodity_trend === 'falling') fa++; else if (p.commodity_trend === 'flat') fl++; else no++; }
console.log("\n=== COMMODITY ===");
console.log("Rising:" + r + " Flat:" + fl + " Falling:" + fa + " NoData:" + no + " (" + (no / A.length * 100).toFixed(0) + "% missing)");

// F&G DEPTH
console.log("\n=== F&G DEPTH ===");
const fgBuckets = [[-999, -25, "Extreme <-25"], [-25, -15, "Deep -25 to -15"], [-15, -5, "Mild -15 to -5"], [-5, 5, "Neutral"], [5, 999, "Greed >5"]];
for (const [lo, hi, label] of fgBuckets) {
  const fp = A.filter(p => p.pre_fg_score != null && p.pre_fg_score >= lo && p.pre_fg_score < hi);
  if (fp.length >= 5) {
    const h = fp.filter(p => p.held_gains_30d != null);
    const hp = h.length > 0 ? (h.filter(p => p.held_gains_30d === 1).length / h.length * 100).toFixed(0) : "?";
    console.log("  " + label.padEnd(20) + fp.length + " pumps  med:" + med(fp.map(p => p.pump_pct)).toFixed(0) + "%  held:" + hp + "%");
  }
}

// DAY
console.log("\n=== DAY OF WEEK ===");
const dayN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
for (let d = 0; d < 7; d++) {
  const dp = A.filter(p => p.day_of_week === d);
  if (dp.length > 0) console.log("  " + dayN[d] + ": " + dp.length + " (" + (dp.length / A.length * 100).toFixed(1) + "%)");
}

// VERDICT
console.log("\n=== VERDICT ===");
console.log("VOLUME: " + (med(aVol) > 2.5 ? "CONFIRMED TRIGGER" : med(aVol) > 1.5 ? "LIKELY TRIGGER" : "WEAK") + " (median " + med(aVol).toFixed(1) + "x)");
console.log("MOMENTUM: " + (med(a7d) > 2 ? "CONFIRMED" : "WEAK") + " (median " + med(a7d).toFixed(1) + "%)");
console.log("COMMODITY: " + (no > A.length * 0.5 ? "UNTESTABLE" : "Tested"));
console.log("\nSTRATEGY: DD>20% + F&G<-10 = watchlist → volume 3x+ = entry trigger");

db.close();
