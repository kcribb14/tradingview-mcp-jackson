const Database = require('better-sqlite3');
const DB = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db');
DB.pragma('journal_mode = WAL');
const insert = DB.prepare('INSERT OR IGNORE INTO defi_tvl (protocol, chain, date, tvl_usd) VALUES (?,?,?,?)');

async function main() {
  console.log('DeFiLlama TVL collection...');
  const protocols = await fetch('https://api.llama.fi/protocols').then(r => r.json()).catch(() => []);
  if (!Array.isArray(protocols)) { console.log('Failed'); return; }
  const top = protocols.sort((a, b) => (b.tvl||0) - (a.tvl||0)).slice(0, 50);
  let count = 0;
  for (let i = 0; i < top.length; i++) {
    try {
      const d = await fetch(`https://api.llama.fi/protocol/${top[i].slug}`).then(r => r.json());
      if (d?.tvl && Array.isArray(d.tvl)) {
        const tx = DB.transaction(() => {
          for (const pt of d.tvl) {
            insert.run(top[i].name, top[i].chain || 'multi', new Date(pt.date * 1000).toISOString().split('T')[0], pt.totalLiquidityUSD || 0);
            count++;
          }
        });
        tx();
      }
    } catch {}
    process.stdout.write(`\r  ${i+1}/${top.length} (${count} points)`);
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`\nTVL: ${count} points, ${top.length} protocols`);
  DB.close();
}
main().catch(console.error);
