# Bulk Scanner Pipeline — Technical Specification

**Date**: 2026-04-04 | **Status**: DESIGN — Based on Live Test Results

---

## 1. What Data Can We Get in Bulk From the Screener?

### 1.1 Row Limits (Tested)

| Metric | Value | Notes |
|--------|-------|-------|
| **Max rows per read** | 100 | Hard limit — DOM table renders exactly 100 rows |
| **"Show more" button** | Exists but didn't load more rows via CDP click | May need scroll-to-bottom trigger |
| **Pagination elements** | 6 detected in DOM | Not yet exploited |
| **Backend** | scanner.tradingview.com | Likely returns >100 but UI caps display |

**Workaround for >100 stocks**: Run multiple filtered reads. Example: filter Market cap > 100B (get top 100), then filter Market cap between 50B and 100B (next batch), etc. Each read takes ~600ms.

### 1.2 Every Column Available Per View (Live Test Results)

#### Overview (12 columns) — DEFAULT
```
Symbol | Price | Change % | Volume | Rel Volume | Market cap |
P/E | EPS dilTTM | EPS dil growthTTM YoY | Div yield %TTM |
Sector | Analyst Rating
```
Sample: `NVDA | 177.39 USD | +0.93% | 143.14 M | 0.77 | 4.31 T USD | 36.19 | 4.90 USD | +66.75% | 0.02% | Electronic technology | Strong buy`

#### Technicals (11 columns) — RSI, STOCH, MACD SIGNALS
```
Symbol | Tech Rating | MA Rating | Os Rating |
RSI (14) | Mom (10) | AO | CCI (20) |
Stoch (14,3,3)%K | Stoch (14,3,3)%D | Pattern
```
Sample: `NVDA | Neutral | Sell | Neutral | 49.08 | −1.17 | −9.76 | −37.31 | 47.04 | 31.08 | (empty)`

#### Performance (14 columns) — MULTI-TIMEFRAME RETURNS
```
Symbol | Price | Change % | Perf %1W | Perf %1M | Perf %3M |
Perf %6M | Perf %YTD | Perf %1Y | Perf %5Y | Perf %10Y |
Perf %All Time | Volatility1W | Volatility1M
```
Sample: `NVDA | 177.39 USD | +0.93% | +0.75% | −0.62% | −6.56% | −6.24% | −6.56% | +65.34% | +1,207.01% | +19,898.87% | +405,361.00% | 3.04% | 2.93%`

#### Valuation (14 columns)
```
Symbol | Market cap | Market cap perf %1Y | P/E | PEGTTM |
P/S | P/B | P/CF | P/FCF | Price / cash |
EV | EV / revenueTTM | EV / EBITTTM | EV / EBITDATTM
```

#### Profitability (11 columns)
```
Symbol | Gross marginTTM | Operating marginTTM | Pretax marginTTM |
Net marginTTM | FCF marginTTM | ROATTM | ROETTM | ROICTTM |
R&D ratioTTM | SG&A ratioTTM
```

#### Income Statement (10 columns)
```
Symbol | Fiscal periodCurrent | Fiscal period endCurrent |
RevenueTTM | Revenue growthTTM YoY | Gross profitTTM |
Operating incomeTTM | Net incomeTTM | EBITDATTM |
EPS dilTTM | EPS dil growthTTM YoY
```

#### Balance Sheet (13 columns)
```
Symbol | Fiscal periodCurrent | Fiscal period endCurrent |
Total assetsFQ | Current assetsFQ | Cash on handFQ |
Total liabilitiesFQ | Total debtFQ | Net debtFQ |
Total equityFQ | Current ratioFQ | Quick ratioFQ |
Debt / equityFQ | Cash / debtFQ
```

**Also available** (not tested in this session): Dividends, Cash Flow, Per Share, Extended Hours

### 1.3 Total Unique Fields Across All Views

**~85 unique data points per stock** when reading all views. Crucially:

