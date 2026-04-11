const Database = require('better-sqlite3');
const fs = require('fs');
const DB = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
DB.pragma('journal_mode = WAL');

let HELIUS_KEY = '';
try { const env = fs.readFileSync(process.env.HOME + '/.tradingview-mcp/.env', 'utf8'); HELIUS_KEY = (env.match(/HELIUS_API_KEY=(.+)/)?.[1] || '').trim(); } catch {}
if (!HELIUS_KEY) { console.log('HELIUS_API_KEY not set'); process.exit(0); }

const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
const upsertMeta = DB.prepare("INSERT OR REPLACE INTO token_metadata (token_address,chain,symbol,total_supply,decimals,pair_created_at,token_age_days,description,is_verified,fetched_at) VALUES (?,'solana',?,?,?,?,?,?,?,CURRENT_TIMESTAMP)");
const insertHolder = DB.prepare("INSERT OR IGNORE INTO holder_snapshots (token_address,chain,snapshot_ts,total_holders,top10_pct,top20_pct,whale_count) VALUES (?,'solana',?,?,?,?,?)");
const insertWhale = DB.prepare("INSERT OR IGNORE INTO whale_trades (tx_hash,token_address,chain,symbol,timestamp,direction,amount_tokens,amount_usd,wallet_address,price_at_trade) VALUES (?,'solana','solana',?,?,?,?,?,?,?)");

async function heliusRPC(method, params) {
  const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15000)
  });
  return r.json();
}

async function heliusAPI(path) {
  const r = await fetch(`https://api.helius.xyz${path}${path.includes('?') ? '&' : '?'}api-key=${HELIUS_KEY}`, { signal: AbortSignal.timeout(15000) });
  return r.json();
}

const tokens = DB.prepare("SELECT DISTINCT r.token_address, r.symbol FROM dex_registry r WHERE r.chain='solana' AND LENGTH(r.token_address)>30 ORDER BY (SELECT MAX(volume_24h) FROM dex_snapshots WHERE token_address=r.token_address AND chain='solana') DESC LIMIT 150").all();

async function processToken(addr, sym) {
  let meta = false, holder = false, whales = 0;

  // 1. getAsset for metadata
  try {
    const res = await heliusRPC('getAsset', { id: addr });
    const a = res?.result;
    if (a) {
      const supply = a.token_info?.supply || 0;
      const dec = a.token_info?.decimals || 0;
      const desc = a.content?.metadata?.description || a.content?.metadata?.name || '';
      const verified = a.creators?.some(c => c.verified) ? 1 : 0;
      upsertMeta.run(addr, sym, supply, dec, 0, 0, desc.slice(0, 500), verified);
      meta = true;
    }
  } catch {}
  await new Promise(r => setTimeout(r, 100));

  // 2. getTokenLargestAccounts for holder concentration
  try {
    const res = await heliusRPC('getTokenLargestAccounts', [addr]);
    const largest = res?.result?.value || [];
    if (largest.length > 0) {
      const supRes = await heliusRPC('getTokenSupply', [addr]);
      const total = parseFloat(supRes?.result?.value?.uiAmount || 0);
      if (total > 0) {
        const t10 = largest.slice(0, 10).reduce((s, h) => s + parseFloat(h.uiAmount || 0), 0);
        const t20 = largest.slice(0, 20).reduce((s, h) => s + parseFloat(h.uiAmount || 0), 0);
        const t10pct = (t10 / total) * 100;
        const t20pct = (t20 / total) * 100;
        const wh = largest.filter(h => parseFloat(h.uiAmount || 0) > total * 0.01).length;
        insertHolder.run(addr, now, null, t10pct, t20pct, wh);
        holder = true;
      }
    }
  } catch {}
  await new Promise(r => setTimeout(r, 100));

  // 3. Enhanced transaction history for whale trades
  try {
    const txns = await heliusAPI(`/v0/addresses/${addr}/transactions?type=SWAP&limit=20`);
    if (Array.isArray(txns)) {
      for (const tx of txns) {
        if (!tx.signature) continue;
        for (const tr of (tx.tokenTransfers || []).filter(t => t.mint === addr)) {
          const amt = Math.abs(tr.tokenAmount || 0);
          if (amt < 1) continue;
          const dir = tr.toUserAccount ? 'buy' : 'sell';
          const wallet = tr.fromUserAccount || tr.toUserAccount || '';
          const ts = tx.timestamp ? new Date(tx.timestamp * 1000).toISOString().replace('T', ' ').slice(0, 19) : now;
          try { insertWhale.run(tx.signature + '_' + addr.slice(0, 8), addr, sym, ts, dir, amt, 0, wallet.slice(0, 44), 0); whales++; } catch {}
        }
      }
    }
  } catch {}
  await new Promise(r => setTimeout(r, 100));

  return { meta, holder, whales };
}

async function main() {
  console.log('Helius on-chain:', tokens.length, 'tokens, key:', HELIUS_KEY.slice(0, 8) + '...');
  let m = 0, h = 0, w = 0;
  for (let i = 0; i < tokens.length; i++) {
    const r = await processToken(tokens[i].token_address, tokens[i].symbol);
    if (r.meta) m++; if (r.holder) h++; w += r.whales;
    if (i % 15 === 0) process.stdout.write(`\r  ${i + 1}/${tokens.length} meta:${m} holders:${h} whales:${w}`);
  }
  console.log(`\nDone: meta:${m} holders:${h} whales:${w}`);
  console.log('DB: meta=' + DB.prepare("SELECT COUNT(*) as n FROM token_metadata").get().n +
    ' holders=' + DB.prepare("SELECT COUNT(*) as n FROM holder_snapshots").get().n +
    ' whales=' + DB.prepare("SELECT COUNT(*) as n FROM whale_trades").get().n);
  DB.close();
}
main().catch(console.error);
