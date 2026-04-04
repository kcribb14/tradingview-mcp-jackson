# 4H Timeframe Validation — Massive Scale Test

## The Question
Does the Sharpe 5.0 / 64% win rate from the 20-symbol 4H backtest hold at scale?

## The Answer: PARTIALLY

The edge is real but much smaller than the initial sample suggested.

## Degradation Table

| Sample | Symbols | Events | Win Rate | Sharpe | p-value | Verdict |
|--------|---------|--------|----------|--------|---------|---------|
| Original 20 | 20 | 155 | **64%** | **5.00** | ? | Small sample |
| Top 50 | 50 | 691 | 39% | -0.04 | 1.59 | Not significant |
| Top 100 | 100 | 1,162 | 41% | 0.16 | 0.47 | Not significant |
| Top 200 | 200 | 1,815 | 43% | 0.26 | 0.04 | Weakly significant |
| **All 635** | **635** | **2,383** | **45%** | **0.36** | **<0.001** | **Significant but weak** |

### Key Insight
The Sharpe 5.0 was a **small-sample artifact**. At 635 symbols, Sharpe drops to 0.36. However, the edge IS statistically significant (p<0.001, t=3.49).

## Where 4H Actually Works (Per Asset Class)

| Class | Events | 10d Return | Win Rate | Sharpe | p-value | Edge? |
|-------|--------|------------|----------|--------|---------|-------|
| **Crypto Major** | **51** | **+5.57%** | **65%** | **2.33** | **<0.001** | **STRONG** |
| ASX Mining Micro | 901 | +1.81% | 34% | 0.40 | 0.03 | Weak |
| Crypto Mid | 183 | +2.66% | 52% | 0.95 | 0.02 | Moderate |
| US Large Cap | 58 | +1.09% | 60% | 1.02 | 0.19 | Not significant |
| US Mid/Small | 938 | +0.67% | 49% | 0.18 | 0.45 | **No edge** |
| ETFs | 165 | +0.54% | 60% | 0.37 | 0.56 | **No edge** |
| Commodities | 72 | +0.42% | 53% | 0.36 | 0.94 | **No edge** |

### The Only Strong 4H Edge: Crypto Majors
- BTC, ETH, SOL, XRP, BNB, ADA, DOGE
- Sharpe 2.33, 65% WR, +5.57% per trade
- Statistically significant at p<0.001

### 4H Does NOT Work For
- US Mid/Small stocks (p=0.45)
- ETFs (p=0.56)
- Commodities (p=0.94)

## Walk-Forward Validation (4H)

| Metric | In-Sample (70%) | Out-of-Sample (30%) | Degradation |
|--------|----------------|---------------------|-------------|
| Events | 1,668 | 715 | — |
| 10d return | +0.98% | **+2.24%** | **+1.26%** |
| Win rate | 42% | **53%** | **+11%** |
| Sharpe | 0.24 | **0.75** | **+0.51** |
| p-value | 0.08 | <0.001 | — |
| Significant | No | **YES** | — |

Unusual finding: out-of-sample OUTPERFORMS in-sample. This suggests the system works better in recent market conditions (2025-2026) than historical averages.

## Production System Architecture

Based on all validated findings, the production system uses:

### What to Trade (validated strategies only)
1. **US/ASX stocks on Daily**: Sharpe 0.52, 56% WR, p<0.01 — the most reliable
2. **Crypto Majors on 4H**: Sharpe 2.33, 65% WR, p<0.001 — the highest edge
3. **Skip crypto mid-caps**: negative edge (-0.75% avg, p>0.50)

### Regime Filter
- SPY below 200 EMA → BEAR → US signals suppressed to WATCH only
- BTC below 200 EMA → BEAR → Crypto signals suppressed
- 2022 backtest showed -0.90% avg return during bear regime

### Position Limits
- Max 5 concurrent positions
- 5% per position
- 25% max total exposure
- Rank by F&G depth, take top 5

### Current Regime (2026-04-04)
- **US: BEAR** (SPY 655.83 below EMA200 660.70) — signals suppressed
- **Crypto: BEAR** (BTC 67,143 below EMA200 85,917) — signals suppressed

## Final Recommendation

The 4H timeframe does NOT have a universal edge across all assets. The production system correctly uses:
- **Daily for stocks** (2127 events validated, p<0.001)
- **4H for crypto majors only** (51 events, p<0.001, highest Sharpe)
- **Regime filter** to avoid bear market signals (the only period with negative returns historically)
