# Advanced Opportunity Scanner — Technical Specification

**Author**: Claude + Kieran | **Date**: 2026-04-04 | **Status**: DESIGN PHASE

---

## Section A — What We Have

### A1. Screener Fields (per stock, per view)

**Overview** (default):
| Field | Type | Example | Notes |
|-------|------|---------|-------|
| Symbol | string | NVDA | Clean ticker |
| Price | string | 177.39 USD | Includes currency |
| Change % | string | +0.93% | Unicode minus (−) not ASCII |
| Volume | string | 143.14 M | Human-readable with suffix |
| Rel Volume | string | 0.77 | Relative to average |
| Market cap | string | 4.31 T USD | With suffix |
| P/E | string | 36.19 | "—" if unavailable |
| EPS dilTTM | string | 4.90 USD | Trailing 12 months |
| EPS dil growthTTM YoY | string | +66.75% | Year over year |
| Div yield %TTM | string | 0.02% | "—" if none |
| Sector | string | Electronic technology | TradingView sector names |
| Analyst Rating | string | Strong buy | Strong buy/Buy/Neutral/Sell/Strong sell/No rating |

**Technicals**:
Symbol, Tech Rating, MA Rating, Os Rating, RSI (14), Mom (10), AO, CCI (20), Stoch %K, Stoch %D, Pattern

**Performance**:
Symbol, Perf % (various timeframes), Volatility, ATR, Avg Volume, etc.

**Valuation**:
Symbol, P/E, Forward P/E, PEG, P/S, P/B, EV/EBITDA, etc.

**Dividends**:
Symbol, Div yield %, Annual Div, Payout Ratio, Ex-Div Date, etc.

**Profitability**:
Symbol, Gross Margin, Operating Margin, Net Margin, ROA, ROE, ROIC, etc.

**Also available**: Income Statement, Balance Sheet, Cash Flow, Per Share, Extended Hours

### A2. Screener Filter Columns (16 built-in)

| Filter | Type | Operations |
|--------|------|------------|
| Index | CheckboxGroup | Multi-select (S&P 500, DJIA, etc.) |
| Price | Condition | above/below/between |
| Change % | Condition | above/below/between |
| Market cap | Condition | above/below/between |
| P/E | Condition | above/below/between |
| EPS dil growth | Condition | above/below |
| Div yield % | Condition | above/below |
| Sector | CheckboxGroup | Multi-select (21 sectors) |
| Analyst Rating | CheckboxGroup | Multi-select |
| Perf % | Condition | above/below |
| Revenue growth | Condition | above/below |
| PEG | Condition | above/below |
| ROE | Condition | above/below |
| Beta | Condition | above/below |
| Recent earnings date | Date | Date range |
| Upcoming earnings date | Date | Date range |

### A3. Chart Data Tools (per symbol, after switching)

| Tool | Returns | Latency | Notes |
|------|---------|---------|-------|
| `quote_get` | OHLCV, last, volume, bid, ask | ~7ms | Single bar |
| `data_get_study_values` | All visible indicator readings | ~3ms | RSI, MACD, BB, EMAs — whatever's on chart |
| `data_get_ohlcv` (summary) | High/low/range/change/avg vol/last 5 bars | ~2ms | 100-bar stats |
| `data_get_ohlcv` (full) | Up to 500 bars of OHLCV | ~2ms | Raw bar data |
| `data_get_pine_lines` | Price levels from custom indicators | ~10ms | Requires Pine indicators visible |
| `data_get_pine_labels` | Text annotations with prices | ~10ms | Max 50 per study |
| `data_get_pine_tables` | Table data from Pine indicators | ~10ms | Session stats, dashboards |
| `data_get_pine_boxes` | Price zones {high, low} | ~10ms | Support/resistance zones |

### A4. Timing Constraints (Measured)

