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
