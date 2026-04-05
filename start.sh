#!/bin/bash
lsof -ti:3000 | xargs kill 2>/dev/null
sleep 1
cd ~/tradingview-mcp-jackson
nohup node src/dashboard/server.js >> logs/dashboard.log 2>> logs/dashboard.err &
echo "Dashboard started (PID: $!)"
echo "Local: http://localhost:3000"
