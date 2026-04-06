#!/bin/bash
cd /Users/kierancribb/tradingview-mcp-jackson
echo "$(date): Starting hourly fill..."
curl -sf localhost:3000/api/health > /dev/null 2>&1 || { echo "Server not running"; exit 1; }
timeout 3000 node scripts/slow_fill.mjs 2>&1 || true
SYMS=$(curl -sf localhost:3000/api/health | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).symbols))" 2>/dev/null)
echo "$(date): Done. Symbols: $SYMS"
