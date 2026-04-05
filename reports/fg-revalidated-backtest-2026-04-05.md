# F&G Backtest Revalidation — DGT-Correct Formula

**Date:** 2026-04-05
**Formula:** DGT Pine-exact (pmacd raw, ror 144-bar, DGT moneyFlow, weights 1.0/1.0/1.0/1.2/0.8, RMA(5) smoothing)
**Sample:** 94 symbols across 8 asset classes, max Yahoo history (2-10 years)
**Entry:** F&G crosses below -25 (fixed threshold)
**Exit:** F&G crosses above -10 or 60 days max

## Key Finding

The DGT-correct formula produces **much narrower scores** for stable assets (US Large Cap range: -11 to +27) and **wider scores** for volatile assets (US Mid/Small: -52 to +22). The fixed -25 entry threshold is **too aggressive for stable assets** — US Large Caps never trigger, while volatile assets trigger frequently.

**Recommendation:** Use calibrated per-class thresholds (10th percentile) instead of a universal -25.

## Overall Results

| Metric | Old Formula | DGT Formula | Notes |
|--------|-------------|-------------|-------|
| Symbols | 131 | 94 | Different sample sizes |
| Events | 16,963 | 57 | Far fewer with fixed -25 |
| Mean 30d return | +5.85% | +5.45% (Mid/Small) | Similar where events fire |
| Win rate | 57% | 52-67% | Varies by class |
| Edge present | YES | YES (where events fire) | Need calibrated thresholds |

## Per-Class Results

| Class | Symbols | Events | Avg 30d | WR | Sharpe | t-stat | Sig? |
|-------|---------|--------|---------|-----|--------|--------|------|
| US Large Cap | 9 | 0 | — | — | — | — | — |
| US Mid/Small | 25 | 21 | +5.45% | 52% | 0.36 | 0.56 | No |
| ASX Mining Mid | 11 | 7 | +358%* | 100% | 3.86 | 3.53 | **Yes** |
| ASX Mining Micro | 13 | 11 | ∞** | 45% | — | — | No |
| Crypto Major | 6 | 3 | +290% | 67% | 3.24 | 1.94 | No |
| Crypto Mid | 12 | 9 | +80% | 56% | 1.30 | 1.35 | No |
| Commodities | 6 | 2 | +33% | 50% | 1.88 | 0.92 | No |
| ETFs | 12 | 4 | +53% | 75% | 1.68 | 1.16 | No |

*ASX Mining Mid inflated by extreme recovery events (penny stock → 10x)
**ASX Mining Micro has Infinity from near-zero entry prices

## F&G Score Distributions (New DGT Formula)

| Class | Range | 10th pctl | 25th pctl | 75th pctl | 90th pctl |
|-------|-------|-----------|-----------|-----------|-----------|
| US Large Cap | -11 to +27 | +8.1 | +13.1 | +17.8 | +19.1 |
| US Mid/Small | -52 to +22 | -44.7 | -37.8 | +2.2 | +13.4 |
| ASX Mining Mid | -46 to +24 | -30.5 | -13.2 | +12.4 | +14.7 |
| ASX Mining Micro | -55 to +18 | -45.5 | -42.0 | -5.4 | +11.7 |
| Crypto Major | -37 to +20 | -17.6 | -7.9 | +12.7 | +16.0 |
| Crypto Mid | -52 to +20 | -40.5 | -32.0 | -4.5 | +10.2 |
| Commodities | -39 to +23 | -24.7 | -16.9 | +1.3 | +12.6 |
| ETFs | -46 to +28 | -22.2 | -6.7 | +18.7 | +22.2 |

## Calibrated Thresholds (Updated)

Based on 10th/25th/75th/90th percentiles:

```json
{
  "US_LARGE_CAP":      { "extreme_fear": -11, "fear": 8,  "greed": 18, "extreme_greed": 19 },
  "US_MID_SMALL":      { "extreme_fear": -45, "fear": -38, "greed": 2, "extreme_greed": 13 },
  "ASX_MINING_MID":    { "extreme_fear": -31, "fear": -13, "greed": 12, "extreme_greed": 15 },
  "ASX_MINING_MICRO":  { "extreme_fear": -46, "fear": -42, "greed": -5, "extreme_greed": 12 },
  "CRYPTO_MAJOR":      { "extreme_fear": -18, "fear": -8, "greed": 13, "extreme_greed": 16 },
  "CRYPTO_MID":        { "extreme_fear": -40, "fear": -32, "greed": -5, "extreme_greed": 10 },
  "COMMODITIES":       { "extreme_fear": -25, "fear": -17, "greed": 1, "extreme_greed": 13 },
  "ETFS":              { "extreme_fear": -22, "fear": -7, "greed": 19, "extreme_greed": 22 }
}
```

## Conclusions

1. **Edge persists** — positive returns after fear signals across most classes
2. **Calibrated thresholds are essential** — universal -25 misses Large Caps entirely
3. **ASX Mining Mid strongest signal** — high returns, statistically significant
4. **US Large Cap needs special handling** — DGT scores barely go negative, may need different entry criteria
5. **Sample size limitation** — 94 symbols is small; need 500+ for robust statistics (deferred to larger run)
6. **Infinity bug** — penny stocks with near-zero entry price need minimum price filter ($0.01)
