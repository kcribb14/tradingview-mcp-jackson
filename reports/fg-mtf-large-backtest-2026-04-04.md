# Multi-TF Signal Backtest — LARGE SCALE (1063 symbols)

**10,667 events across 1063 symbols × 2 years of 1H + Daily data**

## The 9-Event Recovery Myth: DEBUNKED

The previous backtest showed Recovery at 78% WR / Sharpe 4.83 on 9 events.

At scale (80 events): **49% WR / Sharpe 0.93 / p=0.15 — NOT SIGNIFICANT.**

The 78% win rate was a small-sample artifact, exactly as feared.

## Definitive Signal Type Comparison (10,667 events)

| Signal Type | Events | 10d Return | 95% CI | WR | Sharpe | p-value | Sig? |
|-------------|--------|------------|--------|-----|--------|---------|------|
| **Daily Only** | **424** | **+3.01%** | **[1.35, 4.67]** | **48%** | **0.87** | **<0.001** | **YES** |
| Recovery (strict) | 29 | +11.65% | [-1.88, 25.18] | 48% | 1.57 | 0.14 | No |
| Recovery (relaxed) | 80 | +5.48% | [-1.02, 11.98] | 49% | 0.93 | 0.15 | No |
| **Div Bullish** | **6,745** | **+1.61%** | **[1.22, 2.00]** | **49%** | **0.50** | **<0.001** | **YES** |
| **Div Bearish** | **2,711** | **+1.13%** | **[0.57, 1.69]** | **49%** | **0.38** | **<0.001** | **YES** |
| Early Warning | 425 | +0.10% | [-2.11, 2.31] | 41% | 0.02 | 1.81 | No |
| Full Alignment | 169 | +1.13% | [-3.17, 5.43] | 38% | 0.20 | 1.06 | No |

## What Actually Works (3 strategies with p<0.001)

### 1. Daily Only — THE BASELINE IS BEST
- 424 events, **+3.01% per trade**, Sharpe **0.87**, p<0.001
- 95% CI: [1.35%, 4.67%] — entirely above zero
- The simplest approach outperforms every multi-TF strategy
- Best per-class: ASX Mining Micro (+4.44%, Sharpe 1.06)

### 2. Divergence Bullish — HIGH VOLUME, MODERATE EDGE
- 6,745 events, +1.61% per trade, Sharpe 0.50, p<0.001
- The most frequent signal type by far
- Best per-class: ASX Mining Mid (+2.83%, 61% WR, Sharpe 1.33)

### 3. Divergence Bearish — UNEXPECTED POSITIVE RETURN
- 2,711 events, +1.13% per trade, Sharpe 0.38, p<0.001
- Even when 1H is more bearish than daily, the 10-day return is positive
- This suggests mean reversion dominates at 10-day horizons

## What Does NOT Work (debunked at scale)

### Recovery — Small Sample Artifact
- 9 events → 78% WR, Sharpe 4.83 (SEEMED amazing)
- 80 events → 49% WR, Sharpe 0.93, p=0.15 (NOT significant)
- The high return persists (+5.48%) but with massive variance
- **Cannot be trusted for production use**

### Early Warning — Confirmed Worthless
- 425 events, +0.10%, 41% WR, p=1.81
- Front-running the daily signal is **not profitable**

### Full Alignment — Confirmed Worst Signal
- 169 events, +1.13%, 38% WR, p=1.06
- When all timeframes agree on fear, it's too late to buy

## Per Asset Class Winners (Daily Only, 10d hold)

| Asset Class | Events | Avg Return | WR | Sharpe | Significant? |
|-------------|--------|------------|-----|--------|-------------|
| **Crypto Mid** | 10 | +8.90% | 70% | 3.32 | YES (tiny sample) |
| **ASX Mining Micro** | 176 | **+4.44%** | 41% | **1.06** | **YES** |
| US Mid/Small | 158 | +2.48% | 53% | 0.75 | Borderline |
| US Large Cap | 19 | +1.36% | 58% | 0.97 | No (too few) |
| ASX Mining Mid | 12 | +1.03% | 67% | 0.47 | No |
| ASX Top 50 | 44 | -0.54% | 41% | -0.47 | No |

## Final Verdict

**The simple daily-only fear signal is the only reliably profitable strategy.**

Multi-TF analysis adds information value (watching divergences, tracking recovery) but does NOT improve entry timing compared to the daily signal alone. All multi-TF signal types either:
- Have too few events to be statistically significant (Recovery)
- Have lower returns than daily-only (Early Warning, Full Alignment)
- Have higher event count but lower per-trade returns (Divergence)

**Recommended production strategy:**
1. Use **Daily F&G with calibrated per-class thresholds** as the primary trigger
2. Use **Divergence Bullish** as a confirmation indicator (many events, significant)
3. Show all other signal types for information but DO NOT use them for entry decisions
4. Track forward performance to validate in real time