| Operation | Best Case | Worst Case | Average | Notes |
|-----------|-----------|------------|---------|-------|
| `chart_set_symbol` | 1,593ms | 10,873ms | 7,139ms | Huge variance by exchange |
| `quote_get` | 5ms | 8ms | 7ms | After symbol is set |
| `data_get_study_values` | 2ms | 4ms | 3ms | After symbol is set |
| `data_get_ohlcv` (summary) | 1ms | 2ms | 2ms | After symbol is set |
| `screener_read` (100 rows) | ~500ms | ~800ms | ~600ms | From screener CDP target |
| `screener_sort` | ~1,500ms | ~2,000ms | ~1,700ms | React fiber setSort |
| `screener_set_filter` | ~2,000ms | ~3,000ms | ~2,500ms | Redux dispatch + refetch |
| `batch_run` (per symbol) | ~2,000ms | ~12,000ms | ~7,000ms | Includes delay_ms=2000 |

**Critical bottleneck**: Symbol switching is 1.6-10.9 seconds. Data reads are <10ms. Scanning 50 symbols = **1.3 to 9 minutes**. Scanning 100 symbols = **2.7 to 18 minutes**.

### A5. Known Limitations

| Limitation | Impact | Workaround |
|------------|--------|------------|
| Screener shows max 100 rows per page | Can't scan >100 stocks without page scrolling | Use filters to narrow to <100 before reading |
| Symbol switch is 1.6-10.9s | Sequential scanning is slow | Pre-filter with screener, only deep-scan top candidates |
| No multi-symbol parallel reads | Can't read 5 charts simultaneously | Use pane_set_layout for 2-4 charts, but each still needs symbol switch |
| Screener data is string-formatted | "4.31 T USD" needs parsing to number | Build parser utility |
| Study values only show what's on chart | Need RSI/MACD/BBands added as indicators first | Pre-configure chart with needed indicators |
| Screener view switching broken | switchView uses chart page DOM, but screener is separate CDP target | Fix to use screener target, or read all views from screener target |
| No direct access to TradingView backend API | Can't query scanner.tradingview.com directly | Must use the screener UI as intermediary |
| Volume data in screener is daily only | No intraday volume anomaly detection from screener | Switch to chart for intraday volume analysis |

---

## Section B — What We Could Build

### B1. Volume Anomaly Scanner

**Signal**: Stocks with unusual volume relative to their average (Rel Volume > 2.0)

**Tools chained**:
1. `screener_set_filter("Volume", ">", threshold)` — pre-filter
2. `screener_sort("Rel Volume", "desc")` — highest relative volume first
3. `screener_read(100)` — get candidates
4. **For each top N**: `chart_set_symbol` → `data_get_ohlcv(summary)` → `data_get_study_values` → score

**New code needed**: Value parser (string → number), scoring function, result ranker
**Already exists**: All screener + chart tools
**Estimated time**: Pre-filter 4s + read 0.6s + (N symbols × 7s each)
- Top 10: ~74s (1.2 min)
- Top 20: ~144s (2.4 min)

**Data flow**:
```
screener_set_filter(Rel Volume > 2) → screener_sort(Volume, desc) → screener_read(20)
  → for each symbol:
      chart_set_symbol → data_get_ohlcv(summary) → data_get_study_values
      → compute: volume_ratio, price_vs_range, RSI_context
      → score → rank
  → output: sorted opportunity list
```

**Bottleneck**: Symbol switching (7s avg per symbol)

---

### B2. Breakout Scanner

**Signal**: Price breaking above N-day high with volume confirmation

**Tools chained**:
1. `screener_set_filter("Change %", ">", 2)` — stocks up >2% today
2. `screener_sort("Change %", "desc")` — biggest movers first
3. `screener_read(50)` — candidates
4. **For each**: `chart_set_symbol` → `data_get_ohlcv(count: 50)` → compute N-day high breakout

**New code needed**: Breakout detection (compare current close to max of last N highs), volume confirmation logic
**Already exists**: OHLCV data, study values
**Estimated time**: Pre-filter 4s + read 0.6s + (N × 7s)
- Top 10: ~74s
- Top 20: ~144s

**Data flow**:
```
screener_set_filter(Change > 2%) → screener_read(50) → parse →
  for each:
    chart_set_symbol → data_get_ohlcv(50 bars)
    → is_close > max(highs[1..20])? → volume > 1.5x avg? → breakout_confirmed
    → score: (close - prev_high) / ATR * volume_ratio
  → rank by score
```

---

### B3. Oversold Bounce Scanner

**Signal**: RSI < 30 with bullish reversal candle, ideally at support