| Category | Available? | Fields |
|----------|-----------|--------|
| **Technical indicators** | YES | RSI(14), Momentum(10), AO, CCI(20), Stoch %K/%D, Tech/MA/Os Ratings, Pattern |
| **Multi-timeframe performance** | YES | 1D, 1W, 1M, 3M, 6M, YTD, 1Y, 5Y, 10Y, All Time returns |
| **Volatility** | YES | 1W and 1M volatility |
| **Volume metrics** | YES | Volume (absolute) and Relative Volume |
| **Fundamental valuation** | YES | P/E, PEG, P/S, P/B, P/CF, P/FCF, EV/Revenue, EV/EBIT, EV/EBITDA |
| **Profitability** | YES | Gross/Operating/Net/FCF margins, ROA, ROE, ROIC |
| **Growth** | YES | EPS growth YoY, Revenue growth YoY |
| **Balance sheet** | YES | Total assets, cash, debt, equity, current ratio, quick ratio, D/E |
| **Analyst consensus** | YES | Strong buy / Buy / Neutral / Sell / Strong sell |
| **Moving averages** | PARTIAL | MA Rating (composite) but NOT individual SMA/EMA values |
| **MACD** | NO | Not in screener — need chart |
| **Bollinger Bands** | NO | Not in screener — need chart |
| **ADX** | NO | Not in screener — need chart |
| **Support/Resistance** | NO | Not in screener — need chart + Pine indicators |

### 1.4 Market Coverage (71 markets)

```
america, argentina, australia, austria, bahrain, bangladesh, belgium,
brazil, bulgaria, canada, chile, china, colombia, croatia, cyprus,
czech, denmark, egypt, estonia, finland, france, germany, greece,
hongkong, hungary, iceland, india, indonesia, ireland, israel, italy,
japan, kenya, kuwait, latvia, lithuania, luxembourg, malaysia, mexico,
morocco, netherlands, newzealand, nigeria, norway, pakistan, peru,
philippines, poland, portugal, qatar, romania, russia, ksa, serbia,
singapore, slovakia, slovenia, rsa, korea, spain, srilanka, sweden,
switzerland, taiwan, thailand, tunisia, turkey, uae, uk, venezuela, vietnam
```

**Market switching status**: Redux `screen/setMarkets` dispatch tested but didn't take effect on the data. The current market selector ("US" button) uses a different mechanism. **Needs further investigation** — likely requires a different action type or the screener app needs to re-initialize.

### 1.5 Filter Columns (16 — settable via Redux)

| Filter | Column ID | Type | Tested? |
|--------|-----------|------|---------|
| Index | Index | CheckboxGroup | Yes |
| Price | Price | Condition | Yes |
| Change % | Change | Condition | Yes |
| Market cap | MarketCap | Condition | Yes — confirmed working |
| P/E | PriceToEarnings | Condition | Yes — confirmed working |
| EPS dil growth | EpsDilutedGrowth | Condition | Untested |
| Div yield % | DividendsYield | Condition | Untested |
| Sector | Sector | CheckboxGroup | Untested |
| Analyst Rating | AnalystRating | CheckboxGroup | Untested |
| Perf % | Performance | Condition | Untested |
| Revenue growth | RevenueGrowth | Condition | Untested |
| PEG | PriceToEarningsToGrowth | Condition | Untested |
| ROE | ReturnOnEquity | Condition | Untested |
| Beta | Beta | Condition | Untested |
| Recent earnings | EarningsRecent | Date | Untested |
| Upcoming earnings | EarningsUpcoming | Date | Untested |

**NOT filterable** (display-only): Volume, Rel Volume, RSI, Momentum, AO, CCI, Stochastics, all margins, all balance sheet items.

---

## 2. Custom Scores From Screener Data Alone (No Chart Switching)

### 2.1 MOMENTUM SCORE — FULLY AVAILABLE

| Input | Screener Column | View |
|-------|----------------|------|
| Daily change % | Change % | Overview |
| Weekly return | Perf %1W | Performance |
| Monthly return | Perf %1M | Performance |
| 3-month return | Perf %3M | Performance |
| RSI (14) | RSI (14) | Technicals |
| Momentum (10) | Mom (10) | Technicals |
| Tech Rating | Tech Rating | Technicals |

**Calculation** (pure JS, no chart needed):
```
momentum = 0.15 * norm(change_1d) + 0.20 * norm(perf_1w) + 0.25 * norm(perf_1m)
         + 0.20 * rsi_score(rsi_14) + 0.10 * norm(momentum_10) + 0.10 * tech_rating_score
```
**Feasibility**: 100% — reads 2 views (Overview + Performance + Technicals)
**Speed**: ~6 seconds (3 view reads)

### 2.2 VALUE SCORE — FULLY AVAILABLE

