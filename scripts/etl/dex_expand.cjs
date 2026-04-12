#!/usr/bin/env node
/**
 * DEX universe expansion — target 3,000-5,000 tokens in dex_registry.
 * Fetches from DexScreener API: boosts, profiles, search by chain + popular terms.
 * Rate limit: 200ms between calls (~300 req/min safe).
 */
const Database = require('better-sqlite3');
const db = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
db.pragma('journal_mode = WAL');
db.pragma('synchronous = normal');

const beforeCount = db.prepare('SELECT COUNT(*) as n FROM dex_registry').get().n;
console.log('[2/2] → DEX universe expansion');
console.log('  Current dex_registry: ' + beforeCount + ' tokens');
console.log('  Target: 3,000-5,000 tokens\n');

// ─── Helpers ───

async function fetchJSON(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (r.status === 429) {
        const wait = 2000 * (i + 1);
        console.log('  Rate limited, waiting ' + wait + 'ms...');
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      if (i < retries - 1) await new Promise(r => setTimeout(r, 1000));
    }
  }
  return null;
}

const insertRegistry = db.prepare(`
  INSERT OR IGNORE INTO dex_registry
  (token_address, chain, symbol, name, pair_address, dex_id, quote_token, pair_created_at, first_seen_at, url)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
`);

const insertSnapshot = db.prepare(`
  INSERT OR IGNORE INTO dex_snapshots
  (token_address, chain, snapshot_ts, price_usd, market_cap, fdv, liquidity_usd,
   volume_5m, volume_1h, volume_6h, volume_24h,
   txns_buys_5m, txns_sells_5m, txns_buys_1h, txns_sells_1h,
   txns_buys_6h, txns_sells_6h, txns_buys_24h, txns_sells_24h,
   price_change_5m, price_change_1h, price_change_6h, price_change_24h)
  VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

let totalNew = 0;
let totalSnaps = 0;

function savePair(p) {
  if (!p?.baseToken?.address || !p?.chainId) return false;
  const addr = p.baseToken.address;
  const chain = p.chainId;
  const symbol = (p.baseToken.symbol || '').toUpperCase();

  try {
    const res = insertRegistry.run(
      addr, chain, symbol, p.baseToken.name || '',
      p.pairAddress || '', p.dexId || '',
      (p.quoteToken?.symbol || '').toUpperCase(),
      p.pairCreatedAt || 0,
      p.url || ''
    );
    if (res.changes > 0) totalNew++;

    // Also take initial snapshot
    insertSnapshot.run(
      addr, chain,
      parseFloat(p.priceUsd) || 0, p.marketCap || 0, p.fdv || 0,
      p.liquidity?.usd || 0,
      p.volume?.m5 || 0, p.volume?.h1 || 0, p.volume?.h6 || 0, p.volume?.h24 || 0,
      p.txns?.m5?.buys || 0, p.txns?.m5?.sells || 0,
      p.txns?.h1?.buys || 0, p.txns?.h1?.sells || 0,
      p.txns?.h6?.buys || 0, p.txns?.h6?.sells || 0,
      p.txns?.h24?.buys || 0, p.txns?.h24?.sells || 0,
      p.priceChange?.m5 || 0, p.priceChange?.h1 || 0, p.priceChange?.h6 || 0, p.priceChange?.h24 || 0
    );
    totalSnaps++;
    return true;
  } catch { return false; }
}

function progress() {
  const current = db.prepare('SELECT COUNT(*) as n FROM dex_registry').get().n;
  process.stdout.write('\r  Discovered: ' + totalNew + ' new tokens, Total registry: ' + current + '    ');
}

// ─── Phase 1: Boosted tokens ───

async function fetchBoosts() {
  console.log('Phase 1: Boosted tokens...');
  for (const ep of ['top', 'latest']) {
    const data = await fetchJSON(`https://api.dexscreener.com/token-boosts/${ep}/v1`);
    if (!Array.isArray(data)) continue;
    for (let i = 0; i < data.length; i++) {
      const pairs = await fetchJSON(`https://api.dexscreener.com/latest/dex/tokens/${data[i].tokenAddress}`);
      if (pairs?.pairs) for (const p of pairs.pairs.slice(0, 2)) savePair(p);
      if (i % 20 === 0) progress();
      await new Promise(r => setTimeout(r, 200));
    }
  }
  progress(); console.log('');
}

