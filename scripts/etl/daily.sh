#!/bin/bash
# Daily ETL pipeline — all 13 steps with error handling
# Each step logs failure but doesn't block the next
cd ~/tradingview-mcp-jackson
LOG=~/.tradingview-mcp/logs/daily_etl.log
mkdir -p ~/.tradingview-mcp/logs
echo "" >> $LOG
echo "═══════════════════════════════════════" >> $LOG
echo "$(date): Daily ETL starting" >> $LOG
echo "═══════════════════════════════════════" >> $LOG

# Load env vars
set -a; source ~/.tradingview-mcp/.env 2>/dev/null; set +a

# ── Step 1: Core price data ──
echo "$(date): [1/13] Price data refresh" >> $LOG
node scripts/etl/prices.cjs >> $LOG 2>&1 || echo "STEP 1 FAILED: prices" >> $LOG
node scripts/etl/forex.cjs >> $LOG 2>&1 || echo "STEP 1 FAILED: forex" >> $LOG
node scripts/etl/sec.cjs >> $LOG 2>&1 || echo "STEP 1 FAILED: sec" >> $LOG

# ── Step 2: DEX snapshot collection ──
echo "$(date): [2/13] DEX snapshots" >> $LOG
node scripts/etl/dexscreener.cjs >> $LOG 2>&1 || echo "STEP 2 FAILED: dexscreener" >> $LOG
node scripts/etl/geckoterminal.cjs >> $LOG 2>&1 || echo "STEP 2 FAILED: geckoterminal" >> $LOG
node scripts/etl/dex_score.cjs >> $LOG 2>&1 || echo "STEP 2 FAILED: dex_score" >> $LOG

# ── Step 3: DeFiLlama TVL ──
echo "$(date): [3/13] DeFiLlama TVL" >> $LOG
node scripts/etl/defillama.cjs >> $LOG 2>&1 || echo "STEP 3 FAILED: defillama" >> $LOG

# ── Step 4: On-chain enrichment ──
echo "$(date): [4/13] On-chain enrichment" >> $LOG
[ -n "$HELIUS_API_KEY" ] && node scripts/etl/onchain_helius.cjs >> $LOG 2>&1 || echo "STEP 4 SKIPPED: no Helius key" >> $LOG
node scripts/etl/onchain_solana.cjs >> $LOG 2>&1 || echo "STEP 4 PARTIAL: onchain_solana" >> $LOG

# ── Step 5: CoinGecko enrichment ──
echo "$(date): [5/13] CoinGecko" >> $LOG
node scripts/etl/coingecko_enrich.cjs >> $LOG 2>&1 || echo "STEP 5 FAILED: coingecko" >> $LOG

# ── Step 6: Mining + commodity data ──
echo "$(date): [6/13] Mining + commodities" >> $LOG
node scripts/etl/asx_mining.cjs >> $LOG 2>&1 || echo "STEP 6 FAILED: asx_mining" >> $LOG
node scripts/etl/global_mining.cjs >> $LOG 2>&1 || echo "STEP 6 FAILED: global_mining" >> $LOG
node scripts/etl/commodities.cjs >> $LOG 2>&1 || echo "STEP 6 FAILED: commodities" >> $LOG
node scripts/etl/fill_commodity_gaps.cjs >> $LOG 2>&1 || echo "STEP 6 FAILED: commodity_gaps" >> $LOG

# ── Step 7: Intraday data ──
echo "$(date): [7/13] Intraday" >> $LOG
node scripts/etl/prices_1h.cjs >> $LOG 2>&1 || echo "STEP 7 FAILED: prices_1h" >> $LOG
node scripts/etl/prices_4h.cjs >> $LOG 2>&1 || echo "STEP 7 FAILED: prices_4h" >> $LOG
node scripts/etl/intraday_binance.cjs >> $LOG 2>&1 || echo "STEP 7 FAILED: binance" >> $LOG
[ -n "$ALPACA_API_KEY" ] && node scripts/etl/intraday_alpaca.cjs >> $LOG 2>&1

# ── Step 8: Derived whale signals ──
echo "$(date): [8/13] Whale signals" >> $LOG
node scripts/analysis/derive_whale_signals.cjs >> $LOG 2>&1 || echo "STEP 8 FAILED: whale_signals" >> $LOG

# ── Step 9: F&G for new tickers ──
echo "$(date): [9/13] F&G gap fill" >> $LOG
node scripts/etl/fill_fg_scores.cjs >> $LOG 2>&1 || echo "STEP 9 FAILED: fg_scores" >> $LOG

# ── Step 10: Mining performance rebuild ──
echo "$(date): [10/13] Mining performance" >> $LOG
NODE_OPTIONS='--max-old-space-size=1536' node scripts/etl/rebuild_mining_performance.cjs >> $LOG 2>&1 || echo "STEP 10 FAILED: mining_performance" >> $LOG

# ── Step 11: Pump event enrichment ──
echo "$(date): [11/13] Pump enrichment" >> $LOG
node scripts/analysis/enrich_pumps.cjs >> $LOG 2>&1 || echo "STEP 11 FAILED: enrich_pumps" >> $LOG
node scripts/analysis/enrich_pump_commodities.cjs >> $LOG 2>&1 || echo "STEP 11 FAILED: pump_commodities" >> $LOG

# ── Step 12: Full mining scanner ──
echo "$(date): [12/13] Mining archetype scanner" >> $LOG
NODE_OPTIONS='--max-old-space-size=1536' node scripts/analysis/full_mining_scanner.cjs >> $LOG 2>&1 || echo "STEP 12 FAILED: scanner" >> $LOG

# ── Step 13: Analytics + cascade ──
echo "$(date): [13/13] Analytics + cascade" >> $LOG
node scripts/etl/analytics.cjs >> $LOG 2>&1 || echo "STEP 13 FAILED: analytics" >> $LOG
node scripts/etl/lag_correlations.cjs >> $LOG 2>&1 || echo "STEP 13 FAILED: lag" >> $LOG
node scripts/etl/cascade_signals.cjs >> $LOG 2>&1 || echo "STEP 13 FAILED: cascade" >> $LOG
node scripts/etl/dex_aggregate.cjs >> $LOG 2>&1 || echo "STEP 13 FAILED: dex_aggregate" >> $LOG

echo "$(date): Daily ETL complete" >> $LOG
echo "═══════════════════════════════════════" >> $LOG

# Check for failures
FAILURES=$(grep -c "FAILED" $LOG 2>/dev/null || echo 0)
if [ "$FAILURES" -gt 0 ]; then
  echo "$(date): $FAILURES steps had failures — check log" >> $LOG
fi
