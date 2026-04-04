# F&G Deep Backtest — Definitive Statistical Analysis

**92 symbols × 10 years × 2,127 fear events**

## Dataset

| Asset Class | Symbols | Avg Bars | Date Range | Fear Events |
|-------------|---------|----------|------------|-------------|
| US Large Cap | 20 | 2,515 | 2016-2026 | 397 |
| US Mid/Small | 10 | 1,536 | 2016-2026 | 105 |
| ASX Major | 10 | 2,533 | 2016-2026 | 200 |
| ASX Mining | 15 | 2,348 | 2016-2026 | 497 |
| Crypto Major | 10 | 2,642 | 2017-2026 | 277 |
| Crypto Mid | 9 | 1,930 | 2017-2026 | 228 |
| ETFs | 10 | 2,515 | 2016-2026 | 330 |
| Commodities | 5 | 2,514 | 2016-2026 | 92 |
| Forex | 3 | 2,603 | 2016-2026 | 1 |
| **TOTAL** | **92** | **2,400 avg** | **10 years** | **2,127** |

## Statistical Significance (t-test: is 30-day return after fear signal > 0?)

| Asset Class | N | Mean 30d | StdDev | t-stat | p-value | **Significant?** |
|-------------|---|----------|--------|--------|---------|-------------------|
| **US Large Cap** | 397 | **+2.65%** | 14.7% | 3.58 | <0.01 | **YES p<0.01** |
| **US Mid/Small** | 105 | **+7.52%** | 31.5% | 2.45 | 0.02 | **YES p<0.05** |
| ASX Major | 200 | +1.49% | 11.2% | 1.88 | 0.09 | No (p=0.09) |
| **ASX Mining** | 497 | **+6.44%** | 35.3% | 4.07 | <0.01 | **YES p<0.01** |
| Crypto Major | 277 | +3.51% | 31.6% | 1.85 | 0.10 | No (p=0.10) |
| Crypto Mid | 228 | -0.75% | 30.6% | -0.37 | >0.50 | No (negative) |
| **ETFs** | 330 | **+1.85%** | 10.2% | 3.31 | <0.01 | **YES p<0.01** |
| **Commodities** | 92 | **+2.21%** | 8.7% | 2.43 | 0.02 | **YES p<0.05** |
| **OVERALL** | 2,127 | **+3.28%** | 25.4% | 5.95 | <0.001 | **YES p<0.001** |

### Verdict
The calibrated F&G system has a **statistically significant edge** overall (p<0.001). It works best for:
1. **ASX Mining** — highest edge (+6.44%, p<0.01)
2. **US Mid/Small** — second highest (+7.52%, p<0.05)
3. **US Large Cap** — most reliable (+2.65%, p<0.01, lowest volatility)
4. **ETFs** — consistent (+1.85%, p<0.01)
5. **Commodities** — solid (+2.21%, p<0.05)

**Does NOT work for: Crypto Mid-caps** (-0.75%, not significant). Crypto Majors are borderline (p=0.10).

## Strategy Metrics (Sharpe, Profit Factor, Expectancy)

| Asset Class | Sharpe | Win Rate | Profit Factor | Expectancy | Max DD |
|-------------|--------|----------|---------------|------------|--------|
| **Commodities** | **0.73** | 57% | 1.98 | +2.21% | -166%* |
| **US Mid/Small** | **0.69** | 52% | 1.94 | +7.52% | -64% |
| **ASX Mining** | **0.53** | 49% | 1.95 | +6.44% | -80% |
| ETFs | 0.53 | 57% | 1.63 | +1.85% | -59% |
| US Large Cap | 0.52 | 56% | 1.63 | +2.65% | -67% |
| ASX Major | 0.39 | 59% | 1.46 | +1.49% | -64% |
| Crypto Major | 0.32 | 47% | 1.42 | +3.51% | -80% |
| Crypto Mid | **-0.07** | 36% | 0.93 | **-0.75%** | -63% |

*Commodities max DD is for crude oil futures which can spike massively.

**Best risk-adjusted**: Commodities (0.73 Sharpe), US Mid/Small (0.69 Sharpe)
**Worst risk-adjusted**: Crypto Mid (-0.07 Sharpe — negative edge)

## Era Segmentation — Does It Work in All Market Regimes?