| Input | Screener Column | View |
|-------|----------------|------|
| P/E | P/E | Overview or Valuation |
| PEG | PEGTTM | Valuation |
| P/S | P/S | Valuation |
| P/B | P/B | Valuation |
| EV/EBITDA | EV / EBITDATTM | Valuation |
| EPS growth | EPS dil growthTTM YoY | Overview |
| Dividend yield | Div yield %TTM | Overview |
| ROE | ROETTM | Profitability |
| Net margin | Net marginTTM | Profitability |

**Calculation**:
```
value = 0.25 * pe_score(pe, sector_avg) + 0.15 * peg_score(peg)
      + 0.15 * pb_score(pb) + 0.15 * ev_ebitda_score
      + 0.15 * eps_growth_score + 0.15 * quality_score(roe, net_margin)
```
**Feasibility**: 100% — reads 3 views (Overview + Valuation + Profitability)
**Speed**: ~6 seconds

### 2.3 VOLUME ANOMALY — FULLY AVAILABLE

| Input | Screener Column | View |
|-------|----------------|------|
| Relative Volume | Rel Volume | Overview |
| Volume | Volume | Overview |
| Change % | Change % | Overview |

**Calculation**:
```
volume_anomaly = rel_volume * (1 + abs(change_pct) / 5)
// rel_volume > 2.0 = unusual, > 5.0 = extreme
```
**Feasibility**: 100% — single Overview read
**Speed**: ~2 seconds

### 2.4 TREND STRENGTH — PARTIALLY AVAILABLE

| Input | Available? | Source |
|-------|-----------|--------|
| MA Rating (composite) | YES | Technicals view |
| Tech Rating (composite) | YES | Technicals view |
| Price vs SMA 20/50/200 | NO — only composite rating | Need chart |
| ADX | NO | Need chart |
| Multi-timeframe returns | YES | Performance view |
| Volatility | YES | Performance view |

**Calculation** (screener-only approximation):
```
trend = 0.30 * ma_rating_score + 0.25 * multi_tf_alignment(perf_1w, perf_1m, perf_3m)
      + 0.25 * tech_rating_score + 0.20 * inverse(volatility)
```
**Feasibility**: ~75% — good proxy without individual MA values
**Speed**: ~4 seconds (2 view reads)

### 2.5 BREAKOUT SCORE — PARTIALLY AVAILABLE

| Input | Available? | Source |
|-------|-----------|--------|
| 52-week high proximity | NO | Need chart OHLCV |
| Daily change % | YES | Overview |
| Volume surge | YES | Rel Volume in Overview |
| Volatility | YES | Performance view |
| Pattern detection | PARTIAL | Pattern column in Technicals (often empty) |

**Calculation** (screener approximation):
```
breakout_proxy = change_pct_score * rel_volume_score * (1 / volatility_score)
// High change + high volume + low prior volatility = likely breakout
```
**Feasibility**: ~60% — missing 52-week high proximity (the key signal)
**Speed**: ~4 seconds

### 2.6 FEAR/GREED SCORE — PARTIALLY AVAILABLE

| Input | Available? | Source |
|-------|-----------|--------|
| Price vs EMA | PARTIAL | MA Rating composite only |
| Rate of change | YES | Perf %1W, %1M, %3M |
| Volume flow | YES | Rel Volume |
| RSI | YES | Technicals |
| VIX correlation | NO | VIX is a separate symbol, not in screener |
| Put/Call ratio | NO | Not in screener |
| Junk bond demand | NO | Not in screener |
| Market breadth | NO | Not directly in screener |

**Calculation** (market-level, from aggregate screener data):
```
// Aggregate across all 100 stocks:
avg_rsi = mean(all RSI values)
pct_above_ma = count(MA Rating == "Buy" or "Strong buy") / total
avg_momentum = mean(all Perf %1M values)
volume_surge = mean(all Rel Volume values)

fear_greed = 0.30 * rsi_to_fg(avg_rsi) + 0.25 * ma_breadth(pct_above_ma)
           + 0.25 * momentum_to_fg(avg_momentum) + 0.20 * volume_to_fg(volume_surge)
```
**Feasibility**: ~50% — decent market-level proxy, missing VIX and options data
**Speed**: ~4 seconds (aggregate from existing reads)

### 2.7 COMPOSITE SCORE — THE RICHEST PURE-SCREENER SCAN

Merge all the above into one composite:
```
composite = 0.25 * momentum_score + 0.25 * value_score
          + 0.20 * trend_score    + 0.15 * volume_anomaly_score
          + 0.15 * quality_score(roe, margins, growth)
```

