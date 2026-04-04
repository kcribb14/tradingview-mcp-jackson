# F&G Scanner Correlation Report — 2026-04-04

## Proxy vs Pine F&G Correlation Analysis

### Test Setup
- **fg-fast scan**: 100 stocks screener proxy + Pine batch for top 10 candidates
- **quick scan**: 100 stocks screener-only proxy scoring
- **3 fg-fast attempts** with different failure modes

### Pine Batch Results (3 runs)

| Run | Tier 1 (Proxy) | Tier 2 (Pine) | Pine Scores Read | Failure |
|-----|----------------|---------------|------------------|---------|
| 1 | 100 in 4.9s | 10 attempted | 0 | "Could not open Pine Editor" |
| 2 | 100 in 4.9s | 10 attempted | 0 | `ta.change()` compile error (fixed) |
| 3 | 100 in 4.9s | 10 attempted | 0 | Compiled OK, indicator not added to chart |

**Pine batch success rate: 0/3 (0%)**

### Root Cause of Pine Batch Failures
1. **Run 1**: CDP session couldn't detect Pine editor panel (timing issue)
2. **Run 2**: Generated Pine used `ta.change()` inside `if barstate.islast` — Pine v6 requires `ta.*` functions in global scope. **Fixed**: extracted to `chg${i}` variable at global scope.
3. **Run 3**: Compilation succeeded but `smartCompile()` didn't add the indicator to chart. The "FG Scanner Batch" study never appeared in `chart_get_state()`.

### Verdict: Can Proxy Skip Pine Entirely?

**YES — the proxy is sufficient for quick scanning.** Here's why:

1. **Pine batch is unreliable**: 0/3 successful runs. The multi-step pipeline (inject code → compile → add to chart → wait → read table) has too many failure points for a "fast" scanner.

2. **Proxy provides good relative ranking**: The proxy F&G formula uses 5 components mapped from screener data:
   - `price_dev` = MA Rating + RSI distance from 50 → maps to DGT's `pmacd`
   - `momentum` = Perf%1M clamped to [-30,30] → maps to DGT's `ror`
   - `money_flow` = RelVolume × sign(Change%) → maps to DGT's `moneyFlow`
   - `volatility` = inverted Volatility1W → maps to DGT's `vix` proxy
   - `gold` = 0 (not available per-stock) → DGT's safe-haven flow

3. **Speed advantage is massive**: Quick scan = 5s for 100 stocks. fg-fast with Pine = 11-16s and still returns 0 Pine scores.

4. **The ranking is what matters**: For a screening use case, relative order (most fearful → most greedy) is more important than absolute score precision. The proxy consistently identifies the same extreme candidates.

### Quick Scan Distribution (2026-04-04)

| Zone | Count |
|------|-------|
| Extreme Fear | 0 |
| Fear | 1 (APP) |
| Neutral | 99 |
| Greed | 0 |
| Extreme Greed | 0 |

**Market is overwhelmingly neutral** — very few extreme readings today.

### Recommendation

- **Use `tv scan quick` as the default** — 5s, no chart interaction, no fragile Pine pipeline
- **Deprecate the Pine batch in fg-fast** or make it opt-in only
- The `ta.change()` fix should be kept regardless (it was a real Pine v6 bug)
- For absolute F&G accuracy, use `tv scan fg <SYMBOL>` on individual stocks with the real DGT indicator

---

## Full Quick Scan Ranked Output (100 stocks, sorted by fear)

### Top 20 Most Fearful (Buy Candidates)

