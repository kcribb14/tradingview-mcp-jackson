const Database = require('better-sqlite3');
const db = new Database(process.env.HOME + '/.tradingview-mcp/db/fg.db', { readonly: true });

console.log('═══ MINING SECTOR GAP ANALYSIS ═══\n');
console.log('▸ COVERAGE (Commodity × Stage)\n');
const matrix = db.prepare(`
  SELECT primary_commodity as commodity,
    SUM(CASE WHEN stage = 'Shell' THEN 1 ELSE 0 END) as shell,
    SUM(CASE WHEN stage = 'Explorer' THEN 1 ELSE 0 END) as explorer,
    SUM(CASE WHEN stage = 'Developer' THEN 1 ELSE 0 END) as developer,
    SUM(CASE WHEN stage LIKE 'Producer%' THEN 1 ELSE 0 END) as producer,
    COUNT(*) as total
  FROM mining_companies GROUP BY primary_commodity ORDER BY total DESC
`).all();
console.log('Commodity            Shell  Expl   Dev  Prod  Total');
console.log('-'.repeat(55));
for (const r of matrix) console.log((r.commodity||'?').padEnd(20), String(r.shell).padStart(4), String(r.explorer).padStart(5), String(r.developer).padStart(5), String(r.producer).padStart(5), String(r.total).padStart(6));

console.log('\n▸ GEOGRAPHIC COVERAGE\n');
const geo = db.prepare('SELECT exchange, country, COUNT(*) as n FROM mining_companies GROUP BY exchange, country ORDER BY n DESC').all();
for (const g of geo) console.log('  ' + g.exchange.padEnd(8) + g.country.padEnd(4) + String(g.n).padStart(4) + ' companies');

console.log('\n▸ MINING F&G (where available)\n');
const fear = db.prepare(`
  SELECT mc.primary_commodity, COUNT(*) as n, ROUND(AVG(h.fg_score), 1) as avg_fg
  FROM mining_companies mc
  JOIN fg_history h ON h.ticker = mc.ticker
  WHERE h.date = (SELECT MAX(date) FROM fg_history WHERE ticker = mc.ticker)
  GROUP BY mc.primary_commodity HAVING n >= 2 ORDER BY avg_fg ASC
`).all();
for (const f of fear) {
  const ind = f.avg_fg < -20 ? 'EXTREME FEAR' : f.avg_fg < -10 ? 'FEAR' : f.avg_fg < 0 ? 'mild fear' : 'neutral';
  console.log('  ' + (f.primary_commodity||'?').padEnd(18) + 'avg F&G:' + String(f.avg_fg).padStart(7) + '  (' + f.n + ' co.)  ' + ind);
}
db.close();