**Data needed**: 3 view reads (Overview + Technicals + Performance) OR 4 views (+Valuation for full value score)
**Speed**: ~8 seconds for full composite on 100 stocks
**Richness**: ~85% of what you'd get with chart-side analysis

---

## 3. Architecture for Bulk Processing

### Option A: Pure Screener Multi-View Merge

```
screener_sort(MarketCap, desc) → read Overview(100) → 2s
  → switch to Technicals → read(100) → 2s
  → switch to Performance → read(100) → 2s
  → switch to Valuation → read(100) → 2s
  → merge all 4 datasets on Symbol → ~85 fields per stock
  → compute momentum_score, value_score, trend_score, volume_anomaly
  → rank by composite_score
  → output: 100 stocks ranked in ~8 seconds
```

**For >100 stocks**: Run in batches with market cap filters:
- Batch 1: Market cap > 100B → read 4 views → 100 mega caps
- Batch 2: Market cap 10B-100B → read 4 views → 100 large caps
- Batch 3: Market cap 1B-10B → read 4 views → 100 mid caps
- Total: 300 stocks in ~24 seconds

| Metric | Value |
|--------|-------|
| Speed | **8s per 100 stocks, 24s per 300** |
| Fields per stock | ~85 |
| Signal richness | Good for fundamentals + momentum, limited technicals |
| Missing | Individual MA values, MACD, BBands, ADX, 52wk high, candle patterns |
| Reliability | High — all Redux/React API, no DOM clicks |

### Option B: Screener Pre-Filter → Chart Deep-Dive

```
Option A pipeline → 100 stocks ranked → take top 20
  → for each of top 20:
      chart_set_symbol (7s avg)
      data_get_study_values → RSI, MACD, BBands, EMAs (3ms)
      data_get_ohlcv(50 bars) → breakout, candle pattern, 52wk high (2ms)
      → compute: breakout_score, candle_pattern, ema_alignment, macd_signal
  → merge chart analysis with screener composite
  → final ranking with full signal depth
```

| Metric | Value |
|--------|-------|
| Speed | **8s screener + 140s chart (20 stocks) = ~2.5 minutes** |
| Fields per stock | ~85 (screener) + ~20 (chart) = ~105 |
| Signal richness | Full — includes everything |
| Missing | Nothing meaningful |
| Reliability | Medium — symbol switch timing is variable |

### Option C: Multi-View Merge + Selective Deep-Dive (RECOMMENDED)

```
Phase 1 (8s): Read 4 screener views, merge, compute preliminary composite
Phase 2 (instant): Client-side filter to top 10 candidates by composite
Phase 3 (70s): Deep chart analysis on only 10 stocks
Phase 4 (instant): Final ranking with full signals

Total: ~78 seconds for 100 stocks with 10 deep-dived
```

| Metric | Value |
|--------|-------|
| Speed | **~80 seconds** (8s screener + 70s chart for top 10) |
| Fields per stock | ~85 (all) + ~105 (top 10) |
| Signal richness | Maximum where it matters |
| Missing | Nothing for top candidates |
| Reliability | High — screener phase is reliable, chart phase limited to 10 |

### Comparison

| | Option A | Option B | Option C |
|-|----------|----------|----------|
| **Speed** | 8s | 150s | 80s |
| **Stocks scanned** | 100 | 100 (20 deep) | 100 (10 deep) |
| **Signal depth** | Good | Full | Full (top 10) |
| **Build effort** | Low | Medium | Medium |
| **Value/Time ratio** | **Highest** | Lowest | High |

---

## 4. Live Test Results Summary

### Test A: US Stocks Overview ✅
- **Rows**: 100
- **Fields**: 12 (Symbol, Price, Change%, Volume, Rel Volume, Market cap, P/E, EPS dil, EPS growth, Div yield, Sector, Analyst Rating)
- **Data quality**: Clean, parseable strings

### Test B: Technicals View ✅
- **Rows**: 100
- **Fields**: 11 (Symbol, Tech Rating, MA Rating, Os Rating, RSI(14), Mom(10), AO, CCI(20), Stoch %K, Stoch %D, Pattern)
- **RSI and technical indicators available in BULK** — no chart switching needed

### Test C: Performance View ✅
- **Rows**: 100
- **Fields**: 14 (Symbol, Price, Change%, Perf 1W/1M/3M/6M/YTD/1Y/5Y/10Y/AllTime, Volatility 1W/1M)
- **Multi-timeframe momentum data available in bulk**

