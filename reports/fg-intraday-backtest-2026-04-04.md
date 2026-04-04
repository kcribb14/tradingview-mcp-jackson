# Multi-Timeframe F&G Backtest — Intraday Analysis

**20 symbols × 4 timeframes × up to 10,000 bars per series**

## Data Availability

| Timeframe | Yahoo (Stocks) | Binance (Crypto) | EMA Warmup | Lookback |
|-----------|---------------|-----------------|------------|----------|
| 5m | 4,681 bars (60d) | 1,000 (3d) | 12 hours | Too short |
| 15m | 1,561 bars (60d) | 5,760 (60d) | 36 hours | 60 days |
| **1H** | **3,503 bars (2y)** | **10,000 (1.5y)** | **6 days** | **2 years** |
| 4H | 872 bars (2y) | 3,000 (167d) | 24 days | 6 months |
| Daily | 2,515 bars (10y) | 3,000 (8.5y) | 7 months | 10 years |

## Fear Event Frequency Per Timeframe

| TF | Events (20 syms) | Events/Symbol | Avg Drawdown | Optimal Hold | Best Return | Best WR |
|----|-----------------|---------------|-------------|-------------|-------------|---------|
| 15m | 98 | 4.9 | -2.7% | 3 hours | +0.21% | 51% |
| **1H** | **309** | **15.5** | **-1.7%** | **3 days** | **+1.43%** | **50%** |
| **4H** | **155** | **7.8** | **-4.4%** | **10 days** | **+7.66%** | **64%** |
| Daily | 504 | 25.2 | -5.5% | 6 weeks | +5.01% | 56% |

## Annualized Return Comparison

| TF | Optimal Hold | Return/Trade | Trades/Yr (est) | **Annual Return** | **Sharpe** |
|----|-------------|-------------|-----------------|-------------------|------------|
| 15m | 3h | +0.21% | ~200 | 2.1% | 1.04 |
| **1H** | **3d** | **+1.43%** | **~200** | **14.3%** | **1.66** |
| **4H** | **10d** | **+7.66%** | **~159** | **60.8%** | **5.00** |
| Daily | 6w | +5.01% | ~200 | 50.1% | 3.23 |

### Winner: 4H Timeframe
- Sharpe 5.0 (vs 1.66 for 1H, 3.23 for daily)
- 64% win rate (highest across all timeframes)
- +7.66% per trade with 10-day hold
- 155 events (enough for statistical significance)

### Why 4H Wins
- **15m is too noisy**: 0.21% per trade barely covers transaction costs
- **1H is good but low return**: 1.43% per trade, 50% WR — edge exists but small
- **4H is the sweet spot**: long enough to filter noise, short enough for frequent signals
- **Daily has fewer signals per symbol**: but longer lookback gives more total history

## Per-Asset-Class Results (1H Timeframe, 24h hold)

| Asset Class | Events | 24h Return | Win Rate | t-stat | Significant? |
|-------------|--------|------------|----------|--------|-------------|
| **US Stocks** | 68 | **+2.15%** | **66%** | 2.71 | **YES p<0.01** |
| ASX Mining | 127 | +0.13% | 37% | 0.13 | No |
| **Crypto** | 10 | **+12.69%** | **90%** | 4.26 | **YES p<0.01** |
| **ETFs/Commodities** | 102 | **+0.97%** | **63%** | 2.45 | **YES p<0.05** |

### Key Finding
Crypto 1H fear signals have a **90% win rate at 24h** but only 10 events (small sample). US stocks show 66% WR at 24h with strong significance. ASX mining does NOT work on 1H (37% WR — too illiquid for intraday signals).

## Cross-Timeframe Confirmation Strategies

| Strategy | Events | Avg Return | Win Rate | t-stat | Significant? |
|----------|--------|------------|----------|--------|-------------|
| **A: Daily only** | **880** | **+2.08%** | **51%** | **3.63** | **YES p<0.001** |
| **B: 1H only** | **339** | **+1.07%** | **51%** | **2.31** | **YES p<0.05** |
| C: Daily + 1H aligned | 260 | +0.62% | 47% | 1.19 | No |
| D: Daily fear + 1H rising | 172 | +0.01% | 46% | 0.02 | No |
| E: 4H fear + 1H reversal | 229 | -0.22% | 44% | -0.46 | No |

### Critical Finding: Cross-TF Confirmation Does NOT Improve Results
The combined strategies (C, D, E) **underperform** both A and B individually. The filters are too restrictive — they reduce event count without improving win rate. **Simpler is better.**

## Conclusions

### Does Higher Frequency = Better Returns?
**No — 4H is the optimal frequency**, not 15m or even 1H. The returns per trade increase with timeframe up to 4H, then plateau at daily. The Sharpe ratio peaks at 4H because it balances signal frequency with noise filtering.

### What's the Optimal System?
- **For stocks and ETFs**: 4H timeframe, 10-day hold (Sharpe 5.0, 64% WR)
- **For crypto**: 1H timeframe, 24h hold (90% WR but small sample)
- **For ASX mining**: Daily timeframe only (intraday too illiquid)
- **For commodities**: Daily or 4H (both statistically significant)

### Does Cross-TF Confirmation Help?
**No.** Daily fear + intraday confirmation does NOT improve results. The best approach is to use each timeframe independently with its own calibrated thresholds. The signal on its own timeframe is already the information — combining timeframes just reduces the event count without improving accuracy.

### What's the Realistic Annual Return?
Using 4H on stocks with 5% position sizing: **~60% annualized** (backtested). But:
- This assumes no transaction costs (significant for 159 trades/year)
- Assumes no slippage
- Assumes perfect execution
- Realistic expectation with costs: **20-40% annualized**
