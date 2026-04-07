// DexScreener ETL — pulls DEX tokens across all chains. Free, no key.
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
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (r.status === 429) { await new Promise(r => setTimeout(r, 2000 * (i + 1))); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch {}
  }
  return null;
}

function savePair(p) {
  if (!p.baseToken?.address) return false;
  try {
    upsertToken.run(
      p.baseToken.address, p.chainId, (p.baseToken.symbol || '').toUpperCase(),
      p.baseToken.name || '', p.pairAddress, p.dexId, p.baseToken.address,
      (p.quoteToken?.symbol || '').toUpperCase(), p.liquidity?.usd || 0,
      p.marketCap || 0, p.fdv || 0, parseFloat(p.priceUsd) || 0,
      parseFloat(p.priceNative) || 0, p.volume?.h24 || 0, p.volume?.h6 || 0,
      p.volume?.h1 || 0, p.txns?.h24?.buys || 0, p.txns?.h24?.sells || 0,
      p.priceChange?.m5 || 0, p.priceChange?.h1 || 0, p.priceChange?.h6 || 0,
      p.priceChange?.h24 || 0, p.pairCreatedAt || 0, p.url || ''
    );
    return true;
  } catch { return false; }
}

async function fetchBoosts() {
  let count = 0;
  for (const ep of ['top', 'latest']) {
    const data = await fetchJSON(`https://api.dexscreener.com/token-boosts/${ep}/v1`);
    if (!Array.isArray(data)) continue;
    for (let i = 0; i < data.length; i++) {
      const pairs = await fetchJSON(`https://api.dexscreener.com/latest/dex/tokens/${data[i].tokenAddress}`);
      if (pairs?.pairs) for (const p of pairs.pairs.slice(0, 2)) if (savePair(p)) count++;
      if (i % 10 === 0) process.stdout.write(`\r  Boosts ${ep}: ${i + 1}/${data.length} saved:${count}`);
      await new Promise(r => setTimeout(r, 300));
    }
  }
  console.log(`\n  Boosts: ${count}`);
  return count;
}

async function fetchBySearch() {
  const terms = ['sol', 'meme', 'ai', 'pepe', 'trump', 'pump', 'defi', 'rwa', 'gaming', 'dog',
    'cat', 'moon', 'degen', 'base', 'eth', 'bnb', 'avax', 'sui', 'apt', 'sei', 'tia', 'arb',
    'op', 'jup', 'ray', 'orca', 'bonk', 'wif', 'agent', 'grok'];
  let count = 0;
  for (let i = 0; i < terms.length; i++) {
    const data = await fetchJSON(`https://api.dexscreener.com/latest/dex/search?q=${terms[i]}`);
    const pairs = (data?.pairs || []).filter(p => (p.liquidity?.usd || 0) > 5000 && (p.volume?.h24 || 0) > 1000);
    for (const p of pairs.slice(0, 30)) if (savePair(p)) count++;
    process.stdout.write(`\r  Search: ${i + 1}/${terms.length} total:${count}`);
    await new Promise(r => setTimeout(r, 800));
  }
  console.log(`\n  Search: ${count}`);
  return count;
}

async function fetchProfiles() {
  const data = await fetchJSON('https://api.dexscreener.com/token-profiles/latest/v1');
  if (!Array.isArray(data)) return 0;
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    const pairs = await fetchJSON(`https://api.dexscreener.com/latest/dex/tokens/${data[i].tokenAddress}`);
    if (pairs?.pairs) for (const p of pairs.pairs.slice(0, 1)) if (savePair(p)) count++;
    if (i % 10 === 0) process.stdout.write(`\r  Profiles: ${i + 1}/${data.length} saved:${count}`);
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`\n  Profiles: ${count}`);
  return count;
}

async function main() {
  const start = Date.now();
  console.log('DexScreener ETL starting...');
  await fetchBoosts();
  await fetchBySearch();
  await fetchProfiles();
  const stats = DB.prepare('SELECT COUNT(DISTINCT token_address) as tokens, COUNT(DISTINCT chain) as chains, COUNT(*) as pairs FROM dex_tokens').get();
  const byChain = DB.prepare('SELECT chain, COUNT(*) as n FROM dex_tokens GROUP BY chain ORDER BY n DESC LIMIT 10').all();
  console.log('\nTokens:', stats.tokens, '| Chains:', stats.chains, '| Pairs:', stats.pairs);
  byChain.forEach(c => console.log('  ' + c.chain.padEnd(12) + c.n + ' pairs'));
  console.log('Time:', ((Date.now() - start) / 60000).toFixed(1), 'min');
  DB.close();
}
main().catch(console.error);
