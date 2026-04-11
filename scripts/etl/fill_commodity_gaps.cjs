const Database = require('better-sqlite3');
const db = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
db.pragma('journal_mode = WAL');

const proxies = [
  { commodity: 'Lithium', ticker: 'LIT' },
  { commodity: 'Nickel', ticker: 'JJN' },
  { commodity: 'Zinc', ticker: 'ZINC' },
  { commodity: 'Rare Earths', ticker: 'REMX' },
  { commodity: 'Cobalt', ticker: 'LIT' },  // correlated proxy
  { commodity: 'Tin', ticker: 'JJM' },
  { commodity: 'Manganese', ticker: 'PICK' },
  { commodity: 'Graphite', ticker: 'LIT' },
  { commodity: 'Iron Ore', ticker: 'VALE' }, // iron ore via Vale
  { commodity: 'Coal', ticker: 'BTU' },     // coal via Peabody
  { commodity: 'Aluminium', ticker: 'AA' },
  { commodity: 'PGMs', ticker: 'PPLT' },    // platinum group via ETF
  { commodity: 'Mineral Sands', ticker: 'ILU.AX' },
  { commodity: 'Steel', ticker: 'SLX' },
  { commodity: 'Potash', ticker: 'MOS' },
  { commodity: 'Potash/Phosphate', ticker: 'MOS' },
  { commodity: 'Oil & Gas', ticker: 'CL=F' },
  { commodity: 'Diamonds', ticker: 'TLRY' }, // no good proxy, skip if fails
  { commodity: 'Vanadium', ticker: 'REMX' },
  { commodity: 'Hydrogen', ticker: 'FCEL' },
  // New from overnight audit — missing commodities
  { commodity: 'Antimony', ticker: 'REMX' },
  { commodity: 'Tungsten', ticker: 'REMX' },
  { commodity: 'Diversified', ticker: 'PICK' },
  { commodity: 'Helium', ticker: 'NG=F' },
  { commodity: 'Royalties', ticker: 'GOAU' },
  { commodity: 'Royalty', ticker: 'GOAU' },
  { commodity: 'Gold (Royalty)', ticker: 'FNV' },
  { commodity: 'Silver (Streaming)', ticker: 'WPM' },
  { commodity: 'Streaming', ticker: 'WPM' },
  { commodity: 'Zinc', ticker: 'JJM' },  // fallback if ZINC fails
];

const insert = db.prepare("INSERT OR IGNORE INTO commodity_prices (commodity, date, price_usd, unit, source) VALUES (?, ?, ?, 'proxy', ?)");

async function fetchYahoo(ticker) {
  const now = Math.floor(Date.now() / 1000);
  const start = Math.floor(new Date('2014-01-01').getTime() / 1000);
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${start}&period2=${now}&interval=1d`, {
    headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) return [];
  const d = await r.json();
  const result = d?.chart?.result?.[0];
  if (!result?.timestamp) return [];
  const closes = result.indicators.quote[0].close || [];
  return result.timestamp.map((t, i) => closes[i] > 0 ? { date: new Date(t * 1000).toISOString().split('T')[0], price: closes[i] } : null).filter(Boolean);
}

async function main() {
  console.log('Filling commodity price gaps...\n');
  for (const p of proxies) {
    const existing = db.prepare("SELECT COUNT(*) as n FROM commodity_prices WHERE commodity = ?").get(p.commodity);
    if (existing.n > 500) { console.log('  Skip ' + p.commodity + ' (' + existing.n + ' bars)'); continue; }

    const bars = await fetchYahoo(p.ticker);
    if (bars.length > 0) {
      const tx = db.transaction(() => { for (const b of bars) insert.run(p.commodity, b.date, b.price, 'yahoo_' + p.ticker); });
      tx();
      console.log('  ' + p.commodity.padEnd(18) + '+' + bars.length + ' bars via ' + p.ticker);
    } else {
      console.log('  ' + p.commodity.padEnd(18) + 'FAILED (' + p.ticker + ')');
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log('\nAll commodities:');
  db.prepare("SELECT commodity, COUNT(*) as n, MIN(date) as oldest, MAX(date) as newest FROM commodity_prices GROUP BY commodity ORDER BY commodity").all()
    .forEach(c => console.log('  ' + c.commodity.padEnd(18) + c.n + ' bars  ' + c.oldest + ' -> ' + c.newest));
  db.close();
}
main().catch(console.error);
