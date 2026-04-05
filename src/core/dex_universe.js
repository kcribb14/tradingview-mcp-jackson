/**
 * DexScreener Universe — mass token fetching, add-by-URL, auto-discovery.
 *
 * Fetches thousands of tokens across Solana, Ethereum, Base, Arbitrum, BSC.
 * Calculates DEX F&G from on-chain data (priceChange, volume, buys/sells).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const HOME = process.env.HOME || process.env.USERPROFILE || '/tmp';
const WATCHLIST_DIR = join(HOME, '.tradingview-mcp', 'watchlist');
const WATCHLIST_FILE = join(WATCHLIST_DIR, 'custom_tokens.json');
const DEX_CACHE_FILE = join(HOME, '.tradingview-mcp', 'cache', 'dex_tokens.json');

function ensureDir(dir) { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); }

async function dexFetch(path) {
  const r = await fetch(`https://api.dexscreener.com${path}`, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) return null;
  return r.json();
}

// ─── DEX F&G from pair data ─────────────────────────────────────────────────

function dexFG(pair) {
  if (!pair) return null;
  const pc = pair.priceChange || {};
  const vol = pair.volume || {};
  const txns = pair.txns || {};
  const liq = pair.liquidity?.usd || 0;
  const fdv = pair.fdv || 0;

  const change24h = pc.h24 ?? 0;
  const change1h = pc.h1 ?? 0;
  const change6h = pc.h6 ?? 0;

  // pmacd proxy: 24h price change
  const pmacd = change24h * 0.4;
  // Momentum: 1h vs 6h alignment
  const momentum = change1h * 0.3 + (change6h - change24h) * 0.05;
  // Volume flow
  const vol1h = vol.h1 || 0, vol6h = vol.h6 || 1;
  const direction = change1h > 0 ? 1 : change1h < 0 ? -1 : 0;
  const volTrend = vol6h > 0 ? (vol1h * 6 / vol6h - 1) : 0;
  const volumeFlow = direction * Math.min(3, Math.abs(volTrend)) * 5;
  // Order flow: buy/sell ratio
  const buys24 = txns.h24?.buys || 0, sells24 = txns.h24?.sells || 0;
  const totalTxns = buys24 + sells24;
  const orderFlow = totalTxns > 10 ? (buys24 / totalTxns - 0.5) * 40 : 0;
  // Age risk
  let ageRisk = 0;
  if (pair.pairCreatedAt) {
    const ageH = (Date.now() - pair.pairCreatedAt) / 3600000;
    if (ageH < 1) ageRisk = -10; else if (ageH < 24) ageRisk = -5; else if (ageH < 168) ageRisk = -2;
  }

  // Clamp components to prevent tokens with +1000% moves from blowing up the score
  const cPmacd = Math.max(-60, Math.min(60, pmacd));
  const cMomentum = Math.max(-40, Math.min(40, momentum));
  const cVolFlow = Math.max(-30, Math.min(30, volumeFlow));
  const cOrderFlow = Math.max(-20, Math.min(20, orderFlow));

  const raw = (cPmacd + cMomentum + cVolFlow + cOrderFlow + ageRisk) / 5;
  // Final clamp to DGT range [-80, +100]
  const score = Math.max(-80, Math.min(100, Math.round(raw * 100) / 100));

  return {
    fg: score,
    zone: score >= 73 ? 'Euphoria' : score >= 41 ? 'Thrill' : score >= 10 ? 'Excitement' : score >= 5 ? 'Optimism' :
      score >= -5 ? 'Balanced' : score >= -10 ? 'Anxiety' : score >= -25 ? 'Fear' : score >= -41 ? 'Panic' : 'Despondency',
    components: { pmacd: Math.round(pmacd*100)/100, momentum: Math.round(momentum*100)/100, volumeFlow: Math.round(volumeFlow*100)/100, orderFlow: Math.round(orderFlow*100)/100, ageRisk },
  };
}

// ─── Parse DexScreener URL ──────────────────────────────────────────────────

function parseDexURL(input) {
  input = input.trim();
  // URL format: https://dexscreener.com/solana/ADDRESS
  const urlMatch = input.match(/dexscreener\.com\/(\w+)\/([a-zA-Z0-9]+)/);
  if (urlMatch) return { chain: urlMatch[1], address: urlMatch[2] };
  // Raw address
  if (input.startsWith('0x')) return { chain: null, address: input }; // EVM
  if (input.length > 30 && !input.includes('.')) return { chain: 'solana', address: input }; // Solana
  return null;
}

// ─── Add token by URL/address ───────────────────────────────────────────────

export async function addToken(input) {
  const parsed = parseDexURL(input);
  if (!parsed) return { error: 'Invalid URL or address' };

  // Try to fetch the pair
  const chains = parsed.chain ? [parsed.chain] : ['solana', 'ethereum', 'base', 'arbitrum', 'bsc'];
  let pair = null;

  for (const chain of chains) {
    const data = await dexFetch(`/latest/dex/pairs/${chain}/${parsed.address}`);
    const pairs = data?.pairs || (data?.pair ? [data.pair] : []);
    if (pairs.length > 0) { pair = pairs[0]; break; }
  }

  // If pair not found via pairs endpoint, try token search
  if (!pair) {
    const data = await dexFetch(`/latest/dex/tokens/${parsed.address}`);
    const pairs = data?.pairs || [];
    if (pairs.length > 0) {
      pairs.sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));
      pair = pairs[0];
    }
  }

  if (!pair) return { error: 'Token not found on DexScreener' };

  const fg = dexFG(pair);
  const token = {
    symbol: pair.baseToken?.symbol || '???',
    name: pair.baseToken?.name || '',
    address: pair.baseToken?.address || parsed.address,
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
    components: fg?.components,
    source: 'dexscreener',
    url: pair.url || `https://dexscreener.com/${pair.chainId}/${parsed.address}`,
    addedAt: new Date().toISOString(),
  };

  // Save to custom watchlist
  saveToWatchlist(token);

  // Also save to DEX cache
  saveToDexCache(token);

  return { success: true, token };
}

function saveToWatchlist(token) {
  ensureDir(WATCHLIST_DIR);
  let list = [];
  try { list = JSON.parse(readFileSync(WATCHLIST_FILE, 'utf8')); } catch {}
  // Deduplicate
  list = list.filter(t => t.address !== token.address);
  list.push(token);
  writeFileSync(WATCHLIST_FILE, JSON.stringify(list, null, 2));
}

function saveToDexCache(token) {
  ensureDir(join(HOME, '.tradingview-mcp', 'cache'));
  let cache = {};
  try { cache = JSON.parse(readFileSync(DEX_CACHE_FILE, 'utf8')); } catch {}
  cache[token.symbol + ':DEX'] = token;
  writeFileSync(DEX_CACHE_FILE, JSON.stringify(cache));
}

// ─── Mass fetch: search many terms to discover tokens ───────────────────────

export async function discoverTokens() {
  const queries = [
    // Popular categories
    'SOL', 'PEPE', 'BONK', 'WIF', 'TRUMP', 'AI', 'meme', 'dog', 'cat',
    'pump', 'moon', 'doge', 'shib', 'ape', 'baby', 'elon', 'grok',
    // Top chains
    'ETH', 'BNB', 'AVAX', 'MATIC', 'ARB', 'OP', 'BASE',
    // DeFi
    'swap', 'lend', 'stake', 'yield', 'farm', 'vault',
    // Narrative
    'RWA', 'depin', 'gaming', 'metaverse', 'NFT', 'layer',
  ];

  const seen = new Set();
  const allTokens = [];

  // Also get boosted and profile tokens
  const [boosted, profiles] = await Promise.all([
    dexFetch('/token-boosts/latest/v1'),
    dexFetch('/token-profiles/latest/v1'),
  ]);

  // Boosted tokens — fetch their pairs
  if (Array.isArray(boosted)) {
    for (const b of boosted.slice(0, 20)) {
      if (b.tokenAddress && !seen.has(b.tokenAddress)) {
        seen.add(b.tokenAddress);
        const data = await dexFetch(`/latest/dex/tokens/${b.tokenAddress}`);
        const pairs = data?.pairs || [];
        if (pairs.length > 0) {
          pairs.sort((a2, b2) => (b2.volume?.h24 || 0) - (a2.volume?.h24 || 0));
          const fg = dexFG(pairs[0]);
          allTokens.push(buildToken(pairs[0], fg, 'boosted'));
        }
      }
    }
  }

  // Search-based discovery
  for (let i = 0; i < queries.length; i += 5) {
    const batch = queries.slice(i, i + 5);
    const results = await Promise.all(batch.map(q => dexFetch(`/latest/dex/search?q=${encodeURIComponent(q)}`)));

    for (const data of results) {
      const pairs = data?.pairs || [];
      for (const pair of pairs) {
        const addr = pair.baseToken?.address;
        if (!addr || seen.has(addr)) continue;
        if ((pair.volume?.h24 || 0) < 1000) continue; // Min $1K volume
        if ((pair.liquidity?.usd || 0) < 500) continue; // Min $500 liquidity
        seen.add(addr);
        const fg = dexFG(pair);
        allTokens.push(buildToken(pair, fg, 'search'));
      }
    }
    if (i + 5 < queries.length) await new Promise(r => setTimeout(r, 200)); // Rate limit
  }

  // Save all to DEX cache
  ensureDir(join(HOME, '.tradingview-mcp', 'cache'));
  const cache = {};
  for (const token of allTokens) {
    cache[token.symbol + ':DEX'] = token;
  }
  writeFileSync(DEX_CACHE_FILE, JSON.stringify(cache));

  return {
    success: true,
    discovered: allTokens.length,
    chains: countBy(allTokens, 'chain'),
    byVolume: { above1M: allTokens.filter(t => t.volume24h > 1e6).length, above100K: allTokens.filter(t => t.volume24h > 1e5).length },
  };
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
  };
}

function countBy(arr, key) {
  const counts = {};
  for (const item of arr) { counts[item[key]] = (counts[item[key]] || 0) + 1; }
  return counts;
}

// ─── Refresh scores for cached DEX tokens ───────────────────────────────────

export async function refreshDexScores() {
  ensureDir(join(HOME, '.tradingview-mcp', 'cache'));
  let cache = {};
  try { cache = JSON.parse(readFileSync(DEX_CACHE_FILE, 'utf8')); } catch {}

  const entries = Object.entries(cache);
  if (entries.length === 0) return { success: true, refreshed: 0, total: 0 };

  let refreshed = 0, failed = 0;

  // Process in batches of 5
  for (let i = 0; i < entries.length; i += 5) {
    const batch = entries.slice(i, i + 5);
    const results = await Promise.all(batch.map(async ([key, token]) => {
      try {
        const addr = token.address;
        if (!addr) return null;
        const data = await dexFetch(`/latest/dex/tokens/${addr}`);
        const pairs = data?.pairs || [];
        if (pairs.length === 0) return null;
        pairs.sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));
        const pair = pairs[0];
        const fg = dexFG(pair);
        return {
          key,
          update: {
            ...token,
            price: parseFloat(pair.priceUsd || 0),
            mcap: pair.marketCap || pair.fdv || 0,
            volume24h: pair.volume?.h24 || 0,
            liquidity: pair.liquidity?.usd || 0,
            buys24h: pair.txns?.h24?.buys || 0,
            sells24h: pair.txns?.h24?.sells || 0,
            priceChange: pair.priceChange || {},
            fg: fg?.fg ?? 0,
            zone: fg?.zone ?? 'Balanced',
            components: fg?.components,
            refreshedAt: new Date().toISOString(),
          },
        };
      } catch { return null; }
    }));

    for (const r of results) {
      if (r) { cache[r.key] = r.update; refreshed++; }
      else { failed++; }
    }

    // Rate limit: 1.5s between batches
    if (i + 5 < entries.length) await new Promise(r => setTimeout(r, 1500));
  }

  writeFileSync(DEX_CACHE_FILE, JSON.stringify(cache));
  return { success: true, refreshed, failed, total: entries.length };
}

// ─── Load DEX tokens for dashboard ──────────────────────────────────────────

export function loadDexTokens() {
  const tokens = [];

  // Load DEX cache
  try {
    const cache = JSON.parse(readFileSync(DEX_CACHE_FILE, 'utf8'));
    for (const token of Object.values(cache)) {
      if (token.symbol && token.fg != null) tokens.push(token);
    }
  } catch {}

  // Load custom watchlist
  try {
    const watchlist = JSON.parse(readFileSync(WATCHLIST_FILE, 'utf8'));
    for (const token of watchlist) {
      if (!tokens.find(t => t.address === token.address)) tokens.push(token);
    }
  } catch {}

  return tokens;
}

export function loadWatchlist() {
  try { return JSON.parse(readFileSync(WATCHLIST_FILE, 'utf8')); }
  catch { return []; }
}
