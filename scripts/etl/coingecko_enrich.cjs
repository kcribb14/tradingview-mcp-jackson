// CoinGecko enrichment from markets endpoint (no detail calls needed). Free.
const Database = require('better-sqlite3');
const DB = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
DB.pragma('journal_mode = WAL');
const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

const upsertMeta = DB.prepare("INSERT OR REPLACE INTO token_metadata (token_address,chain,symbol,total_supply,circulating_supply,max_supply,coingecko_id,is_verified,fetched_at) VALUES (?,?,?,?,?,?,?,1,CURRENT_TIMESTAMP)");

async function main() {
  console.log('CoinGecko markets enrichment...');
  let allCoins = [];
  for (let page = 1; page <= 10; page++) {
    try {
      const r = await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}`, { signal: AbortSignal.timeout(15000) });
      if (r.ok) { const d = await r.json(); if (Array.isArray(d)) allCoins.push(...d); else break; }
      else break;
    } catch { break; }
    await new Promise(r => setTimeout(r, 7000)); // Very conservative rate limit
  }
  console.log('  Coins from markets:', allCoins.length);

  let count = 0;
  const tx = DB.transaction(() => {
    for (const c of allCoins) {
      const sym = (c.symbol || '').toUpperCase();
      upsertMeta.run(c.id, 'multi', sym, c.total_supply || 0, c.circulating_supply || 0, c.max_supply || 0, c.id, 1);
      count++;
    }
  });
  tx();
  console.log('  Metadata saved:', count);
  DB.close();
}
main().catch(console.error);
