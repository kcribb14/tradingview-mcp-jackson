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
