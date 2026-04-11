const Database = require('better-sqlite3');
const db = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');

db.exec("CREATE TABLE IF NOT EXISTS mining_pump_events (event_id TEXT PRIMARY KEY, ticker TEXT, name TEXT, exchange TEXT, primary_commodity TEXT, stage TEXT, pump_date TEXT, pump_start_price REAL, pump_peak_price REAL, pump_pct REAL, pre_7d_return REAL, pre_14d_return REAL, pre_30d_return REAL, pre_90d_return REAL, drawdown_from_high REAL, recovery_off_bottom REAL, volume_ratio REAL, pre_7d_volatility REAL, day_of_week INTEGER, pre_fg_score REAL, commodity_price_at_pump REAL, commodity_30d_return REAL, commodity_90d_return REAL, commodity_trend TEXT, stock_commodity_divergence REAL, post_1d_return REAL, post_5d_return REAL, post_10d_return REAL, post_30d_return REAL, held_gains_30d INTEGER, market_cap_at_pump REAL)");
db.exec("CREATE INDEX IF NOT EXISTS idx_mpump_commodity ON mining_pump_events(primary_commodity)");
db.exec("CREATE TABLE IF NOT EXISTS mining_pump_characteristics (characteristic TEXT PRIMARY KEY, avg_value REAL, median_value REAL, min_value REAL, max_value REAL, std_dev REAL, sample_count INTEGER, description TEXT)");

const miners = db.prepare("SELECT mc.ticker,mc.name,mc.exchange,mc.primary_commodity,mc.stage,mc.market_cap_aud FROM mining_companies mc JOIN prices p ON mc.ticker=p.ticker GROUP BY mc.ticker HAVING COUNT(p.date)>=100").all();
console.log('Scanning', miners.length, 'miners...');

const ins = db.prepare("INSERT OR IGNORE INTO mining_pump_events (event_id,ticker,name,exchange,primary_commodity,stage,pump_date,pump_start_price,pump_peak_price,pump_pct,pre_7d_return,pre_14d_return,pre_30d_return,pre_90d_return,drawdown_from_high,recovery_off_bottom,volume_ratio,pre_7d_volatility,day_of_week,pre_fg_score,commodity_price_at_pump,commodity_30d_return,commodity_90d_return,commodity_trend,stock_commodity_divergence,post_1d_return,post_5d_return,post_10d_return,post_30d_return,held_gains_30d,market_cap_at_pump) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");

// Pre-compile commodity lookups
const commNowQ = db.prepare("SELECT price_usd FROM commodity_prices WHERE commodity=? AND date<=? ORDER BY date DESC LIMIT 1");
const comm30Q = db.prepare("SELECT price_usd FROM commodity_prices WHERE commodity=? AND date<=date(?,-30) ORDER BY date DESC LIMIT 1");
const comm90Q = db.prepare("SELECT price_usd FROM commodity_prices WHERE commodity=? AND date<=date(?,-90) ORDER BY date DESC LIMIT 1");
const fgQ = db.prepare("SELECT fg_score FROM fg_history WHERE ticker=? AND date<=? ORDER BY date DESC LIMIT 1");

let total = 0;
for (let mi = 0; mi < miners.length; mi++) {
  const m = miners[mi];
  const prices = db.prepare("SELECT date,open,high,low,close,volume FROM prices WHERE ticker=? ORDER BY date ASC").all(m.ticker);
  if (prices.length < 100) continue;

  for (let i = 1; i < prices.length; i++) {
    const t = prices[i], y = prices[i-1];
    if (!y.close || y.close <= 0) continue;
    const pct = Math.max(((t.high-y.close)/y.close)*100, ((t.close-y.close)/y.close)*100);
    if (pct < 30) continue;

    const p7=prices.slice(Math.max(0,i-7),i), p14=prices.slice(Math.max(0,i-14),i), p30=prices.slice(Math.max(0,i-30),i), p90=prices.slice(Math.max(0,i-90),i);
    if (p7.length<3) continue;
    const ret = a => a.length>=2?((a[a.length-1].close-a[0].close)/a[0].close)*100:null;
    const avgV=p7.reduce((s,p)=>s+(p.volume||0),0)/p7.length;
    const vr=avgV>0?(t.volume||0)/avgV:0;
    const dr=[];for(let j=1;j<p7.length;j++)if(p7[j-1].close>0)dr.push((p7[j].close-p7[j-1].close)/p7[j-1].close);
    const avgDR=dr.length>0?dr.reduce((s,v)=>s+v,0)/dr.length:0;
    const vol=dr.length>1?Math.sqrt(dr.reduce((s,v)=>s+(v-avgDR)**2,0)/(dr.length-1))*100:0;
    const h30=Math.max(...p30.map(p=>p.high||p.close));
    const dd=h30>0?((y.close-h30)/h30)*100:0;
    const l14=Math.min(...p14.filter(p=>p.low>0).map(p=>p.low));
    const rec=l14>0?((y.close-l14)/l14)*100:0;
    const fg=fgQ.get(m.ticker,t.date);

    let cp=null,c30=null,c90=null,ct=null,div=null;
    if(m.primary_commodity){
      try{
        const cn=commNowQ.get(m.primary_commodity,t.date);
        const c30a=comm30Q.get(m.primary_commodity,t.date);
        const c90a=comm90Q.get(m.primary_commodity,t.date);
        cp=cn?.price_usd||null;
        if(cn&&c30a&&c30a.price_usd>0)c30=((cn.price_usd-c30a.price_usd)/c30a.price_usd)*100;
        if(cn&&c90a&&c90a.price_usd>0)c90=((cn.price_usd-c90a.price_usd)/c90a.price_usd)*100;
        if(c30!==null)ct=c30>5?'rising':c30<-5?'falling':'flat';
        const r30=p30.length>=20?ret(p30):null;if(r30!==null&&c30!==null)div=r30-c30;
      }catch{}
    }

    const post=(off)=>prices[i+off]?((prices[i+off].close-t.close)/t.close)*100:null;
    const p30r=post(30);

    try{ins.run('mining_'+m.ticker+'_'+t.date,m.ticker,m.name,m.exchange,m.primary_commodity,m.stage,t.date,y.close,t.high,pct,ret(p7),ret(p14),p30.length>=20?ret(p30):null,p90.length>=60?ret(p90):null,dd,rec,vr,vol,new Date(t.date).getDay(),fg?.fg_score||null,cp,c30,c90,ct,div,post(1),post(5),post(10),p30r,p30r!==null?(p30r>-20?1:0):null,m.market_cap_aud);total++;}catch{}
  }
  if(mi%25===0)process.stdout.write('\r  '+mi+'/'+miners.length+' pumps:'+total);
}
console.log('\r  '+miners.length+'/'+miners.length+' pumps:'+total);

