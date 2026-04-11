#!/bin/bash
cd ~/tradingview-mcp-jackson
LOG=~/.tradingview-mcp/logs/daily_etl.log
echo "$(date): Daily ETL starting" >> $LOG
node scripts/etl/prices.cjs >> $LOG 2>&1
node scripts/etl/forex.cjs >> $LOG 2>&1
node scripts/etl/sec.cjs >> $LOG 2>&1
node scripts/etl/dexscreener.cjs >> $LOG 2>&1
node scripts/etl/geckoterminal.cjs >> $LOG 2>&1
node scripts/etl/dex_score.cjs >> $LOG 2>&1
echo "$(date): Daily ETL complete" >> $LOG

# Mining ETLs (additive)
node scripts/etl/asx_mining.cjs >> $LOG 2>&1
node scripts/etl/global_mining.cjs >> $LOG 2>&1
node scripts/etl/commodities.cjs >> $LOG 2>&1

# Intraday (additive)
node scripts/etl/prices_1h.cjs >> $LOG 2>&1
node scripts/etl/prices_4h.cjs >> $LOG 2>&1

# Deep intraday (additive)
node scripts/etl/intraday_binance.cjs >> $LOG 2>&1
[ -n "$ALPACA_API_KEY" ] && node scripts/etl/intraday_alpaca.cjs >> $LOG 2>&1
node scripts/etl/prices_4h.cjs >> $LOG 2>&1

# Analytics layer (additive)
node scripts/etl/analytics.cjs >> $LOG 2>&1

# Cascade lead-lag (additive)
node scripts/etl/lag_correlations.cjs >> $LOG 2>&1
node scripts/etl/cascade_signals.cjs >> $LOG 2>&1

# DEX infrastructure (aggregates + TVL)
node scripts/etl/dex_aggregate.cjs >> $LOG 2>&1
node scripts/etl/defillama.cjs >> $LOG 2>&1

# On-chain enrichment (when APIs available)
node scripts/etl/onchain_solana.cjs >> $LOG 2>&1
node scripts/etl/coingecko_enrich.cjs >> $LOG 2>&1
node scripts/analysis/enrich_pumps.cjs >> $LOG 2>&1