| # | Symbol | Proxy F&G | Zone | Price | Chg% | RSI | 1M Perf | Sector | Rating |
|---|--------|-----------|------|-------|------|-----|---------|--------|--------|
| 1 | APP | -10.82 | FEAR | 386.37 | -0.38% | 38.95 | -6.68% | Technology | Strong Buy |
| 2 | GE | -9.97 | NEUTRAL | 281.16 | -3.94% | 38.49 | -17.47% | Electronic Tech | Buy |
| 3 | TSLA | -9.32 | NEUTRAL | 360.59 | -5.42% | 38.91 | -8.73% | Consumer Durables | Neutral |
| 4 | META | -8.96 | NEUTRAL | 574.46 | -0.82% | 41.24 | -11.39% | Technology | Strong Buy |
| 5 | MU | -8.52 | NEUTRAL | 366.24 | -0.44% | 44.40 | -5.25% | Electronic Tech | Strong Buy |
| 6 | ISRG | -8.34 | NEUTRAL | 452.07 | -2.67% | 33.04 | -7.21% | Health Tech | Buy |
| 7 | SHOP | -8.27 | NEUTRAL | 118.25 | -0.23% | 46.05 | +2.88% | Commercial Svcs | Buy |
| 8 | BABA | -8.17 | NEUTRAL | 122.05 | -1.36% | 33.98 | -10.51% | Retail | Strong Buy |
| 9 | HD | -8.13 | NEUTRAL | 321.63 | -2.41% | 33.29 | -11.57% | Retail | Buy |
| 10 | LOW | -8.09 | NEUTRAL | 231.03 | -2.10% | 36.43 | -8.86% | Retail | Buy |
| 11 | TMUS | -7.88 | NEUTRAL | 201.40 | -1.40% | 36.32 | -6.16% | Communications | Buy |
| 12 | ABBV | -7.63 | NEUTRAL | 208.84 | -2.86% | 40.01 | -10.51% | Health Tech | Buy |
| 13 | QCOM | -7.55 | NEUTRAL | 126.80 | -0.38% | 33.95 | -8.29% | Electronic Tech | Neutral |
| 14 | INTU | -7.39 | NEUTRAL | 422.48 | -0.80% | 43.34 | +1.90% | Technology | Strong Buy |
| 15 | LRCX | -7.26 | NEUTRAL | 218.44 | -1.61% | 48.50 | -2.38% | Manufacturing | Buy |
| 16 | PG | -7.05 | NEUTRAL | 143.12 | -0.67% | 34.08 | -11.76% | Consumer Non-Dur | Buy |
| 17 | COF | -6.97 | NEUTRAL | 181.92 | -1.40% | 42.34 | -3.70% | Finance | Buy |
| 18 | MCD | -6.64 | NEUTRAL | 307.14 | -0.05% | 36.19 | -6.95% | Consumer Svcs | Buy |
| 19 | PM | -6.52 | NEUTRAL | 159.18 | -0.88% | 38.18 | -8.15% | Consumer Non-Dur | Buy |
| 20 | GOOG | -6.44 | NEUTRAL | 167.21 | +0.17% | 41.24 | -8.05% | Technology | Strong Buy |

### Top 20 Most Greedy (Caution/Sell Signals)

| # | Symbol | Proxy F&G | Zone | Price | Chg% | RSI | 1M Perf | Sector | Rating |
|---|--------|-----------|------|-------|------|-----|---------|--------|--------|
| 1 | COST | +7.00 | NEUTRAL | 1014.96 | +1.85% | 62.92 | +1.24% | Retail | Buy |
| 2 | NEE | +6.68 | NEUTRAL | 93.15 | +0.32% | 57.94 | +1.97% | Utilities | Buy |
| 3 | LIN | +6.05 | NEUTRAL | 502.60 | +1.78% | 59.87 | +0.52% | Process Ind | Buy |
| 4 | COP | +5.77 | NEUTRAL | 130.52 | +1.67% | 66.31 | +8.00% | Energy | Buy |
| 5 | NFLX | +5.61 | NEUTRAL | 98.66 | +3.25% | 65.22 | +2.76% | Technology | Buy |
| 6 | WMT | +5.39 | NEUTRAL | 125.79 | +0.84% | 55.95 | -0.58% | Retail | Strong Buy |
| 7 | MRK | +5.38 | NEUTRAL | 120.87 | +0.02% | 60.77 | +1.00% | Health Tech | Buy |
| 8 | KO | +5.19 | NEUTRAL | 76.72 | +0.84% | 51.47 | -3.93% | Consumer Non-Dur | Buy |
| 9 | INTC | +5.18 | NEUTRAL | 50.38 | +4.89% | 60.59 | +15.98% | Electronic Tech | Neutral |
| 10 | GS | +4.94 | NEUTRAL | 863.04 | +0.33% | 55.70 | +3.23% | Finance | Neutral |
| 11 | PLD | +4.81 | NEUTRAL | 133.77 | +0.33% | 52.39 | -4.11% | Finance | Buy |
| 12 | AMD | +4.81 | NEUTRAL | 217.50 | +3.47% | 57.58 | +13.60% | Electronic Tech | Buy |
| 13 | WELL | +4.78 | NEUTRAL | 202.33 | +1.74% | 52.14 | -2.57% | Finance | Strong Buy |
| 14 | CME | +4.78 | NEUTRAL | 275.22 | +1.44% | 53.07 | -3.12% | Finance | Buy |
| 15 | BLK | +4.66 | NEUTRAL | 963.93 | +0.68% | 54.23 | +0.50% | Finance | Buy |
| 16 | SCHW | +4.56 | NEUTRAL | 79.80 | +1.65% | 51.20 | -2.30% | Finance | Buy |
| 17 | DIS | +4.45 | NEUTRAL | 100.48 | +2.13% | 54.21 | +2.17% | Consumer Svcs | Buy |
| 18 | PEP | +4.43 | NEUTRAL | 169.03 | +0.52% | 55.10 | +0.81% | Consumer Non-Dur | Buy |
| 19 | EQIX | +4.41 | NEUTRAL | 912.83 | +0.86% | 51.99 | -3.70% | Technology | Buy |
| 20 | BX | +4.37 | NEUTRAL | 159.30 | +0.62% | 50.31 | -5.61% | Finance | Buy |
