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
| Source | Coverage | Cost |
|--------|----------|------|
| Yahoo Finance | Stocks, ETFs, commodities OHLCV | Free |
| Binance | Top crypto OHLCV | Free |
| CryptoCompare | Full crypto history (BTC since 2010) | Free |
| CoinGecko | Crypto fundamentals + market caps | Free |
| DexScreener | DEX tokens (16 chains) | Free |
| HuggingFace | 3.96M global drillholes | Free |
| **SEC EDGAR** | **Filings, insider trades, XBRL financials** | **Free** |
| Finnhub | Metrics, earnings, analyst, news | Free (60/min) |
| Financial Datasets | US OHLCV + earnings backup | Free tier |

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

## Fundamental Data Sources ($0/mo)

All fundamental data uses free APIs. No paid subscriptions needed.

### SEC EDGAR (free, no key required)
- 10-K/10-Q/8-K filings with direct links
- Form 4 insider trades (smart money signal)
- XBRL financials: revenue, net income, assets, equity, D/E ratio, EPS
- Coverage: all US public companies

### Finnhub (optional, free tier — 60 req/min, no card)
- P/E, P/B, ROE, margins, revenue growth
- Earnings surprises (beat/miss history)
- Analyst recommendations + price targets
- Company news
- Get key: https://finnhub.io/register
- Add to `~/.zshrc`: `export FINNHUB_API_KEY="your_key"`

### Financial Datasets (optional fallback — free tier)
- US stock OHLCV when Yahoo rate-limits
- Earnings data backup
- Get key: https://financialdatasets.ai
- Add to `~/.zshrc`: `export FINANCIAL_DATASETS_API_KEY="your_key"`
