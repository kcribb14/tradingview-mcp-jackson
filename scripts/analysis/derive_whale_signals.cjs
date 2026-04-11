const Database = require('better-sqlite3');
const db = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
console.log('Deriving whale signals from DexScreener buy/sell imbalance...');

const insertWhale = db.prepare("INSERT OR IGNORE INTO whale_trades (tx_hash,token_address,chain,symbol,timestamp,direction,amount_tokens,amount_usd,wallet_address,price_at_trade) VALUES (?,?,?,?,?,?,0,?,'dexscreener_derived',?)");

const tokens = db.prepare("SELECT DISTINCT r.token_address, r.chain, r.symbol FROM dex_registry r").all();
let derived = 0;
const tx = db.transaction(() => {
  for (const t of tokens) {
    const snaps = db.prepare("SELECT snapshot_ts, txns_buys_1h, txns_sells_1h, volume_1h, price_usd FROM dex_snapshots WHERE token_address=? AND chain=? ORDER BY snapshot_ts DESC LIMIT 24").all(t.token_address, t.chain);
    for (const s of snaps) {
      const b = s.txns_buys_1h || 0, sl = s.txns_sells_1h || 0;
      if (b > 10 && b > sl * 2) {
        const usd = (s.volume_1h || 0) * (b / (b + sl));
        insertWhale.run(`derived_${t.chain}_${t.token_address}_${s.snapshot_ts}`, t.token_address, t.chain, t.symbol, s.snapshot_ts, 'buy', usd, s.price_usd || 0);
        derived++;
      } else if (sl > 10 && sl > b * 2) {
        const usd = (s.volume_1h || 0) * (sl / (b + sl));
        insertWhale.run(`derived_${t.chain}_${t.token_address}_${s.snapshot_ts}`, t.token_address, t.chain, t.symbol, s.snapshot_ts, 'sell', usd, s.price_usd || 0);
        derived++;
      }
    }
  }
});
tx();
console.log('Derived whale signals:', derived);
db.close();
