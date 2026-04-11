const Database = require('better-sqlite3');
const DB = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
DB.pragma('journal_mode = WAL');
const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

const upsertReg = DB.prepare('INSERT OR IGNORE INTO dex_registry (token_address, chain, symbol, name, pair_address, dex_id, quote_token, pair_created_at, url) VALUES (?,?,?,?,?,?,?,?,?)');
const insertSnap = DB.prepare('INSERT OR IGNORE INTO dex_snapshots (token_address, chain, snapshot_ts, price_usd, market_cap, fdv, liquidity_usd, volume_5m, volume_1h, volume_6h, volume_24h, txns_buys_5m, txns_sells_5m, txns_buys_1h, txns_sells_1h, txns_buys_6h, txns_sells_6h, txns_buys_24h, txns_sells_24h, price_change_5m, price_change_1h, price_change_6h, price_change_24h) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
const insertTrend = DB.prepare('INSERT OR IGNORE INTO dex_trending_log (token_address, chain, symbol, source, price_at_trending, mcap_at_trending, liquidity_at_trending) VALUES (?,?,?,?,?,?,?)');

async function fetchJSON(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
      if (r.status === 429) { await new Promise(r => setTimeout(r, 2000 * (i + 1))); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch {}
  }
  return null;
}

function processPair(p) {
  if (!p.baseToken?.address || !p.chainId) return false;
  try {
    upsertReg.run(p.baseToken.address, p.chainId, (p.baseToken.symbol||'').toUpperCase(), p.baseToken.name||'', p.pairAddress||'', p.dexId||'', (p.quoteToken?.symbol||'').toUpperCase(), p.pairCreatedAt||0, p.url||'');
    insertSnap.run(p.baseToken.address, p.chainId, now, parseFloat(p.priceUsd)||0, p.marketCap||0, p.fdv||0, p.liquidity?.usd||0, p.volume?.m5||0, p.volume?.h1||0, p.volume?.h6||0, p.volume?.h24||0, p.txns?.m5?.buys||0, p.txns?.m5?.sells||0, p.txns?.h1?.buys||0, p.txns?.h1?.sells||0, p.txns?.h6?.buys||0, p.txns?.h6?.sells||0, p.txns?.h24?.buys||0, p.txns?.h24?.sells||0, p.priceChange?.m5||0, p.priceChange?.h1||0, p.priceChange?.h6||0, p.priceChange?.h24||0);
    return true;
  } catch { return false; }
}

async function collectBoosts() {
  let count = 0;
  for (const ep of ['top', 'latest']) {
    const data = await fetchJSON(`https://api.dexscreener.com/token-boosts/${ep}/v1`);
    if (!Array.isArray(data)) continue;
    for (const t of data.slice(0, 60)) {
      const pairs = await fetchJSON(`https://api.dexscreener.com/latest/dex/tokens/${t.tokenAddress}`);
      if (pairs?.pairs) for (const p of pairs.pairs.slice(0, 2)) {
        if (processPair(p)) { count++; insertTrend.run(p.baseToken.address, p.chainId, (p.baseToken.symbol||'').toUpperCase(), 'boost_'+ep, parseFloat(p.priceUsd)||0, p.marketCap||0, p.liquidity?.usd||0); }
      }
      await new Promise(r => setTimeout(r, 250));
    }
  }
  return count;
}

async function collectSearch() {
  const terms = ['sol','meme','ai','agent','pepe','pump','defi','rwa','gaming','dog','cat','bonk','wif','degen','base','eth','bnb','avax','sui','ton','arb','op','jup','ray','trump','grok','yield','nft','zk','bridge','oracle','gold','btc','usdc','steth'];
  let count = 0;
  for (let i = 0; i < terms.length; i++) {
    const data = await fetchJSON(`https://api.dexscreener.com/latest/dex/search?q=${terms[i]}`);
    for (const p of (data?.pairs||[]).filter(p => (p.liquidity?.usd||0) > 1000).slice(0, 20)) if (processPair(p)) count++;
    process.stdout.write(`\r  Search: ${i+1}/${terms.length} (${count})`);
    await new Promise(r => setTimeout(r, 700));
  }
  console.log('');
  return count;
}

async function collectProfiles() {
  let count = 0;
  const data = await fetchJSON('https://api.dexscreener.com/token-profiles/latest/v1');
  if (!Array.isArray(data)) return 0;
  for (const t of data.slice(0, 80)) {
    const pairs = await fetchJSON(`https://api.dexscreener.com/latest/dex/tokens/${t.tokenAddress}`);
    if (pairs?.pairs) for (const p of pairs.pairs.slice(0, 1)) if (processPair(p)) count++;
    await new Promise(r => setTimeout(r, 250));
  }
  return count;
}

async function collectGecko() {
  const nets = ['solana','eth','base','arbitrum','bsc','polygon_pos','avax','optimism','ton','sui-network','blast','linea','scroll','mantle','fantom','cronos'];
  let count = 0;
  for (const net of nets) {
    for (let page = 1; page <= 2; page++) {
      try {
        const data = await fetchJSON(`https://api.geckoterminal.com/api/v2/networks/${net}/pools?page=${page}`);
        for (const pool of (data?.data||[])) {
          const a = pool.attributes; if (!a) continue;
          const addr = a.address||'';
          try {
            upsertReg.run(addr, net, (a.name||'').split(' / ')[0]?.toUpperCase()||'', a.name||'', a.address, '', '', a.pool_created_at ? Math.floor(new Date(a.pool_created_at).getTime()/1000) : 0, `https://www.geckoterminal.com/${net}/pools/${a.address}`);
            insertSnap.run(addr, net, now, parseFloat(a.base_token_price_usd)||0, parseFloat(a.market_cap_usd)||0, parseFloat(a.fdv_usd)||0, parseFloat(a.reserve_in_usd)||0, 0, parseFloat(a.volume_usd?.h1)||0, parseFloat(a.volume_usd?.h6)||0, parseFloat(a.volume_usd?.h24)||0, 0,0, a.transactions?.h1?.buys||0, a.transactions?.h1?.sells||0, a.transactions?.h6?.buys||0, a.transactions?.h6?.sells||0, a.transactions?.h24?.buys||0, a.transactions?.h24?.sells||0, parseFloat(a.price_change_percentage?.m5)||0, parseFloat(a.price_change_percentage?.h1)||0, parseFloat(a.price_change_percentage?.h6)||0, parseFloat(a.price_change_percentage?.h24)||0);
            count++;
          } catch {}
        }
      } catch {}
      await new Promise(r => setTimeout(r, 2200));
    }
  }
  return count;
}

async function main() {
  const start = Date.now();
  console.log('DEX data collection at', now);
  const boosts = await collectBoosts();
  console.log('  Boosts:', boosts);
  const search = await collectSearch();
  console.log('  Search:', search);
  const profiles = await collectProfiles();
  console.log('  Profiles:', profiles);
  const gecko = await collectGecko();
  console.log('  Gecko:', gecko);
  const total = boosts + search + profiles + gecko;
  const stats = DB.prepare('SELECT COUNT(DISTINCT token_address) as t, COUNT(DISTINCT chain) as c, COUNT(*) as s FROM dex_snapshots').get();
  console.log(`\nTotal: ${total} snapshots | DB: ${stats.t} tokens, ${stats.c} chains, ${stats.s} snapshots | ${((Date.now()-start)/60000).toFixed(1)}min`);
  DB.close();
}
main().catch(console.error);