// Breakdown
console.log('\nBy commodity (40%+ pumps):');
db.prepare("SELECT primary_commodity,COUNT(*) as n,ROUND(AVG(pump_pct),1) as avg FROM mining_pump_events WHERE pump_pct>=40 GROUP BY primary_commodity ORDER BY n DESC LIMIT 15").all()
  .forEach(c=>console.log('  '+(c.primary_commodity||'?').padEnd(18)+c.n+' events, avg '+c.avg+'%'));

// Characteristics
console.log('\n═══ MINING PRE-PUMP PROFILE (40%+ pumps) ═══\n');
const pumps = db.prepare("SELECT * FROM mining_pump_events WHERE pump_pct>=40").all();
console.log('Total events:', pumps.length);

const insC = db.prepare("INSERT OR REPLACE INTO mining_pump_characteristics VALUES (?,?,?,?,?,?,?,?)");
function analyze(name,vals,desc){
  const c=vals.filter(v=>v!=null&&isFinite(v));if(c.length<10){console.log('  '+name.padEnd(35)+'n='+c.length);return;}
  const sorted=[...c].sort((a,b)=>a-b);const avg=c.reduce((s,v)=>s+v,0)/c.length;const med=sorted[Math.floor(sorted.length/2)];const sd=Math.sqrt(c.reduce((s,v)=>s+(v-avg)**2,0)/(c.length-1));
  insC.run(name,avg,med,Math.min(...c),Math.max(...c),sd,c.length,desc);
  console.log('  '+name.padEnd(35)+'avg:'+avg.toFixed(1).padStart(8)+' med:'+med.toFixed(1).padStart(8)+' n='+c.length);
}

analyze('mining_pre_7d_return',pumps.map(p=>p.pre_7d_return),'7d return before');
analyze('mining_pre_30d_return',pumps.map(p=>p.pre_30d_return),'30d return before');
analyze('mining_drawdown',pumps.map(p=>p.drawdown_from_high),'Drawdown from 30d high');
analyze('mining_recovery',pumps.map(p=>p.recovery_off_bottom),'Recovery off 14d low');
analyze('mining_volume_ratio',pumps.map(p=>p.volume_ratio),'Volume ratio pump/7d');
analyze('mining_volatility',pumps.map(p=>p.pre_7d_volatility),'7d volatility');
analyze('mining_fg_score',pumps.map(p=>p.pre_fg_score),'F&G before pump');
analyze('mining_commodity_30d',pumps.map(p=>p.commodity_30d_return),'Commodity 30d return');
analyze('mining_divergence',pumps.map(p=>p.stock_commodity_divergence),'Stock-commodity divergence');
analyze('mining_pump_pct',pumps.map(p=>p.pump_pct),'Pump size');
analyze('mining_post_5d',pumps.map(p=>p.post_5d_return),'5d post-pump');
analyze('mining_post_30d',pumps.map(p=>p.post_30d_return),'30d post-pump');

const held=pumps.filter(p=>p.held_gains_30d!=null);
console.log('\n  Held gains 30d: '+(held.filter(p=>p.held_gains_30d===1).length/held.length*100).toFixed(1)+'% (n='+held.length+')');

// Cross-tabs
console.log('\n═══ PATTERNS ═══');
const catchUp=pumps.filter(p=>p.commodity_30d_return>5&&p.pre_30d_return!=null&&p.pre_30d_return<0);
if(catchUp.length>5)console.log('  Catch-up (comm up, stock down): avg pump '+(catchUp.reduce((s,p)=>s+p.pump_pct,0)/catchUp.length).toFixed(1)+'% (n='+catchUp.length+')');
const deepFear=pumps.filter(p=>p.drawdown_from_high<-40&&p.pre_fg_score!=null&&p.pre_fg_score<-20);
if(deepFear.length>5)console.log('  Deep DD + deep fear: avg pump '+(deepFear.reduce((s,p)=>s+p.pump_pct,0)/deepFear.length).toFixed(1)+'% (n='+deepFear.length+')');

db.close();
