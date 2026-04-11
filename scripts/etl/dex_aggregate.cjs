const Database = require('better-sqlite3');
const DB = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
console.log('Building daily aggregates...');
DB.exec(`
  INSERT OR REPLACE INTO dex_daily
  (token_address, chain, date, open_price, high_price, low_price, close_price,
   avg_liquidity, max_liquidity, total_volume, total_buys, total_sells,
   buy_sell_ratio, avg_mcap, snapshot_count)
  SELECT token_address, chain, DATE(snapshot_ts) as date,
    (SELECT price_usd FROM dex_snapshots s2 WHERE s2.token_address = s1.token_address AND s2.chain = s1.chain AND DATE(s2.snapshot_ts) = DATE(s1.snapshot_ts) ORDER BY s2.snapshot_ts ASC LIMIT 1),
    MAX(price_usd), MIN(CASE WHEN price_usd > 0 THEN price_usd END),
    (SELECT price_usd FROM dex_snapshots s3 WHERE s3.token_address = s1.token_address AND s3.chain = s1.chain AND DATE(s3.snapshot_ts) = DATE(s1.snapshot_ts) ORDER BY s3.snapshot_ts DESC LIMIT 1),
    AVG(liquidity_usd), MAX(liquidity_usd), MAX(volume_24h),
    SUM(txns_buys_1h), SUM(txns_sells_1h),
    ROUND(CAST(SUM(txns_buys_1h) AS REAL) / NULLIF(SUM(txns_buys_1h) + SUM(txns_sells_1h), 0), 3),
    AVG(market_cap), COUNT(*)
  FROM dex_snapshots s1 WHERE price_usd > 0
  GROUP BY token_address, chain, DATE(snapshot_ts)
`);
DB.exec(`
  INSERT OR REPLACE INTO dex_hourly_profile
  (token_address, chain, hour_utc, avg_volume, avg_buys, avg_sells, avg_price_change, sample_count)
  SELECT token_address, chain, CAST(strftime('%H', snapshot_ts) AS INTEGER),
    AVG(volume_1h), AVG(txns_buys_1h), AVG(txns_sells_1h), AVG(price_change_1h), COUNT(*)
  FROM dex_snapshots WHERE volume_1h > 0
  GROUP BY token_address, chain, CAST(strftime('%H', snapshot_ts) AS INTEGER)
`);
const d = DB.prepare('SELECT COUNT(*) as n, COUNT(DISTINCT token_address) as t FROM dex_daily').get();
const h = DB.prepare('SELECT COUNT(*) as n FROM dex_hourly_profile').get();
console.log('Daily:', d.n, 'rows,', d.t, 'tokens | Hourly profiles:', h.n);
DB.close();
