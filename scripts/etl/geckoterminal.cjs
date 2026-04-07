// GeckoTerminal ETL — top pools per network + trending. Free, 30/min.
const Database = require('better-sqlite3');
const DB = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
DB.pragma('journal_mode = WAL');

const upsertToken = DB.prepare(`
  INSERT OR REPLACE INTO dex_tokens (
    token_address, chain, symbol, name, pair_address, dex_id,
    base_token_address, quote_token_symbol, liquidity_usd,
    market_cap, fdv, price_usd, price_native,
    volume_24h, volume_6h, volume_1h,
    txns_buys_24h, txns_sells_24h,
    price_change_5m, price_change_1h, price_change_6h, price_change_24h,
    pair_created_at, url, fetched_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
`);

async function fetchJSON(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'Accept': 'application/json;version=20230302' }, signal: AbortSignal.timeout(15000) });
      if (r.status === 429) { await new Promise(r => setTimeout(r, 2500 * (i + 1))); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch {}
  }
  return null;
}

const NETWORKS = ['eth', 'solana', 'base', 'arbitrum', 'bsc', 'polygon_pos', 'avax', 'optimism',
  'ton', 'sui-network', 'blast', 'linea', 'scroll', 'mantle', 'cronos', 'fantom'];

function savePool(network, pool) {
  const a = pool.attributes;
  if (!a) return false;
  const baseAddr = a.address || '';
  const parts = (a.name || '').split(' / ');
  try {
    upsertToken.run(
      baseAddr, network, (parts[0] || '').toUpperCase(), a.name || '',
      a.address, pool.relationships?.dex?.data?.id || '', baseAddr,
      (parts[1] || '').toUpperCase(), parseFloat(a.reserve_in_usd) || 0,
      parseFloat(a.market_cap_usd) || 0, parseFloat(a.fdv_usd) || 0,
      parseFloat(a.base_token_price_usd) || 0, parseFloat(a.base_token_price_native_currency) || 0,
      parseFloat(a.volume_usd?.h24) || 0, parseFloat(a.volume_usd?.h6) || 0,
      parseFloat(a.volume_usd?.h1) || 0, a.transactions?.h24?.buys || 0, a.transactions?.h24?.sells || 0,
      parseFloat(a.price_change_percentage?.m5) || 0, parseFloat(a.price_change_percentage?.h1) || 0,
      parseFloat(a.price_change_percentage?.h6) || 0, parseFloat(a.price_change_percentage?.h24) || 0,
      a.pool_created_at ? Math.floor(new Date(a.pool_created_at).getTime() / 1000) : 0,
      `https://www.geckoterminal.com/${network}/pools/${a.address}`
    );
    return true;
  } catch { return false; }
}

async function main() {
  console.log('GeckoTerminal ETL starting...');
  let total = 0;
  for (const network of NETWORKS) {
    let netCount = 0;
    for (let page = 1; page <= 3; page++) {
      const data = await fetchJSON(`https://api.geckoterminal.com/api/v2/networks/${network}/pools?page=${page}`);
      for (const pool of (data?.data || [])) if (savePool(network, pool)) { netCount++; total++; }
      await new Promise(r => setTimeout(r, 2200));
    }
    const trending = await fetchJSON(`https://api.geckoterminal.com/api/v2/networks/${network}/trending_pools`);
    for (const pool of (trending?.data || [])) if (savePool(network, pool)) { netCount++; total++; }
    console.log('  ' + network.padEnd(15) + '+' + netCount + ' (total: ' + total + ')');
    await new Promise(r => setTimeout(r, 2200));
  }
  const stats = DB.prepare('SELECT COUNT(*) as t, COUNT(DISTINCT chain) as c FROM dex_tokens').get();
  console.log('\nDB total:', stats.t, 'tokens across', stats.c, 'chains');
  DB.close();
}
main().catch(console.error);