### Test D: Crypto Market ❌ NOT TESTED
- Market switching via Redux `screen/setMarkets` dispatch didn't change the data
- The "US" market selector button needs CDP click interaction or different action type
- **Status**: Blocked — needs further investigation of the market selector component

### Test E: ASX/Australia ❌ NOT TESTED
- Same blocker as crypto — market switching not yet working
- Redux state has `markets: ["america"]` and the dispatch to change it didn't take effect
- **Status**: Blocked

### Test F: Volume Filter + Read ⚠️ PARTIAL
- Volume is NOT a filter column (only 16 filter columns exist)
- Volume IS a display column in Overview
- **Workaround**: Sort by Volume desc, read top 100 — effectively a Volume filter
- Rel Volume IS displayed and can be used for anomaly detection

### Additional Views Tested ✅
- **Valuation**: 14 fields including P/E, PEG, P/S, P/B, EV/EBITDA
- **Profitability**: 11 fields including all margins, ROA, ROE, ROIC
- **Income Statement**: 10 fields including Revenue, Revenue growth, Net Income, EBITDA
- **Balance Sheet**: 13 fields including Total Assets, Cash, Debt, Equity, Current Ratio

---

## 5. Build Priority

### What's the Richest Bulk Scan Using ONLY Screener Data?

**Multi-view composite scan** reading 4 views (Overview + Technicals + Performance + Valuation) gives **~50 unique fields per stock for 100 stocks in 8 seconds**. This covers:
- Momentum (RSI, multi-timeframe returns, tech rating)
- Value (P/E, PEG, P/B, EV/EBITDA)
- Quality (ROE, margins via Profitability view)
- Volume anomaly (Rel Volume)
- Analyst consensus

### What Requires Chart Switching?

| Signal | Why Chart Is Needed | Worth It? |
|--------|--------------------|-----------|
| Individual EMA values (21/50/200) | Screener only has composite MA Rating | Maybe — MA Rating is a decent proxy |
| MACD histogram/signal | Not in screener at all | Yes — for divergence detection |
| Bollinger Band width/position | Not in screener | No — CCI and volatility are proxies |
| 52-week high proximity | Need OHLCV bars | Yes — key breakout signal |
| Candle patterns | Need last 3-5 bars | Yes — for entry timing |
| ADX (trend strength) | Not in screener | No — MA Rating + momentum are proxies |
| Support/resistance zones | Need Pine indicator data | No — only for final confirmation |

**Verdict**: Chart switching is worth it for **top 10-20 candidates only** to get MACD, 52wk high, and candle patterns. For the other 80-90 stocks, screener data alone gives 85%+ of the signal.

### Fastest Path to 500-Stock Custom Composite

```
Step 1: Build value parser (strings → numbers)                    — 1 hour
Step 2: Build multi-view reader (4 views, merge on Symbol)        — 1 hour
Step 3: Build scoring engine (momentum, value, trend, volume)     — 2 hours
Step 4: Build batch reader (market cap bands for >100 stocks)     — 1 hour
Step 5: Build output formatter (JSON + Markdown table)            — 30 min

Total: ~5.5 hours for 500-stock bulk scanner with custom composite scoring
Speed: ~24 seconds per 300 stocks, ~40 seconds per 500 stocks
```

### Phase 1 Build Order

1. **`parseScreenerValue(str)`** — "4.31 T USD" → 4310000000000, "+66.75%" → 66.75, "Strong buy" → 5
2. **`mergeScreenerViews(overview, technicals, performance, valuation)`** — join on Symbol
3. **`scoreMomentum(stock)`**, **`scoreValue(stock)`**, **`scoreTrend(stock)`**, **`scoreVolumeAnomaly(stock)`**
4. **`compositeScore(stock, weights)`** — weighted sum with configurable weights
5. **`bulkScan({ market_cap_min, max_results, weights })`** — full pipeline
6. **MCP tool: `scanner_bulk_scan`** — one-command scan with presets

### What Can Be a Skill vs MCP Tool?

| Component | Skill or Tool? | Why |
|-----------|---------------|-----|
| `scanner_bulk_scan` | **MCP tool** | Structured input/output, reusable by any client |
| `scanner_deep_dive` | **MCP tool** | Same — structured per-symbol deep analysis |
| `/scan` | **Skill** | Orchestrates bulk_scan → deep_dive → format report |
| `/scan-daily` | **Skill** | Scheduled daily scan with change detection |
| Value parser | **Internal module** | Used by tools, not exposed directly |
| Scoring engine | **Internal module** | Configurable but not a standalone tool |
