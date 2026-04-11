const Database = require('better-sqlite3');
const DB = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
DB.pragma('journal_mode = WAL');
const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
const today = new Date().toISOString().split('T')[0];

const upsertMeta = DB.prepare("INSERT OR REPLACE INTO token_metadata (token_address,chain,symbol,total_supply,circulating_supply,max_supply,website,twitter,telegram,coingecko_id,description,is_verified,fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,CURRENT_TIMESTAMP)");
const insertSocial = DB.prepare("INSERT OR IGNORE INTO social_snapshots (token_address,chain,snapshot_ts,twitter_followers,telegram_members,discord_members,coingecko_watchlist) VALUES (?,?,?,?,?,?,?)");
const insertListing = DB.prepare("INSERT OR IGNORE INTO exchange_listings (token_address,chain,symbol,exchange,listing_date,listing_type,price_at_listing,volume_24h_at_listing,source) VALUES (?,?,?,?,?,?,?,?,'coingecko')");

async function main() {
  console.log('CoinGecko enrichment (free, 30/min)...');
  let coins = [];
  for (let page = 1; page <= 3; page++) {
    try {
      const r = await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=${page}`, { signal: AbortSignal.timeout(15000) });
      if (r.status === 429) { console.log('  Rate limited, waiting 65s...'); await new Promise(r => setTimeout(r, 65000)); continue; }
      if (r.ok) { const d = await r.json(); if (Array.isArray(d)) coins.push(...d); }
    } catch {}
    await new Promise(r => setTimeout(r, 3000));
  }
  console.log('  Markets:', coins.length);
  if (coins.length === 0) { console.log('  No data (rate limited)'); DB.close(); return; }

  let mc = 0, sc = 0, lc = 0;
  for (let i = 0; i < Math.min(coins.length, 80); i++) {
    try {
      const r = await fetch(`https://api.coingecko.com/api/v3/coins/${coins[i].id}?localization=false&tickers=true&community_data=true&developer_data=false`, { signal: AbortSignal.timeout(15000) });
      if (r.status === 429) { console.log('\n  Rate limited, waiting 65s...'); await new Promise(r2 => setTimeout(r2, 65000)); continue; }
      if (!r.ok) { await new Promise(r2 => setTimeout(r2, 3000)); continue; }
      const d = await r.json();
      if (d.error) continue;
      const sym = (d.symbol || '').toUpperCase();
      const chain = d.asset_platform_id || 'multi';
      const addr = d.platforms ? (Object.values(d.platforms).find(a => a) || coins[i].id) : coins[i].id;

      upsertMeta.run(addr, chain, sym, d.market_data?.total_supply || 0, d.market_data?.circulating_supply || 0, d.market_data?.max_supply || 0, d.links?.homepage?.[0] || '', d.links?.twitter_screen_name ? 'https://twitter.com/' + d.links.twitter_screen_name : '', d.links?.telegram_channel_identifier ? 'https://t.me/' + d.links.telegram_channel_identifier : '', coins[i].id, (d.description?.en || '').slice(0, 500), 1);
      mc++;

      insertSocial.run(addr, chain, now, d.community_data?.twitter_followers || 0, d.community_data?.telegram_channel_user_count || 0, 0, d.watchlist_portfolio_users || 0);
      sc++;

      if (d.tickers) { const seen = new Set(); for (const t of d.tickers) { const ex = t.market?.name || ''; if (!ex || seen.has(ex)) continue; seen.add(ex); insertListing.run(addr, chain, sym, ex, today, 'spot', t.last || 0, t.volume || 0); lc++; } }
      process.stdout.write(`\r  ${i + 1}/80 ${sym.padEnd(6)} meta:${mc} social:${sc} listings:${lc}`);
    } catch {}
    await new Promise(r => setTimeout(r, 3000));
  }
  console.log(`\nDone: meta:${mc} social:${sc} listings:${lc}`);
  DB.close();
}
main().catch(console.error);