**Tools chained**:
1. `screener_read(view: "technicals")` — get RSI, Stoch, CCI for all stocks
2. Filter client-side: RSI < 30 AND Stoch %K > Stoch %D (bullish cross)
3. **For each**: `chart_set_symbol` → `data_get_ohlcv` → check for hammer/engulfing candle

**New code needed**: Candle pattern detection (hammer, bullish engulfing, doji), support zone detection
**Already exists**: Technicals view has RSI/Stoch/CCI, OHLCV data available
**Estimated time**: Screener read 0.6s + client filter instant + (N × 7s for deep analysis)

**Data flow**:
```
screener_read(technicals, 100) → client_filter(RSI < 30, Stoch bullish_cross)
  → for each candidate:
      chart_set_symbol → data_get_ohlcv(20 bars)
      → detect_candle_pattern(last 3 bars)
      → check_support_zone(pine_lines if available)
      → score: RSI_depth * candle_quality * support_proximity
  → rank
```

---

### B4. Relative Strength Scanner

**Signal**: Stocks outperforming their sector/benchmark over a lookback period

**Tools chained**:
1. `screener_read(view: "performance")` — get multi-timeframe performance
2. Group by sector, compute sector averages
3. Identify stocks significantly above sector average
4. **For each top N**: `chart_set_symbol` → `data_get_ohlcv` → compute RS line vs SPY

**New code needed**: Sector grouping, relative strength calculation, RS line computation
**Already exists**: Performance view, OHLCV data
**Estimated time**: Read 0.6s + compute instant + (N × 7s for RS line)

**Data flow**:
```
screener_read(performance, 100) → group_by_sector → compute_sector_avg
  → for each: rs_score = (stock_perf - sector_avg) / sector_stdev
  → top 20 → for each:
      chart_set_symbol("SPY") → get_benchmark_ohlcv
      chart_set_symbol(stock) → get_stock_ohlcv
      → RS_line = stock_close / benchmark_close over time
      → is_RS_line_rising? is_RS_at_new_high?
  → rank by RS_score * RS_trend
```

---

### B5. Gap Detection Scanner

**Signal**: Stocks gapping up/down from previous close

**Tools chained**:
1. `screener_sort("Change %", "desc")` or `"asc"` — biggest gaps
2. `screener_read(50)` — candidates
3. **For each**: `chart_set_symbol` → `data_get_ohlcv(5 bars)` → check open vs prev close

**New code needed**: Gap classification (full gap, partial gap, island reversal), gap fill probability
**Already exists**: OHLCV, screener
**Estimated time**: 4s + read 0.6s + (N × 7s)

**Data flow**:
```
screener_sort(Change%, desc) → screener_read(50) →
  for each:
    chart_set_symbol → data_get_ohlcv(5)
    → gap_size = abs(today_open - yesterday_close) / yesterday_close
    → gap_type: full_up / full_down / partial_up / partial_down
    → gap_filled? = (gap_up AND today_low < yesterday_close)
    → score: gap_size * volume_ratio * (1 if unfilled else 0.5)
  → rank
```

---

### B6. Composite Scoring Scanner

**Signal**: Multi-factor scoring combining fundamentals + technicals + momentum

**Tools chained**:
1. `screener_set_filter` (Market cap > 10B, P/E > 0) — quality universe
2. `screener_sort("Market cap", "desc")` → `screener_read(100)` — fundamentals
3. Switch to Technicals view → read RSI/MA Rating/Tech Rating
4. **For each top 30**: Deep chart analysis
5. Composite score = weighted sum of all factors

**New code needed**: Scoring engine, factor weights, normalization
**Already exists**: All screener views, chart data
**Estimated time**: Filter 2.5s + sort 1.7s + read (2 views) 1.2s + (30 × 7s) = ~215s (3.6 min)

**Data flow**:
```
screener_set_filter(MarketCap > 10B) → screener_sort(MarketCap, desc) → screener_read(100)
  → client_parse: P/E, EPS_growth, Div_yield, Analyst_Rating → fundamental_scores
screener_read(technicals, 100)
  → client_parse: RSI, MA_Rating, Tech_Rating → technical_scores
merge on Symbol → composite_score = 0.4*fundamental + 0.3*technical + 0.3*momentum
  → top 30 → for each:
      chart_set_symbol → data_get_ohlcv(100) → data_get_study_values
      → trend_score, volume_score, support_proximity
      → final_score = composite * chart_confirmation
  → ranked output with reasoning
```

