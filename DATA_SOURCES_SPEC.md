# Unified Data Sources — Complete Coverage Matrix

Last updated: 2026-04-04 (live API tests)

## Global Coverage

| Market | Exchange | Listed | Scoreable | Yahoo Suffix | Speed | Status |
|--------|----------|--------|-----------|-------------|-------|--------|
| **US Stocks** | NYSE | 2,044 | ~1,800 | none | 18ms | LIVE |
| **US Stocks** | NASDAQ | 3,650 | ~3,200 | none | 18ms | LIVE |
| **US ETFs** | Mixed | 90+ | 90 | none | 18ms | LIVE |
| **ASX** | ASX | 1,979 | ~1,837 | .AX | 21ms | LIVE |
| **UK** | LSE | 4,026 | ~3,592 | .L | ~20ms | LIVE |
| **Canada** | TSX | 707 | ~616 | .TO | ~20ms | LIVE |
| **Hong Kong** | HKEX | 3,204 | ~2,800* | .HK | ~20ms | LIVE |
| **Japan** | TSE | ~3,800 | ~3,400* | .T | ~20ms | LIVE |
| **Germany** | XETRA | ~1,500 | ~1,300* | .DE | ~20ms | LIVE |
| **Singapore** | SGX | 562 | ~500 | .SI | ~20ms | LIVE |
| **South Africa** | JSE | 395 | ~350 | .JO | ~20ms | LIVE |
| **Brazil** | BOVESPA | ~500 | ~450* | .SA | ~20ms | LIVE |
| **South Korea** | KRX | ~2,000 | ~1,800* | .KS | ~20ms | LIVE |
| **Forex** | Major pairs | 24 | 23 | =X | ~20ms | LIVE |
| **Commodities** | Futures | 14 | 14 | =F | ~20ms | LIVE |
| **Indices** | Global | 22 | 22 | ^ | ~20ms | LIVE |
| **Bonds/Treasury** | US | 8 | 8 | mixed | ~20ms | LIVE |
| **Crypto CEX** | Multi | ~2,000 | ~1,500 | Binance/CC | ~25ms | LIVE |
| **Crypto DEX** | Solana | ~10,000 | 58+ | DexScreener | ~200ms | LIVE |
| **Crypto DEX** | Ethereum | ~5,000 | 40+ | DexScreener | ~200ms | LIVE |
| | | | | | | |
| **TOTAL LISTED** | | **~25,500** | | | | |
| **TOTAL SCOREABLE** | | **~17,486** | | | | |

*Estimated based on typical exchange coverage ratio (87-93%)

## Scale Test Results (live)

| Test | Instruments | Cold Cache | Warm Cache | Coverage |
|------|-------------|------------|------------|----------|
| 500 US stocks | 443 | 22.7s | <1s | 89% |
| 1,000 US stocks | 877 | 13.2s | <1s | 88% |
| 2,000 US stocks | 1,765 | 25.3s | <1s | 88% |
| ~2,000 ASX stocks | 1,837 | 34.6s | <1s | 93% |
| ~4,000 LSE stocks | 3,592 | 75.1s | <5s | 89% |
| ~700 TSX stocks | 616 | 16.5s | <1s | 87% |
| 90 ETFs | 90 | 1.4s | <1s | 100% |
| 24 Forex pairs | 23 | 0.4s | <1s | 96% |
| 14 Commodities | 14 | 0.3s | <1s | 100% |
| 22 Global indices | 22 | 0.5s | <1s | 100% |
| 250 Crypto | 195 | 13.8s | <1s | 85% |
| **Daily scan (1,050)** | **933** | — | **2.8s** | **89%** |
| **Mega scan (4,500)** | **4,002** | ~41s | **4.7s** | **89%** |

## Cache State (current)

- **6,493 entries** cached
- All INSTANT (< 1 hour old)
- Distribution: 942 Extreme Fear, 2311 Fear, 2856 Neutral, 384 Greed

## Source Priority Waterfall

```
Symbol → detectSymbol() → route to optimal source:

  *.AX, ASX:*         → Yahoo Finance (ASX)
  *.L, LSE:*          → Yahoo Finance (LSE)
  *.TO, TSX:*         → Yahoo Finance (TSX)
  *.HK, *.T, *.DE     → Yahoo Finance (international)
  *.SI, *.JO, *.SA     → Yahoo Finance (international)
  *=X                  → Yahoo Finance (forex)
  *=F                  → Yahoo Finance (futures)
  ^*                   → Yahoo Finance (indices)
  AAPL, SPY, etc.      → Yahoo Finance (US stocks/ETFs)
  BTC, ETH, SOL, etc.  → Binance → CryptoCompare → Yahoo → MEXC
```

## Available Presets

| Preset | Market | Count | Description |
|--------|--------|-------|-------------|
| `sp500` | US | 100 | S&P 500 core |
| `us_full` | US | 5,727 | All NYSE + NASDAQ |
| `asx_200` | ASX | 200 | ASX 200 index |
| `asx_mining` | ASX | 50 | Mining & resources |
| `asx_full` | ASX | 1,979 | All ASX |
| `lse_full` | UK | 4,026 | All LSE |
| `tsx_full` | Canada | 707 | All TSX |
| `tsx_mining` | Canada | 34 | Canadian miners |
| `lse_mining` | UK | 18 | London miners |
| `global_mining` | Multi | 102 | ASX + TSX + LSE miners |
| `hkex_full` | HK | 3,204 | All HKEX |
| `sgx_full` | SG | 562 | All SGX |
| `jse_full` | SA | 395 | All JSE |
| `etf_sector` | US | 20 | Sector ETFs |
| `etf_commodity` | US | 20 | Commodity ETFs |
| `etf_country` | US | 20 | Country ETFs |
| `etf_all` | US | 90 | All ETFs |
| `forex_majors` | FX | 24 | Major forex pairs |
| `commodities_all` | Futures | 14 | All commodity futures |
| `indices_global` | Global | 22 | Major global indices |
| `crypto_1000` | Crypto | 1,000 | Top 1000 by market cap |
| `crypto_full` | Crypto | ~736 | All cached crypto |
| `everything` | ALL | ~17,486 | Every instrument |
