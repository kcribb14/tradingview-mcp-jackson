# Unified Data Sources — Specification & Test Results

Tested 2026-04-04 with live API calls against all sources.

## Full Coverage Matrix

### Crypto Sources

| Source | Pairs/Coins | Free OHLCV 200d | Speed | Small-cap | Auth | Rate Limit |
|--------|------------|-----------------|-------|-----------|------|------------|
| **Binance** | 439 USDT | YES | 326ms | Medium | No | 1200/min |
| **Bybit** | 635 | YES | 173ms | Medium | No | 120/min |
| **MEXC** | 2388 | YES | 278ms | Highest CEX | No | 500/min |
| **Gate.io** | 2311 | YES | 683ms | High | No | 900/min |
| **KuCoin** | 1127 | YES | ~400ms | High | No | 100/min |
| **CryptoCompare** | 5000+ | YES (201 bars) | 311ms | Very High | No | 100K/mo |
| **Yahoo Finance** | ~500 crypto | YES (366 bars) | 338ms | Low crypto | No | ~2000/hr |
| CoinGecko | 17870 listed | NO (4-day bars only) | ~500ms | Discovery only | No | 10-30/min |
| DexScreener | DEX-only | NO (5m/1h/6h/24h only) | ~200ms | DEX-only | No | ~300/min |

### Stock Sources

| Source | US Stocks | ASX Stocks | OHLCV 200d | Speed | Auth | Rate Limit |
|--------|-----------|------------|------------|-------|------|------------|
| **Yahoo Finance** | ~8000 | ~2200 | YES | **18ms/sym** | No | ~2000/hr |
| Alpha Vantage | ~8000 | ~2200 | YES | ~500ms | API Key | 5/min free |
| Twelve Data | NYSE 3077, NASDAQ 4479 | ASX 2020 | YES | ~300ms | API Key | 8/min free |
| Stooq | Some US | Some AU | Blocked | N/A | No | Unknown |
| EODHD | ~8000 | ~2200 | YES | ~400ms | API Key | 20/day free |
| TradingView screener | ~7700 US | ~2200 ASX | Summary only | 2s/100 | N/A | N/A |

## Optimal Source Stack (implemented)

```
Symbol type detection → auto-route to best source:

  US Stocks (AAPL, SPY, etc.)     → Yahoo Finance (18ms, no auth, 100% coverage)
  ASX Stocks (BHP.AX, NST.AX)    → Yahoo Finance (21ms, .AX suffix, 91%+ coverage)
  Crypto (BTC, SOL, BONK)        → Binance → CryptoCompare → Yahoo → MEXC waterfall
  Forex, Commodities              → Yahoo Finance
```

## Live Test Results

### US Stocks (Stake.com Universe)
- **119/120 scored in 1.9 seconds**
- Distribution: 8 Extreme Fear, 48 Fear, 59 Neutral, 4 Greed
- Source: 100% Yahoo Finance
- Coverage: 99%

### ASX Stocks (CommSec Universe)
- **91/100 scored in 1.9 seconds**
- Distribution: 18 Extreme Fear, 32 Fear, 39 Neutral, 2 Greed
- Source: 100% Yahoo Finance
- Coverage: 91%
- ASX market is more fearful than US (55% in Fear/Extreme Fear vs 47% US)

### ASX Mining / CANETOAD Targets
- **30/30 miners scored in 0.9 seconds** (100% coverage)
- Top Fear: LOT.AX (-29.3), CMM.AX (-29.0), DEV.AX (-26.3)
- Neutral: BHP.AX (-1.8), PLS.AX (0.0), RIO.AX (+4.4)
- Greed: WDS.AX (+10.4)

### Crypto (Universe Scan)
- **195/229 scored in 13.8 seconds** (85% coverage)
- Sources: Binance 121, Yahoo 56, CryptoCompare 18
- Distribution: 54 Extreme Fear, 97 Fear, 42 Neutral, 2 Greed

## Total Coverage

| Market | Instruments | Time | Coverage |
|--------|-------------|------|----------|
| US Stocks | 119 | 1.9s | 99% |
| ASX Stocks | 91 | 1.9s | 91% |
| Crypto (top 250) | 195 | 13.8s | 85% |
| **TOTAL** | **405** | **~18s** | **92%** |

### Theoretical Maximum
- US Stocks: ~8000 via Yahoo Finance
- ASX Stocks: ~2020 via Yahoo Finance
- Crypto: ~2000 with reliable OHLCV data
- **Combined: ~12,000 unique instruments scoreable**

## Symbol Format Detection

| Input | Detected As | Source | Yahoo Ticker |
|-------|-------------|--------|--------------|
| `AAPL` | US Stock | Yahoo | AAPL |
| `BRK-B` | US Stock | Yahoo | BRK-B |
| `SPY` | US Stock | Yahoo | SPY |
| `BHP.AX` | ASX Stock | Yahoo | BHP.AX |
| `ASX:BHP` | ASX Stock | Yahoo | BHP.AX |
| `NST.AX` | ASX Stock | Yahoo | NST.AX |
| `BTC` | Crypto | Binance | BTCUSDT |
| `SOL` | Crypto | Binance | SOLUSDT |
| `BTC-USD` | Crypto | Yahoo | BTC-USD |
| `BONK` | Crypto | Binance | BONKUSDT |