| Era | Events | 30d Return | Win Rate | Avg DD | Days to Bottom |
|-----|--------|------------|----------|--------|----------------|
| **Pre-COVID (2016-2019)** | 525 | +3.48% | 51% | -7.7% | 9.3 |
| **COVID Crash (2020)** | 181 | **+6.71%** | **57%** | -14.0% | 8.1 |
| **Bull Run (2021)** | 224 | **+8.70%** | 53% | -7.4% | 7.3 |
| **Rate Hike Bear (2022)** | 432 | **-0.90%** | **44%** | -11.1% | 10.8 |
| **Recovery (2023-2024)** | 435 | **+4.11%** | **58%** | -7.2% | 9.6 |
| **Current (2025-2026)** | 327 | +1.77% | 47% | -9.0% | 7.4 |

### Key Finding: The 2022 Bear Market Was the Only Losing Period
- COVID 2020: fear signals had the HIGHEST returns (+6.71%, 57% WR) — V-shaped recovery
- 2022 Rate Hike: the ONLY period with negative returns (-0.90%, 44% WR) — extended bear
- 2021 Bull: highest absolute returns (+8.70%) — buying any dip worked
- Current 2025: moderate (+1.77%, 47% WR) — cautious environment

The system works in 5 out of 6 market eras. The 2022 bear was the exception — fear signals during a sustained rate-hike bear market produced small losses.

## Crash Velocity Analysis

Does the SPEED of the crash predict recovery?

| Crash Type | N | 30d Return | Win Rate | Avg Drawdown |
|------------|---|------------|----------|-------------|
| Fast crash (FG drops >10 pts in 5 days) | 201 | +3.46% | 53% | -9.2% |
| Slow bleed (FG drifts down gradually) | 806 | +2.99% | 52% | -8.6% |
| Already low (FG was already in fear) | 1,120 | +3.45% | 51% | -9.2% |

**Finding: Crash velocity does NOT significantly predict recovery.** All three types produce similar 30-day returns (~3.0-3.5%). The theory that fast crashes = faster recovery is not supported by the data.

## Walk-Forward Validation (Out-of-Sample Test)

| Metric | In-Sample (2016-2023) | Out-of-Sample (2024-2026) | Degradation |
|--------|----------------------|--------------------------|-------------|
| **N events** | 1,572 | 555 | — |
| **Avg 30d return** | +3.56% | **+2.48%** | -1.08% |
| **Win rate** | 51% | **51%** | **0%** |
| **p-value** | <0.001 | **0.01** | — |
| **Significant?** | YES | **YES** | — |

### Verdict: System is Robust
- Out-of-sample returns degraded by only -1.08% (from +3.56% to +2.48%) — within normal range
- Win rate is IDENTICAL at 51% in both periods
- Out-of-sample results are STILL statistically significant (p=0.01)
- **No evidence of overfitting**

## Final Confidence Assessment

### Does the calibrated F&G system have a statistically significant edge?
**YES.** p<0.001 overall, confirmed out-of-sample with p=0.01. Expected 30-day return of +3.28% with 51% win rate across 2,127 events over 10 years.

### Which asset classes work best? (ranked by Sharpe)
1. **Commodities** — Sharpe 0.73, +2.21% avg, 57% WR
2. **US Mid/Small** — Sharpe 0.69, +7.52% avg, 52% WR (highest absolute return)
3. **ASX Mining** — Sharpe 0.53, +6.44% avg, 49% WR (most events)
4. **ETFs** — Sharpe 0.53, +1.85% avg, 57% WR (most consistent)
5. **US Large Cap** — Sharpe 0.52, +2.65% avg, 56% WR (most reliable)

### Where does it NOT work?
- **Crypto Mid-caps**: negative expectancy (-0.75%), 36% WR, Sharpe -0.07. DO NOT USE for altcoins.
- **Crypto Majors**: borderline (p=0.10), not statistically significant. Use with caution.

### Is it robust across market eras?
**5/6 eras profitable.** Only the 2022 rate-hike bear produced losses (-0.90%). The system works in V-shaped recoveries (COVID), bull markets (2021), and normal conditions (2016-2019, 2023-2024).

### Realistic expected forward returns
- **+2.5% per fear signal at 30 days** (out-of-sample validated)
- **51% win rate** (consistent in and out of sample)
- **Average 9 days to bottom** (median)
- **-9% average drawdown after signal** (before recovery)

### Recommended position sizing
Given 51% WR and +2.5% expected return per trade with ~25% standard deviation:
- **Kelly fraction**: ~0.4% of portfolio per trade (very conservative due to high variance)
- **Practical**: 2-5% of portfolio per fear signal, scaled by confidence
- **Maximum exposure**: never more than 20% of portfolio in fear-signal positions simultaneously