---

## Section C — Architecture Options

### Option 1: Pure Screener-Side (Fast, Limited)

**How**: Use only screener_set_filter + screener_sort + screener_read. All filtering and scoring happens on data the screener already provides. No chart switching.

**Capabilities**:
- Filter by any of 16 filter columns
- Sort by any visible column
- Read up to 100 rows per query
- Client-side scoring on screener data only

**Cannot do**: Intraday volume patterns, candle pattern detection, custom indicator readings, multi-bar analysis, support/resistance from Pine indicators

**Speed**: 2-6 seconds total per scan (filter + sort + read)
**Build effort**: Low — mostly parsing + scoring logic
**Best for**: Quick fundamental screens, sector scans, earnings plays

### Option 2: Screener Pre-Filter → Chart Deep Analysis (Rich, Slow)

**How**: Use screener to narrow to top N candidates (20-50), then switch each symbol on the chart for deep technical analysis with OHLCV bars, indicator values, Pine data.

**Capabilities**: Everything in Option 1, PLUS:
- Multi-bar candle patterns (hammer, engulfing, doji)
- N-day breakout/breakdown detection
- Volume profile analysis
- RSI/MACD/BB divergences
- Custom Pine indicator data (support/resistance zones, order flow)
- Fibonacci level proximity
- Trend line analysis

**Cannot do**: Intraday analysis unless chart is on intraday timeframe

**Speed**: Pre-filter 4-6s + (N candidates × 7s) = **2.5-12 minutes for 20-100 stocks**
**Build effort**: Medium — candle detection, scoring, result formatting
**Best for**: End-of-day analysis, swing trade setups, detailed opportunity reports

### Option 3: Batch Approach (Parallel-ish, Structured)

**How**: Use `batch_run` to iterate symbols with a standardized action (screenshot or OHLCV). Pre-configure chart with all needed indicators. Collect all data in one pass.

**Capabilities**: Similar to Option 2 but more structured

**Speed**: batch_run uses 2000ms delay between symbols. 50 symbols = ~350s (5.8 min)

**Limitation**: batch_run currently only supports screenshot, get_ohlcv, and get_strategy_results actions. Would need extension for study_values, Pine data.

**Build effort**: Medium — extend batch_run with new actions, build post-processing
**Best for**: Systematic daily scans with consistent indicator setup

### Comparison Matrix

| Criteria | Option 1 | Option 2 | Option 3 |
|----------|----------|----------|----------|
| **Speed (20 stocks)** | 4s | 2.5 min | 2.3 min |
| **Speed (100 stocks)** | 4s | 12 min | 11.7 min |
| **Signal richness** | Low | High | High |
| **Reliability** | High | Medium (symbol switch variance) | Medium |
| **Build effort** | Low | Medium | Medium |
| **Maintenance** | Low | Low | Low |
| **Best use case** | Quick screens | Deep analysis | Daily routine scans |

**Recommendation**: Build Option 1 first (fast screens), then extend with Option 2's deep analysis for top candidates. This gives the "narrow then deepen" pattern that maximizes signal quality while minimizing scan time.

---

## Section D — CANETOAD Integration Points

### D1. What CANETOAD Would Need to Provide

CANETOAD is a geological data system. For integration with the opportunity scanner, it would need to provide a structured data feed with:

**Data contract (per stock/project):**
```json
{
  "ticker": "BHP",                       // ASX/NYSE ticker
  "project_name": "Olympic Dam",         // Optional
  "geo_score": 0.85,                     // 0-1 composite geological score
  "resource_estimate_mt": 9600,          // Million tonnes
  "grade": { "cu_pct": 1.2, "au_gpt": 0.4 },  // Key commodities + grades
  "stage": "production",                 // exploration|development|production
  "permits_status": "approved",          // pending|approved|rejected
  "last_drill_results": {
    "date": "2026-03-15",
    "highlight": "42m @ 2.1% Cu from 380m",
    "significance": "high"               // low|medium|high|exceptional
  },
  "commodity_exposure": ["copper", "gold", "uranium"],
  "jurisdiction_risk": 0.15,             // 0 (safe) to 1 (high risk)
  "updated_at": "2026-04-04T00:00:00Z"
}
```

