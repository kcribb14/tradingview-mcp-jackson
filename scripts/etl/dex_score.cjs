const Database = require('better-sqlite3');
const DB = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');

function computeDEXScore(t) {
  let score = 0;
  const totalTxns = (t.txns_buys_24h || 0) + (t.txns_sells_24h || 0);
  if (totalTxns > 50) score += ((t.txns_buys_24h / totalTxns) - 0.5) * 60;
  const chg = t.price_change_24h || 0;
  if (chg < -20) score -= 25; else if (chg < -10) score -= 15; else if (chg < -5) score -= 8;
  else if (chg > 20) score += 25; else if (chg > 10) score += 15; else if (chg > 5) score += 8;
  if (t.volume_24h > 0 && t.volume_1h > 0) {
    const ratio = (t.volume_1h * 24) / t.volume_24h;
    if (ratio > 2) score += 15; else if (ratio > 1.3) score += 8; else if (ratio < 0.5) score -= 8;
  }
  if (t.market_cap > 0 && t.liquidity_usd > 0) {
    const lr = t.liquidity_usd / t.market_cap;
    if (lr < 0.01) score -= 20; else if (lr < 0.05) score -= 10; else if (lr > 0.2) score += 10;
  }
  if ((t.liquidity_usd || 0) < 10000) score -= 30;
  return Math.max(-60, Math.min(60, Math.round(score * 10) / 10));
}

const insertFG = DB.prepare('INSERT OR REPLACE INTO fg_history (ticker, date, fg_score, zone) VALUES (?, ?, ?, ?)');
const upsertSym = DB.prepare('INSERT OR REPLACE INTO symbols (ticker, name, category, asset_class) VALUES (?, ?, ?, ?)');
const tokens = DB.prepare('SELECT * FROM dex_tokens WHERE liquidity_usd > 10000 ORDER BY liquidity_usd DESC LIMIT 5000').all();

console.log('Computing DEX scores for', tokens.length, 'tokens');
const today = new Date().toISOString().split('T')[0];
let count = 0;

const batch = DB.transaction(() => {
  for (const t of tokens) {
    const score = computeDEXScore(t);
    const zone = score < -25 ? 'extreme_fear' : score < -10 ? 'fear' : score < 10 ? 'neutral' : score < 25 ? 'greed' : 'extreme_greed';
    const ticker = `${t.symbol}-${t.chain}`.toUpperCase();
    upsertSym.run(ticker, t.name, `DEX_${t.chain.toUpperCase()}`, 'dex');
    insertFG.run(ticker, today, score, zone);
    count++;
  }
});
batch();

console.log('DEX scores computed:', count);

const extreme = DB.prepare(`
  SELECT s.ticker, h.fg_score, t.liquidity_usd, t.volume_24h, t.price_change_24h
  FROM fg_history h JOIN symbols s ON h.ticker = s.ticker
  JOIN dex_tokens t ON UPPER(t.symbol)||'-'||UPPER(t.chain) = s.ticker
  WHERE h.date = ? AND s.asset_class = 'dex' AND h.fg_score < -25 AND t.liquidity_usd > 50000
  ORDER BY h.fg_score ASC LIMIT 10
`).all(today);

if (extreme.length) {
  console.log('\nTop DEX extreme fear:');
  extreme.forEach(e => console.log('  ' + e.ticker.padEnd(22) + 'F&G:' + e.fg_score + '  liq:$' + (e.liquidity_usd / 1000).toFixed(0) + 'k  chg:' + (e.price_change_24h || 0).toFixed(1) + '%'));
}
DB.close();
