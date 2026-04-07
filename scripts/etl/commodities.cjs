const Database = require('better-sqlite3');
const DB = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
DB.pragma('journal_mode = WAL');

const insert = DB.prepare(`INSERT OR IGNORE INTO commodity_prices (commodity, date, price_usd, unit, source) VALUES (?, ?, ?, ?, 'yahoo')`);

const COMMODITIES = {
  'Gold': { ticker: 'GC=F', unit: 'USD/oz' },
  'Silver': { ticker: 'SI=F', unit: 'USD/oz' },
  'Copper': { ticker: 'HG=F', unit: 'USD/lb' },
  'Platinum': { ticker: 'PL=F', unit: 'USD/oz' },
  'Palladium': { ticker: 'PA=F', unit: 'USD/oz' },
  'Crude Oil': { ticker: 'CL=F', unit: 'USD/bbl' },
  'Nat Gas': { ticker: 'NG=F', unit: 'USD/MMBtu' },
  'Uranium': { ticker: 'URA', unit: 'ETF proxy' }
};

async function fetchOne(name, ticker, unit) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=946684800&period2=${Math.floor(Date.now() / 1000)}&interval=1d`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return 0;
    const d = await r.json();
    const result = d?.chart?.result?.[0];
    if (!result?.timestamp) return 0;
    const closes = result.indicators?.quote?.[0]?.close || [];
    let count = 0;
    const tx = DB.transaction(() => {
      for (let i = 0; i < result.timestamp.length; i++) {
        if (closes[i] > 0) {
          insert.run(name, new Date(result.timestamp[i] * 1000).toISOString().split('T')[0], closes[i], unit);
          count++;
        }
      }
    });
    tx();
    return count;
  } catch { return 0; }
}

async function main() {
  console.log('Commodity prices ETL (additive)...');
  for (const [name, info] of Object.entries(COMMODITIES)) {
    const n = await fetchOne(name, info.ticker, info.unit);
    console.log('  ' + name.padEnd(12) + '+' + n + ' bars');
    await new Promise(r => setTimeout(r, 500));
  }
  const stats = DB.prepare('SELECT COUNT(*) as n, COUNT(DISTINCT commodity) as c FROM commodity_prices').get();
  console.log('Total:', stats.n, 'prices across', stats.c, 'commodities');
  DB.close();
}
main().catch(console.error);