### D2. Integration Architecture

```
CANETOAD API/Webhook/File
        │
        ▼
  ┌─────────────┐
  │ geo_data.json│  ← Flat file or REST endpoint
  │ (per ticker) │
  └──────┬──────┘
         │
         ▼
  ┌──────────────────┐
  │ Scanner Engine    │
  │                   │
  │  screener_read()  │──→ fundamental_score
  │  chart_data()     │──→ technical_score
  │  geo_data_load()  │──→ geological_score
  │                   │
  │  composite =      │
  │    w1 * fund +    │
  │    w2 * tech +    │
  │    w3 * geo       │
  └──────────────────┘
         │
         ▼
   Ranked Opportunity List
   (with geological context)
```

### D3. Scoring Integration

**Geological score factors**:
| Factor | Weight | Logic |
|--------|--------|-------|
| Resource quality | 0.3 | grade × tonnage normalized to sector |
| Stage progression | 0.2 | exploration=0.3, development=0.6, production=1.0 |
| Recent drill results | 0.2 | significance: low=0.2, medium=0.5, high=0.8, exceptional=1.0 |
| Permit status | 0.15 | pending=0.5, approved=1.0, rejected=0.0 |
| Jurisdiction risk | 0.15 | 1 - jurisdiction_risk |

**Composite scanner score**:
```
final_score = 0.35 * fundamental_score   // From screener: P/E, EPS growth, analyst rating
            + 0.30 * technical_score     // From chart: RSI, trend, volume, breakout
            + 0.20 * geological_score    // From CANETOAD
            + 0.15 * catalyst_score      // Upcoming: earnings date, drill results, permits
```

### D4. Delivery Format Options

| Method | Pros | Cons | Best For |
|--------|------|------|----------|
| JSON file (geo_data.json) | Simple, no infra | Manual updates | MVP/prototype |
| REST API endpoint | Real-time, cacheable | Needs server | Production |
| Webhook push | Event-driven, fresh data | Needs listener | Drill result alerts |
| SQLite DB | Queryable, structured | Local only | Desktop workflow |

**Recommendation for MVP**: JSON file at `~/.tradingview-mcp/canetoad/geo_data.json`, loaded at scan time. Upgrade to REST API when CANETOAD has a server.

---

## Section E — Priority Build Order

### Phase 1: Screener Value Parser + Quick Scan (2-3 hours)

**What**: Utility to parse screener strings to numbers ("4.31 T USD" → 4310000000000, "+66.75%" → 66.75) plus a `scanner_quick` tool that runs pre-configured screens.

**Deliverables**:
- `src/core/scanner.js` — parser + scoring engine
- `screener_scan` MCP tool — accepts scan preset name, returns ranked results
- Pre-built presets: "undervalued_large_cap", "high_momentum", "oversold_bounce", "dividend_value", "volume_anomaly"

**Build as**: New MCP tool + CLI command
**Depends on**: Existing screener tools only
**Speed**: 4-6 seconds per scan
**Value**: Immediate — replaces manual screener clicking with one command

### Phase 2: Chart Deep Analysis Functions (3-4 hours)

**What**: Build the chart-side analysis functions that take OHLCV data and compute signals: breakout detection, candle patterns, trend analysis, volume anomaly scoring.

**Deliverables**:
- `src/core/analysis.js` — pure functions (no CDP dependency):
  - `detectBreakout(bars, lookback)` → { breakout: bool, level, strength }
  - `detectCandlePattern(bars)` → { pattern: "hammer"|"engulfing"|..., quality }
  - `computeTrendScore(bars)` → { trend: "up"|"down"|"sideways", strength, ema_alignment }
  - `computeVolumeAnomaly(bars)` → { ratio, zscore, anomaly: bool }
  - `computeRSIDivergence(bars, rsi_values)` → { divergence: "bullish"|"bearish"|null }

**Build as**: Pure JS module (testable without TradingView)
**Depends on**: Nothing (pure data processing)
**Value**: High — these are the building blocks for all scan types

