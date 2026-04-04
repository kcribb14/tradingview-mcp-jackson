# Unified Crypto Data Sources — Specification & Test Results

Tested 2026-04-04 with live API calls against all sources.

## Coverage Matrix (tested live)

| Source | Total Pairs | Free OHLCV 200d | Speed (200 bars) | Small-cap | Auth | Rate Limit |
|--------|------------|-----------------|-------------------|-----------|------|------------|
| **Binance** | 439 USDT | YES | **326ms** | Medium | No | 1200/min |
| **Bybit** | 635 | YES | **173ms** | Medium | No | 120/min |
| **MEXC** | 2388 | YES | **278ms** | Highest CEX | No | 500/min |
| **Gate.io** | 2311 | YES | **683ms** | High | No | 900/min |
| **KuCoin** | 1127 | YES | ~400ms | High | No | 100/min |
| **CryptoCompare** | 5000+ | YES (201 bars) | **311ms** | Very High | No* | 100K/mo |
| **Yahoo Finance** | ~500 crypto | YES (366 bars) | **338ms** | Low crypto | No | ~2000/hr |
| CoinGecko | 17870 listed | NO (4-day bars) | ~500ms | Discovery only | No | 10-30/min |
| DexScreener | DEX-only | NO (5m/1h/6h/24h) | ~200ms | DEX-only | No | ~300/min |
| Jupiter | 15000+ Solana | NO (prices only) | ~1s | Solana DEX | No | — |
| CoinCap | — | DOWN | — | — | — | — |

*CryptoCompare: 100K calls/month free tier (enough for ~333 symbols × 10 fetches/day)

## Optimal Source Stack

```
Priority waterfall (auto-selected per symbol):

1. Binance     → 439 pairs, fastest, most reliable for top tokens
2. CryptoCompare → 5000+ coins, broadest OHLCV, covers long-tail
3. Yahoo Finance → stocks, ETFs, forex, ~500 crypto, good for hybrid
4. MEXC         → 2388 pairs, highest small-cap CEX coverage (backup)
```

## Live Test Results

### Top 100 tokens (by market cap)
- Tradeable (non-stablecoin): 90
- OHLCV available: 70 (78%)
- Sources used: Binance 35, Yahoo 30, CryptoCompare 5

### Top 250 tokens
- Tradeable: 229
- OHLCV available: **195 (85%)**
- Sources: Binance 121 (62%), Yahoo 56 (29%), CryptoCompare 18 (9%)
- Time: **13.8 seconds** (65ms/symbol average)
- Failed: 34 (mostly RWA tokens, institutional products, very new tokens)

### Speed Benchmarks (200 daily bars, BTC)
```
Bybit:          173ms ⚡
MEXC:           278ms
CryptoCompare:  311ms
Binance:        326ms
Yahoo Finance:  338ms
Gate.io:        683ms
```

## OHLCV Format (normalized)
All sources normalize to:
```json
{ "time": 1775088000, "open": 66964.29, "high": 67057.42, "low": 66775.91, "close": 66969.87, "volume": 2827 }
```

## Coverage Gaps
Tokens that exist in top 250 but have NO OHLCV source:
- RWA tokens: BUIDL, OUSG, USTB, YLDS, USYC (institutional, no CEX listing)
- New tokens: HYPE, PUMP (too new for historical data)
- Exotic: NFT-like tokens, wrapped derivatives

## Unique tokens across ALL sources
- Binance: 439 unique tokens
- CryptoCompare: ~5000 unique (covers nearly all active crypto)
- Yahoo: ~500 crypto + unlimited stocks/ETFs/forex
- MEXC: 2388 unique (many micro-caps)
- **Combined theoretical max: ~6000 unique tokens with 200-day OHLCV**
- **Practical coverage: ~2000 tokens with reliable data (sufficient volume + history)**