// ─── Phase 2: Token profiles ───

async function fetchProfiles() {
  console.log('Phase 2: Token profiles...');
  const data = await fetchJSON('https://api.dexscreener.com/token-profiles/latest/v1');
  if (!Array.isArray(data)) { console.log('  No profile data'); return; }
  for (let i = 0; i < data.length; i++) {
    const pairs = await fetchJSON(`https://api.dexscreener.com/latest/dex/tokens/${data[i].tokenAddress}`);
    if (pairs?.pairs) for (const p of pairs.pairs.slice(0, 2)) savePair(p);
    if (i % 20 === 0) progress();
    await new Promise(r => setTimeout(r, 200));
  }
  progress(); console.log('');
}

// ─── Phase 3: Search by chain ───

async function fetchByChainSearch() {
  console.log('Phase 3: Search by chain...');

  const chains = ['solana', 'ethereum', 'base', 'bsc', 'arbitrum', 'polygon', 'avalanche', 'ton', 'sui', 'optimism'];
  const terms = [
    // Narrative / meta terms
    'meme', 'ai', 'agent', 'defi', 'rwa', 'gaming', 'nft',
    // Animals
    'dog', 'cat', 'pepe', 'frog', 'shib', 'doge', 'bonk',
    // Trending
    'trump', 'elon', 'grok', 'chad', 'based', 'moon', 'pump',
    // DeFi
    'swap', 'lend', 'stake', 'yield', 'vault', 'bridge',
    // Tokens
    'wif', 'jup', 'ray', 'orca', 'sol', 'eth', 'bnb', 'avax',
    // General
    'gold', 'bitcoin', 'coin', 'token', 'cash', 'pay', 'finance',
    // L2/Infrastructure
    'layer', 'chain', 'net', 'protocol', 'dao',
    // New narratives
    'real', 'world', 'data', 'social', 'music', 'art',
  ];

  // Search each chain with popular terms
  for (const chain of chains) {
    for (let t = 0; t < terms.length; t++) {
      const data = await fetchJSON(`https://api.dexscreener.com/latest/dex/search?q=${terms[t]}%20${chain}`);
      const pairs = (data?.pairs || []).filter(p =>
        p.chainId === chain &&
        (p.liquidity?.usd || 0) > 1000 &&
        (p.volume?.h24 || 0) > 500
      );
      for (const p of pairs.slice(0, 30)) savePair(p);
      if (t % 10 === 0) progress();
      await new Promise(r => setTimeout(r, 250));
    }
    progress(); console.log('  → ' + chain + ' done');
  }
}

// ─── Phase 4: Broad search terms ───

