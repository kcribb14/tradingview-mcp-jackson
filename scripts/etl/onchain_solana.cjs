// Birdeye Solana on-chain data. Free, no key for public endpoints.
const Database = require('better-sqlite3');
const DB = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
DB.pragma('journal_mode = WAL');
const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
const SOL = 'solana';

const upsertMeta = DB.prepare("INSERT OR REPLACE INTO token_metadata (token_address,chain,symbol,total_supply,circulating_supply,decimals,pair_created_at,token_age_days,website,twitter,telegram,coingecko_id,description,is_verified,fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)");
const insertHolder = DB.prepare("INSERT OR IGNORE INTO holder_snapshots (token_address,chain,snapshot_ts,total_holders,top10_pct,top20_pct,whale_count,new_holders_24h) VALUES (?,?,?,?,?,?,?,?)");
const updateHolder = DB.prepare("UPDATE holder_snapshots SET top10_pct=?, top20_pct=?, whale_count=? WHERE token_address=? AND chain=? AND snapshot_ts=?");
const insertWhale = DB.prepare("INSERT OR IGNORE INTO whale_trades (tx_hash,token_address,chain,symbol,timestamp,direction,amount_tokens,amount_usd,wallet_address,price_at_trade) VALUES (?,?,?,?,?,?,?,?,?,?)");

const tokens = DB.prepare("SELECT DISTINCT r.token_address, r.symbol FROM dex_registry r WHERE r.chain=? ORDER BY (SELECT MAX(volume_24h) FROM dex_snapshots WHERE token_address=r.token_address AND chain=?) DESC LIMIT 200").all(SOL, SOL);

async function collectToken(addr, sym) {
  let meta = false, holder = false, whales = 0;
  try {
    const r = await fetch(`https://public-api.birdeye.so/defi/token_overview?address=${addr}`, { headers: { 'x-chain': SOL, 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
    if (r.ok) {
      const d = (await r.json())?.data;
      if (d) {
        const age = d.createdAt ? Math.floor((Date.now() - d.createdAt) / 86400000) : 0;
        upsertMeta.run(addr, SOL, sym || d.symbol || '', d.supply || 0, d.circulatingSupply || 0, d.decimals || 0, d.createdAt ? Math.floor(d.createdAt / 1000) : 0, age, d.website || '', d.twitter || '', d.telegram || '', d.coingeckoId || '', (d.description || '').slice(0, 500), d.verified ? 1 : 0);
        meta = true;
        if (d.holder) { insertHolder.run(addr, SOL, now, d.holder, null, null, null, null); holder = true; }
      }
    }
  } catch {}
  await new Promise(r => setTimeout(r, 350));

  try {
    const r = await fetch(`https://public-api.birdeye.so/defi/token_holder?address=${addr}&limit=20`, { headers: { 'x-chain': SOL, 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
    if (r.ok) {
      const items = (await r.json())?.data?.items || [];
      if (items.length > 0) {
        const t10 = items.slice(0, 10).reduce((s, h) => s + (h.percentage || 0), 0);
        const t20 = items.slice(0, 20).reduce((s, h) => s + (h.percentage || 0), 0);
        const wh = items.filter(h => (h.uiAmount || 0) * (h.tokenPrice || 0) > 10000).length;
        updateHolder.run(t10, t20, wh, addr, SOL, now);
      }
    }
  } catch {}
  await new Promise(r => setTimeout(r, 350));

  try {
    const r = await fetch(`https://public-api.birdeye.so/defi/txs/token?address=${addr}&tx_type=swap&sort_type=desc&limit=30`, { headers: { 'x-chain': SOL, 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
    if (r.ok) {
      const items = (await r.json())?.data?.items || [];
      for (const tx of items) {
        const usd = Math.abs(tx.volumeUSD || tx.volume || 0);
        if (usd < 1000) continue;
        try { insertWhale.run(tx.txHash || `${addr}_${tx.blockUnixTime}`, addr, SOL, sym, new Date((tx.blockUnixTime || 0) * 1000).toISOString().replace('T', ' ').slice(0, 19), tx.side === 'buy' ? 'buy' : 'sell', Math.abs(tx.from?.uiAmount || 0), usd, tx.owner || '', tx.price || 0); whales++; } catch {}
      }
    }
  } catch {}
  await new Promise(r => setTimeout(r, 350));
  return { meta, holder, whales };
}

async function main() {
  console.log('Solana on-chain:', tokens.length, 'tokens');
  let m = 0, h = 0, w = 0;
  for (let i = 0; i < tokens.length; i++) {
    const r = await collectToken(tokens[i].token_address, tokens[i].symbol);
    if (r.meta) m++; if (r.holder) h++; w += r.whales;
    if (i % 20 === 0) process.stdout.write(`\r  ${i + 1}/${tokens.length} meta:${m} holders:${h} whales:${w}`);
  }
  console.log(`\nDone: meta:${m} holders:${h} whale trades:${w}`);
  DB.close();
}
main().catch(console.error);
