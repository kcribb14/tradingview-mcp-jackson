# F&G Scanner — Fear & Greed Investment Intelligence

Scans 11,500+ instruments across US stocks, ASX, crypto (CEX+DEX), commodities, ETFs, and international exchanges using the DGT Fear & Greed Index. Identifies buy opportunities when assets enter extreme fear with strong fundamentals.

## Quick Start
```bash
npm run dashboard        # Start on localhost:3000
./start.sh               # Alternative start script
```

## Dashboard Tabs
- **Signals** (default): Grade A/B/C ranked signals, daily briefing, unreacted drill results
- **Scanner**: Scatter heatmap + table. Drag-select to compare. Category bands + histogram.
- **Watchlist**: F&G overlay, price %, split view. Date range 1W-ALL. Correlation insights.
- **Cycle**: 6-stage business cycle, macro barometers, mining rotation, breadth bars.
- **Trending**: Gainers, losers, whale activity, DEX hot tokens.

## Data Sources
| Source | Coverage | History |
|--------|----------|---------|
| Yahoo Finance | Stocks, ETFs, commodities | max (10yr daily) |
| Binance | Top crypto | 1000 bars (~2.7yr) |
| CryptoCompare | Full crypto history | BTC since 2010 (15yr) |
| CoinGecko | Crypto fundamentals | ATH, sentiment, dev activity |
| DexScreener | DEX tokens (16 chains) | Real-time |
| HuggingFace | 3.96M global drillholes | Geological |

## Signal Scoring (0-100)
F&G Depth + Smart Money + ATH Distance + Cycle Position + Momentum + Historical WR + Fundamental Gap + Geological

## Auto-Start
```bash
launchctl load ~/Library/LaunchAgents/com.fg-scanner.dashboard.plist
```

## Phone Access
```
http://192.168.1.65:3000
```
Push notifications: subscribe to `kieran-fg-signals` on ntfy app.

## Key Paths
- `src/dashboard/server.js` — Express server
- `src/dashboard/index.html` — Dashboard SPA
- `src/core/fg_cache.js` — DGT F&G calculator
- `~/.tradingview-mcp/cache/fg_scores.json` — Score cache
- `~/.tradingview-mcp/canetoad/signals.json` — Geological signals
- `~/.tradingview-mcp/history/` — Daily snapshots
- `~/.tradingview-mcp/tracking/` — Forward signal tracking
- `~/.tradingview-mcp/logs/heartbeat.log` — Server health
