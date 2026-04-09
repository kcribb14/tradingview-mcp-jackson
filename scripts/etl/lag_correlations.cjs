const Database = require('better-sqlite3');
const DB = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
DB.pragma('journal_mode = WAL');

const insertLag = DB.prepare(`INSERT OR REPLACE INTO lag_correlations (ticker_leader, ticker_follower, lag_days, correlation, hit_rate, avg_follower_move, sample_size) VALUES (?, ?, ?, ?, ?, ?, ?)`);

function pearson(a, b) {
  const n = a.length;
  if (n < 10) return null;
  let sa=0,sb=0,saa=0,sbb=0,sab=0;
  for (let i=0;i<n;i++){sa+=a[i];sb+=b[i];saa+=a[i]*a[i];sbb+=b[i]*b[i];sab+=a[i]*b[i]}
  const den = Math.sqrt((n*saa-sa*sa)*(n*sbb-sb*sb));
  return den===0 ? null : (n*sab-sa*sb)/den;
}

function lagCorrelation(aligned, lag) {
  if (aligned.length < lag + 30) return null;
  const leader = [], follower = [];
  for (let i = 0; i < aligned.length - lag; i++) { leader.push(aligned[i].ra); follower.push(aligned[i + lag].rb); }
  const corr = pearson(leader, follower);
  // Hit rate: when leader moved >1%, did follower move same direction within lag window?
  let signals = 0, hits = 0, sumMove = 0;
  for (let i = 0; i < aligned.length - lag; i++) {
    if (Math.abs(aligned[i].ra) < 0.01) continue;
    signals++;
    const cumF = aligned.slice(i + 1, i + 1 + lag).reduce((acc, b) => acc * (1 + b.rb), 1) - 1;
    if (Math.sign(cumF) === Math.sign(aligned[i].ra)) hits++;
    sumMove += cumF * Math.sign(aligned[i].ra);
  }
  return { correlation: corr, hit_rate: signals > 0 ? hits / signals : null, avg_follower_move: signals > 0 ? sumMove / signals : null, sample_size: aligned.length - lag };
}

function main() {
  console.log('Lag correlation ETL\n');
  const groups = DB.prepare('SELECT DISTINCT group_name FROM asset_groups').all().map(r => r.group_name);
  const LAGS = [0, 1, 2, 3, 5, 10, 20];
  let totalPairs = 0, totalRows = 0;

  for (const group of groups) {
    console.log(`\n${group}:`);
    const members = DB.prepare('SELECT ticker, position FROM asset_groups WHERE group_name = ? ORDER BY position').all(group);
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const leader = members[i].ticker, follower = members[j].ticker;
        // Date-aligned returns
        const aligned = DB.prepare(`
          SELECT ra.date_or_ts as date, ra.return_pct as ra, rb.return_pct as rb
          FROM returns ra JOIN returns rb ON ra.date_or_ts = rb.date_or_ts AND ra.timeframe = rb.timeframe
          WHERE ra.ticker = ? AND rb.ticker = ? AND ra.timeframe = 'D' ORDER BY ra.date_or_ts ASC
        `).all(leader, follower);
        if (aligned.length < 50) { continue; }

        let peakLag = 0, peakCorr = 0;
        for (const lag of LAGS) {
          const r = lagCorrelation(aligned, lag);
          if (r && r.correlation !== null) {
            insertLag.run(leader, follower, lag, r.correlation, r.hit_rate, r.avg_follower_move, r.sample_size);
            totalRows++;
            if (Math.abs(r.correlation) > Math.abs(peakCorr)) { peakCorr = r.correlation; peakLag = lag; }
          }
        }
        if (peakCorr !== 0) console.log(`  ${leader.padEnd(10)} -> ${follower.padEnd(10)} peak ${peakLag}d corr ${peakCorr.toFixed(3)} (${aligned.length} bars)`);
        totalPairs++;
      }
    }
  }
  console.log(`\n${totalPairs} pairs, ${totalRows} lag rows`);
  DB.close();
}
main();