async function fetchBroadSearch() {
  console.log('Phase 4: Broad search...');

  // Single letter/number searches catch many tokens
  const searches = [
    // Popular meme tokens by name
    'PEPE', 'BONK', 'WIF', 'FLOKI', 'SHIB', 'DOGE', 'BRETT', 'POPCAT', 'MEW',
    'GOAT', 'FARTCOIN', 'PNUT', 'ACT', 'VIRTUAL', 'TURBO', 'NEIRO', 'SPX',
    'TOSHI', 'HIGHER', 'DEGEN', 'AERO', 'NORMIE', 'MFER', 'MOODENG',
    // AI tokens
    'RENDER', 'FET', 'OCEAN', 'AGIX', 'TAO', 'RNDR', 'AKT', 'PRIME',
    'GRASS', 'IO', 'ARKM', 'OLAS', 'ALI', 'NMR', 'COVAL', 'PHB',
    // DeFi blue chips
    'UNI', 'AAVE', 'COMP', 'MKR', 'SNX', 'CRV', 'BAL', 'SUSHI',
    'CAKE', 'JOE', 'GMX', 'DYDX', 'LDO', 'RPL', 'FXS', 'PENDLE',
    // Infrastructure
    'LINK', 'GRT', 'FIL', 'AR', 'HNT', 'MOBILE', 'IOTX', 'FLUX',
    // Gaming
    'IMX', 'GALA', 'AXS', 'SAND', 'MANA', 'ENJ', 'ILV', 'PIXEL',
    // RWA
    'ONDO', 'PAXG', 'MPL', 'CFG', 'CPOOL',
    // L1/L2
    'APT', 'SUI', 'SEI', 'TIA', 'INJ', 'NEAR', 'AVAX', 'FTM',
    'OP', 'ARB', 'MATIC', 'MANTA', 'BLAST', 'SCROLL', 'ZK', 'STRK',
    // Solana ecosystem
    'JTO', 'PYTH', 'MNDE', 'MSOL', 'BLZE', 'TNSR', 'KMNO', 'DRIFT',
    'JITO', 'BSOL', 'STEP', 'ORCA', 'RAYDIUM', 'MARINADE',
  ];

  for (let i = 0; i < searches.length; i++) {
    const data = await fetchJSON(`https://api.dexscreener.com/latest/dex/search?q=${searches[i]}`);
    const pairs = (data?.pairs || []).filter(p =>
      (p.liquidity?.usd || 0) > 1000 && (p.volume?.h24 || 0) > 100
    );
    for (const p of pairs.slice(0, 20)) savePair(p);
    if (i % 20 === 0) progress();
    await new Promise(r => setTimeout(r, 250));
  }
  progress(); console.log('');
}

// ─── Phase 5: Trending tokens page ───

async function fetchTrending() {
  console.log('Phase 5: Trending / orders...');
  for (const ep of ['latest', 'top']) {
    const data = await fetchJSON(`https://api.dexscreener.com/orders/v1/${ep}`);
    if (!Array.isArray(data)) continue;
    for (let i = 0; i < Math.min(data.length, 200); i++) {
      if (!data[i].tokenAddress) continue;
      const pairs = await fetchJSON(`https://api.dexscreener.com/latest/dex/tokens/${data[i].tokenAddress}`);
      if (pairs?.pairs) for (const p of pairs.pairs.slice(0, 2)) savePair(p);
      if (i % 20 === 0) progress();
      await new Promise(r => setTimeout(r, 200));
    }
  }
  progress(); console.log('');
}

// ─── Main ───

async function main() {
  const start = Date.now();

  await fetchBoosts();
  await fetchProfiles();
  await fetchByChainSearch();
  await fetchBroadSearch();
  await fetchTrending();

  const afterCount = db.prepare('SELECT COUNT(*) as n FROM dex_registry').get().n;
  const snapCount = db.prepare('SELECT COUNT(*) as n FROM dex_snapshots').get().n;

  // Stats by chain
  console.log('\n═══ DEX REGISTRY BY CHAIN ═══');
  const byChain = db.prepare('SELECT chain, COUNT(*) as n FROM dex_registry GROUP BY chain ORDER BY n DESC').all();
  for (const c of byChain) {
    console.log('  ' + c.chain.padEnd(16) + c.n);
  }

  console.log('\n[2/2] ✓ DEX universe expanded');
  console.log('  Before: ' + beforeCount);
  console.log('  After: ' + afterCount);
  console.log('  New tokens: ' + totalNew);
  console.log('  New snapshots: ' + totalSnaps);
  console.log('  Chains: ' + byChain.length);
  console.log('  Time: ' + ((Date.now() - start) / 60000).toFixed(1) + ' min');

  db.close();
}

main().catch(e => { console.error('FATAL:', e.message); db.close(); });
