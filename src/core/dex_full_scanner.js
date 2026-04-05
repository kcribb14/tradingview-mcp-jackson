/**
 * DexScreener Full Scanner — aggregates ALL token discovery endpoints.
 * Targets 2,000+ unique tokens across all chains.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const HOME = homedir();
const DEX_CACHE = join(HOME, '.tradingview-mcp', 'cache', 'dex_tokens.json');

async function dexFetch(path) {
  const r = await fetch(`https://api.dexscreener.com${path}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(8000),
  });
  return r.ok ? r.json() : null;
}

function dexFG(pair) {
  if (!pair) return { fg: 0, zone: 'Balanced' };
  const pc = pair.priceChange || {};
  const vol = pair.volume || {};
  const txns = pair.txns || {};
  const change24h = pc.h24 ?? 0;
  const change1h = pc.h1 ?? 0;
  const change6h = pc.h6 ?? 0;
  const pmacd = Math.max(-60, Math.min(60, change24h * 0.4));
  const momentum = Math.max(-40, Math.min(40, change1h * 0.3 + (change6h - change24h) * 0.05));
  const vol1h = vol.h1 || 0, vol6h = vol.h6 || 1;
  const direction = change1h > 0 ? 1 : change1h < 0 ? -1 : 0;
  const volTrend = vol6h > 0 ? (vol1h * 6 / vol6h - 1) : 0;
  const volumeFlow = Math.max(-30, Math.min(30, direction * Math.min(3, Math.abs(volTrend)) * 5));
  const buys24 = txns.h24?.buys || 0, sells24 = txns.h24?.sells || 0;
  const totalTxns = buys24 + sells24;
  const orderFlow = Math.max(-20, Math.min(20, totalTxns > 10 ? (buys24 / totalTxns - 0.5) * 40 : 0));
  let ageRisk = 0;
  if (pair.pairCreatedAt) {
    const ageH = (Date.now() - pair.pairCreatedAt) / 3600000;
    if (ageH < 1) ageRisk = -10; else if (ageH < 24) ageRisk = -5; else if (ageH < 168) ageRisk = -2;
  }
  const raw = (pmacd + momentum + volumeFlow + orderFlow + ageRisk) / 5;
  const score = Math.max(-80, Math.min(100, Math.round(raw * 100) / 100));
  const zone = score >= 73 ? 'Euphoria' : score >= 41 ? 'Thrill' : score >= 10 ? 'Excitement' : score >= 5 ? 'Optimism' :
    score >= -5 ? 'Balanced' : score >= -10 ? 'Anxiety' : score >= -25 ? 'Fear' : score >= -41 ? 'Panic' : 'Despondency';
  return { fg: score, zone };
}

function buildToken(pair, fg, source) {
  return {
    symbol: pair.baseToken?.symbol || '???',
    name: pair.baseToken?.name || '',
    address: pair.baseToken?.address || '',
    chain: pair.chainId,
    dex: pair.dexId,
    price: parseFloat(pair.priceUsd || 0),
    mcap: pair.marketCap || pair.fdv || 0,
    volume24h: pair.volume?.h24 || 0,
    liquidity: pair.liquidity?.usd || 0,
    buys24h: pair.txns?.h24?.buys || 0,
    sells24h: pair.txns?.h24?.sells || 0,
    priceChange: pair.priceChange || {},
    fg: fg?.fg ?? 0,
    zone: fg?.zone ?? 'Balanced',
    source,
    url: pair.url,
    addedAt: new Date().toISOString(),
  };
}

export async function fullDexScan() {
  const seen = new Set();
  const allTokens = [];
  const t0 = Date.now();

  function addPairs(pairs, source) {
    for (const pair of pairs) {
      const addr = pair.baseToken?.address;
      if (!addr || seen.has(addr)) continue;
      if ((pair.volume?.h24 || 0) < 500) continue;
      if ((pair.liquidity?.usd || 0) < 200) continue;
      seen.add(addr);
      const fg = dexFG(pair);
      allTokens.push(buildToken(pair, fg, source));
    }
  }

  // Source 1: Top boosted
  console.log('Fetching top boosted...');
  const boosted = await dexFetch('/token-boosts/top/v1');
  if (Array.isArray(boosted)) {
    for (const b of boosted) {
      if (!b.tokenAddress || seen.has(b.tokenAddress)) continue;
      seen.add(b.tokenAddress);
      const data = await dexFetch(`/latest/dex/tokens/${b.tokenAddress}`);
      const pairs = data?.pairs || [];
      if (pairs.length > 0) {
        pairs.sort((a, b2) => (b2.volume?.h24 || 0) - (a.volume?.h24 || 0));
        addPairs([pairs[0]], 'boosted');
      }
      await new Promise(r => setTimeout(r, 300));
    }
  }
  console.log(`  Boosted: ${allTokens.length} tokens (${((Date.now()-t0)/1000).toFixed(0)}s)`);

  // Source 2: Profiles
  const profiles = await dexFetch('/token-profiles/latest/v1');
  if (Array.isArray(profiles)) {
    for (const p of profiles) {
      if (!p.tokenAddress || seen.has(p.tokenAddress)) continue;
      seen.add(p.tokenAddress);
      const data = await dexFetch(`/latest/dex/tokens/${p.tokenAddress}`);
      const pairs = data?.pairs || [];
      if (pairs.length > 0) {
        pairs.sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));
        addPairs([pairs[0]], 'profile');
      }
      await new Promise(r => setTimeout(r, 300));
    }
  }
  console.log(`  + Profiles: ${allTokens.length} tokens (${((Date.now()-t0)/1000).toFixed(0)}s)`);

  // Source 3: Search popular terms (30 terms × 30 pairs = ~900)
  const terms = ['sol','meme','ai','pepe','trump','pump','defi','rwa','gaming','dog','cat',
    'moon','degen','gem','base','eth','bnb','avax','sui','apt','sei','tia','arb','op',
    'jup','ray','orca','swap','yield','nft','layer','zk','eigen','bonk','wif'];
  for (let i = 0; i < terms.length; i += 5) {
    const batch = terms.slice(i, i + 5);
    const results = await Promise.all(batch.map(q => dexFetch(`/latest/dex/search?q=${encodeURIComponent(q)}`)));
    for (const data of results) addPairs(data?.pairs || [], 'search');
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`  + Search: ${allTokens.length} tokens (${((Date.now()-t0)/1000).toFixed(0)}s)`);

  // Source 4: Top pairs per chain
  const chains = ['solana','ethereum','base','arbitrum','bsc','avalanche','polygon','optimism','fantom','cronos','sui','sonic'];
  for (const chain of chains) {
    const data = await dexFetch(`/latest/dex/pairs/${chain}`);
    addPairs(data?.pairs || [], 'chain-' + chain);
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`  + Chain pairs: ${allTokens.length} tokens (${((Date.now()-t0)/1000).toFixed(0)}s)`);

  // Save to DEX cache
  const dir = join(HOME, '.tradingview-mcp', 'cache');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const cache = {};
  for (const token of allTokens) cache[token.symbol + ':DEX'] = token;
  writeFileSync(DEX_CACHE, JSON.stringify(cache));

  const chainCounts = {};
  for (const t of allTokens) chainCounts[t.chain] = (chainCounts[t.chain] || 0) + 1;

  console.log(`\nTotal: ${allTokens.length} unique DEX tokens`);
  console.log('By chain:', chainCounts);
  return { total: allTokens.length, chains: chainCounts, elapsed: ((Date.now() - t0) / 1000).toFixed(0) + 's' };
}

// Run as CLI
if (process.argv[1]?.includes('dex_full_scanner')) {
  fullDexScan().then(r => console.log('Done:', r)).catch(e => console.error('Error:', e.message));
}