### Phase 3: Deep Scanner Pipeline (2-3 hours)

**What**: Connect Phase 1 (screener pre-filter) → Phase 2 (chart analysis) into a single pipeline. Screener narrows candidates, chart deepens analysis.

**Deliverables**:
- `scanner_deep` MCP tool — accepts scan type + parameters
- Workflow: screener filter → sort → read → for each top N → chart switch → analyze → score → rank
- Progress reporting (callback or streaming)
- Result format: ranked list with per-stock reasoning

**Build as**: MCP tool + skill
**Depends on**: Phase 1 + Phase 2
**Speed**: 2-12 minutes depending on N
**Value**: Very high — this is the core product

### Phase 4: CANETOAD Integration (1-2 hours)

**What**: Load geological data from JSON/API, merge with scanner results, compute composite scores.

**Deliverables**:
- `src/core/canetoad.js` — data loader + geo scoring
- Merged output with geological context
- Support for geo_data.json file format

**Build as**: Module integrated into scanner pipeline
**Depends on**: Phase 3 + CANETOAD data format finalized
**Value**: High for mining/resource stocks

### Phase 5: Automation + Scheduling (1-2 hours)

**What**: Daily automated scans via skills/hooks, result persistence, change detection.

**Deliverables**:
- `/scanner` skill — runs configured daily scan
- Result history in `~/.tradingview-mcp/scans/YYYY-MM-DD.json`
- Change detection: "AAPL moved from Hold to Buy since yesterday"
- Alert integration: `alert_create` for top opportunities

**Build as**: Skill + session integration
**Depends on**: Phase 3
**Value**: Medium — convenience/automation layer

### Build Time Estimates

| Phase | Effort | Cumulative | Value |
|-------|--------|------------|-------|
| Phase 1: Quick Scan | 2-3 hrs | 2-3 hrs | Immediate useful scans |
| Phase 2: Analysis Functions | 3-4 hrs | 5-7 hrs | Rich signal library |
| Phase 3: Deep Scanner | 2-3 hrs | 7-10 hrs | Full pipeline |
| Phase 4: CANETOAD | 1-2 hrs | 8-12 hrs | Geo-enhanced scoring |
| Phase 5: Automation | 1-2 hrs | 9-14 hrs | Daily workflow |

---

## Key Decisions Needed

### Decision 1: Scan Universe
**Question**: What's the default stock universe?
- A) US stocks only (current screener default) — simplest
- B) US + ASX (for CANETOAD mining stocks) — needs market switching
- C) Crypto screener (separate TradingView screener) — different UI
- D) Custom watchlist only — most controlled

### Decision 2: Indicator Setup
**Question**: What indicators should be pre-loaded on the chart for deep analysis?
- The chart needs RSI, MACD, BBands, EMA 21/50/200 to read their values via `data_get_study_values`
- More indicators = richer signals but slower rendering
- **Suggestion**: Pre-configure a "Scanner" layout with standard indicators, switch to it before scanning

### Decision 3: Scan Depth vs Speed
**Question**: How many stocks should get deep chart analysis?
- Top 10: ~1.2 minutes — fast, misses some opportunities
- Top 20: ~2.4 minutes — balanced
- Top 50: ~6 minutes — thorough but slow
- **Suggestion**: Default to top 20 with option to go deeper

### Decision 4: CANETOAD Data Format
**Question**: What delivery mechanism for geological data?
- A) JSON file (simplest, manual updates)
- B) REST API (real-time, needs server)
- C) CSV export from existing tools
- **Suggestion**: Start with JSON file, design for future API

### Decision 5: Output Format
**Question**: How should scan results be presented?
- A) JSON only (pipe to other tools)
- B) Markdown table (readable in terminal)
- C) HTML report (visual, shareable)
- D) TradingView drawings (mark levels on chart)
- **Suggestion**: JSON + Markdown summary by default, with optional chart marking

### Decision 6: Skill vs MCP Tool
**Question**: Should the scanner be an MCP tool or a Claude Code skill?
- **MCP tool**: Available to any MCP client, structured input/output
- **Skill**: Richer prompting, can use multiple tools in sequence, more flexible
- **Suggestion**: Core functions as MCP tools, orchestration as a skill (`/scan`)
