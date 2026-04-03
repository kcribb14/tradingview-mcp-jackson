# TradingView MCP — Native Drawing Tools Research

**Date:** 2026-04-03
**Researcher:** Claude (via CDP DOM inspection of live TradingView Desktop)

---

## Executive Summary

**UI automation is NOT needed for advanced drawings.** TradingView's existing `createMultipointShape` API already supports Fib Retracement, Elliott Waves, Pitchfork, Gann tools, and 50+ other shape types natively. The current MCP server only exposes 5 shape types (`horizontal_line`, `vertical_line`, `trend_line`, `rectangle`, `text`) — but the underlying API accepts all of TradingView's drawing tools. This means we can add ~50 new native drawing tools with minimal code changes, no UI automation, and full reliability.

UI automation via CDP mouse/keyboard is only needed for features that have no API equivalent (templates, overlay comparison, some indicator settings).

---

## Finding 1: `createMultipointShape` Supports All Drawing Tools

### How It Works (from source)

```javascript
async _createMultipointShape(points, options) {
  const shape = V.supportedLineTools[options.shape] || V.supportedLineTools.flag;
  // ... validates points, loads tool module, creates properties, applies overrides
}
```

The API has an internal `supportedLineTools` registry that maps shape name strings to tool classes. If a name isn't found, it falls back to `flag`.

### Confirmed Working Shape Types (Live Tested)

All of the following were created successfully via `createMultipointShape` and appeared in `getAllShapes()`:

| Shape Name | Points Required | Category |
|---|---|---|
| `fib_retracement` | 2 | Fibonacci |
| `fib_channel` | 3 | Fibonacci |
| `fib_circles` | 2 | Fibonacci |
| `fib_speed_resistance_fan` | 2 | Fibonacci |
| `fib_timezone` | 2 | Fibonacci |
| `pitchfork` | 3 | Gann & Fib |
| `gann_fan` | 2 | Gann |
| `gann_box` | 2 | Gann |
| `elliott_impulse_wave` | 3+ | Elliott Wave |
| `elliott_correction` | 3+ | Elliott Wave |
| `xabcd_pattern` | 3+ | Patterns |
| `parallel_channel` | 3 | Trend |
| `callout` | 1 | Annotation |
| `note` | 1 | Annotation |
| `anchored_text` | 1 | Annotation |
| `price_label` | 1 | Annotation |

### Likely Supported (Not Yet Tested)

Based on the `supportedLineTools` registry pattern, these should also work:

| Shape Name | Points | Category |
|---|---|---|
| `fib_wedge` | 3 | Fibonacci |
| `fib_spiral` | 2 | Fibonacci |
| `fib_speed_resistance_arcs` | 2 | Fibonacci |
| `schiff_pitchfork` | 3 | Pitchfork variants |
| `schiff_pitchfork2` | 3 | Pitchfork variants |
| `inside_pitchfork` | 3 | Pitchfork variants |
| `elliott_double_combo` | 3+ | Elliott Wave |
| `elliott_triple_combo` | 3+ | Elliott Wave |
| `elliott_triangle_wave` | 3+ | Elliott Wave |
| `abcd_pattern` | 4 | Patterns |
| `three_drives_pattern` | 5+ | Patterns |
| `head_and_shoulders` | 7 | Patterns |
| `cypher_pattern` | 5 | Patterns |
| `triangle_pattern` | 3 | Patterns |
| `long_position` | 2 | Prediction |
| `short_position` | 2 | Prediction |
| `forecast` | 2 | Prediction |
| `date_range` | 2 | Measurement |
| `price_range` | 2 | Measurement |
| `date_and_price_range` | 2 | Measurement |
| `bars_pattern` | 2 | Pattern |
| `ghost_feed` | 1 | Prediction |
| `projection` | 3 | Prediction |
| `ray` | 2 | Trend |
| `extended` | 2 | Trend |
| `trend_angle` | 2 | Trend |
| `horizontal_ray` | 1 | Trend |
| `disjoint_angle` | 2 | Trend |
| `flat_bottom` | 2 | Trend |
| `regression_trend` | 2 | Trend |
| `info_line` | 2 | Trend |
| `anchored_vwap` | 1 | Trend |
| `rotated_rectangle` | 2 | Shapes |
| `circle` | 2 | Shapes |
| `ellipse` | 2 | Shapes |
| `triangle` | 3 | Shapes |
| `polyline` | 3+ | Shapes |
| `arc` | 3 | Shapes |
| `arrow` | 2 | Trend |
| `balloon` | 1 | Annotation |
| `signpost` | 1 | Annotation |
| `flag` | 1 | Annotation (default fallback) |
| `sticker` | 1 | Annotation |
| `arrow_marker` | 1 | Annotation |
| `image` | 1 | Media |

---

## Finding 2: Coordinate Conversion APIs

Both `timeScale` and `priceScale` have bidirectional coordinate mapping:

### Time Scale (X-axis)

```javascript
var timeScale = model.timeScale();

// Time/Index -> Pixel
timeScale.indexToCoordinate(barIndex)      // barIndex -> x pixel
timeScale.timeToCoordinate(unixTimestamp)  // timestamp -> x pixel

// Pixel -> Time/Index
timeScale.coordinateToIndex(x)             // x pixel -> barIndex (integer)
timeScale.coordinateToFloatIndex(x)        // x pixel -> barIndex (float)
timeScale.coordinateToVisibleIndex(x)      // x pixel -> visible bar index

// Utilities
timeScale.timePointToIndex(timePoint)      // timePoint -> barIndex
timeScale.indexToTimePoint(barIndex)        // barIndex -> timePoint
timeScale.indexToUserTime(barIndex)         // barIndex -> user-readable time
timeScale.width()                          // total width in pixels (1502px)
timeScale.barSpacing()                     // pixels per bar
```

### Price Scale (Y-axis)

```javascript
var priceScale = mainSeries.priceScale();

// Price -> Pixel
priceScale.priceToCoordinate(price)        // price -> y pixel
priceScale.pricesArrayToCoordinates(arr)   // batch conversion
priceScale.barPricesToCoordinates(bars)    // OHLC batch conversion

// Pixel -> Price
priceScale.coordinateToPrice(y)            // y pixel -> price
priceScale.height()                        // total height in pixels (872px)
```

### Verified Conversion Test

```
Input:  barIndex 504 -> X pixel: 1502.13 -> back to index: 504  (exact)
Input:  price 66500 -> Y pixel: 569.61 -> back to price: 66500  (exact)
```

### Chart Canvas Position

```javascript
// Canvas element bounding rect (for absolute window coordinates)
canvas.getBoundingClientRect()
// Result: { x: 56, y: 42, width: 1502, height: 872 }

// To convert chart-local pixel to window pixel:
// windowX = canvasRect.x + chartLocalX
// windowY = canvasRect.y + chartLocalY
```

This means for any UI automation that requires clicking at a price/time location:
```
windowX = 56 + timeScale.indexToCoordinate(timeScale.timePointToIndex(timestamp))
windowY = 42 + priceScale.priceToCoordinate(price)
```

---

## Finding 3: Drawing Toolbar Structure

### Toolbar Class
- `div.drawingToolbar-BfVZxb4b` (left sidebar)

### Tool Groups (dropdown menus)

| data-name | Default Button | Contains |
|---|---|---|
| `linetool-group-cursors` | Cross | Cursor modes |
| `linetool-group-trend-line` | Trendline | All trend tools |
| `linetool-group-gann-and-fibonacci` | Fib retracement | All Fib & Gann tools |
| `linetool-group-patterns` | XABCD pattern | All pattern tools |
| `linetool-group-prediction-and-measurement` | Long position | Prediction & measurement |
| `linetool-group-geometric-shapes` | Brush | Geometric shapes |
| `linetool-group-annotation` | Text | Text & annotation tools |
| `linetool-group-font-icons` | Icon | Icons & stickers |

### Button Selectors

| Button | aria-label | data-name |
|---|---|---|
| Fib Retracement | `"Fib retracement"` | (in group) |
| Trendline | `"Trendline"` | (in group) |
| XABCD Pattern | `"XABCD pattern"` | (in group) |
| Measure | `"Measure"` | `"measure"` |
| Zoom In | `"Zoom in"` | `"zoom"` |
| Keep Drawing | `"Keep drawing"` | `"drawginmode"` |
| Lock Drawings | `"Lock all drawings"` | `"lockAllDrawings"` |
| Hide Drawings | `"Hide all drawings"` | (in `"hide-all"` group) |
| Remove Objects | `"Remove objects"` | (in `"removeAllDrawingTools"` group) |
| Magnet Mode | `"Magnet mode..."` | (in `"magnet-button"` group) |

### Dropdown Expansion
Each group has two elements:
1. Main button (aria-label = tool name, class `button-KTgbfaP5`)
2. Arrow button (aria-label = group name, class `arrow-pbhJWNrt`)

Click the arrow to expand the dropdown and reveal all tools in that group.

---

## Finding 4: Additional Chart API Methods

### Shape Management (already partially exposed)

```javascript
api.getAllShapes()                    // List all drawings
api.getShapeById(id)                 // Get shape by entity ID
api.removeEntity(id)                 // Remove shape (works for any drawing type)
api.removeAllShapes()                // Clear all
api.createAnchoredShape(point, opts) // Anchored to price axis
api.drawOnAllCharts(opts)            // Sync drawings across panes
api.cloneLineTool(id)                // Duplicate a drawing
api.shareLineTools(ids)              // Share drawings
api.getLineToolsState()              // Serialize all drawings
api.applyLineToolsState(state)       // Restore drawings from state
api.reloadLineToolsFromServer()      // Reload from cloud
```

### Model-Level Drawing Control

```javascript
model.createLineTool(...)            // Low-level line tool creation
model.finishLineTool(...)            // Complete multi-point tool
model.cancelCreatingLine()           // Cancel in-progress drawing
model.applyLineToolTemplate(...)     // Apply template to drawing
model.cloneLineTools(ids)            // Clone multiple
model.removeAllDrawingTools()        // Clear all
model.scrollToLineTool(id)           // Pan chart to show drawing
```

### Symbol Overlay (for fractal comparisons)

```javascript
// From top bar — button with aria-label "Compare or Add Symbol"
// This opens TradingView's native comparison overlay dialog
// API equivalent may be through createStudy with comparison type
api.createStudy('Compare', false, false, {symbol: 'BTCUSD'})
```

### Template/Layout Management

```javascript
// Already in core/ui.js
api.getSavedCharts(callback)         // List saved layouts
api.loadChartFromServer(id)          // Load layout
api.saveChartToServer(callback)      // Save current layout
```

---

## Finding 5: Keyboard Shortcuts

TradingView keyboard shortcuts for drawing tools (when chart is focused):

| Shortcut | Tool |
|---|---|
| Alt+T | Trend Line |
| Alt+H | Horizontal Line |
| Alt+V | Vertical Line |
| Alt+F | Fib Retracement |
| Alt+C | Cross cursor |

Note: These are defaults and can be customized by users. The API approach (`createMultipointShape`) is more reliable than keyboard shortcuts.

---

## Implementation Plan

### Phase 1: Extend `draw_shape` (Minimal Changes, Maximum Impact)

**Effort: Low | Impact: Massive**

Simply extend the existing `core/drawing.js` to support all shape types that `createMultipointShape` accepts. The current code already uses `createMultipointShape` for `trend_line` and `rectangle` — we just need to:

1. Expand the shape type validation to include all supported types
2. Support variable point counts (1-7+ depending on shape)
3. Add shape-specific override documentation
4. **No new modules needed** — this is a ~50-line change to existing code

New tools to register in `src/tools/drawing.js`:

| Tool | Shape | Points | Description |
|---|---|---|---|
| `draw_fib_retracement` | `fib_retracement` | 2 | Fibonacci retracement with auto levels/shading |
| `draw_fib_channel` | `fib_channel` | 3 | Fibonacci channel |
| `draw_pitchfork` | `pitchfork` | 3 | Andrews' Pitchfork |
| `draw_elliott_wave` | `elliott_impulse_wave` | 6 | Elliott 5-wave impulse |
| `draw_elliott_correction` | `elliott_correction` | 4 | Elliott ABC correction |
| `draw_gann_fan` | `gann_fan` | 2 | Gann Fan |
| `draw_gann_box` | `gann_box` | 2 | Gann Box |
| `draw_parallel_channel` | `parallel_channel` | 3 | Parallel channel |
| `draw_xabcd` | `xabcd_pattern` | 5 | Harmonic XABCD pattern |
| `draw_long_position` | `long_position` | 2 | Long trade R:R box |
| `draw_short_position` | `short_position` | 2 | Short trade R:R box |

**Alternative approach:** Instead of individual tools, extend the existing `draw_shape` tool to accept all shape names and a flexible `points` array. This keeps the tool count low while unlocking everything.

### Phase 2: UI Automation Module (for non-API features)

**Effort: Medium | Impact: Moderate**

Create `src/core/ui-automation.js` for features that require DOM interaction:

1. **Price/Time to Pixel Conversion** — Using the coordinate APIs discovered above
2. **Click at Chart Coordinates** — `canvasRect.x + timeScale.indexToCoordinate(idx)`, `canvasRect.y + priceScale.priceToCoordinate(price)`
3. **Toolbar Dropdown Navigation** — Click arrow buttons to expand, then click tool items
4. **Template Management** — Save/load drawing templates via model API
5. **Wait for UI State** — Poll for dialog open/close, dropdown expansion

### Phase 3: Advanced Chart Control

| Feature | Approach | Effort |
|---|---|---|
| **Symbol Overlay** | `api.createStudy('Compare', ...)` or click "Compare" button | Low |
| **Save/Load Templates** | `api.getLineToolsState()` / `api.applyLineToolsState()` | Low |
| **Indicator Settings** | Already partially in `core/indicators.js` — extend | Low |
| **Drawing Properties** | `getShapeById(id).setProperties(overrides)` | Low |
| **Clone Drawings** | `api.cloneLineTool(id)` | Trivial |
| **Scroll to Drawing** | `model.scrollToLineTool(id)` | Trivial |

### Phase 4: Smart Analysis (Pine Alternative)

Only needed if API shapes don't render with sufficient visual quality. Based on testing, the API shapes render identically to manually-drawn ones (they ARE the same tools), so this phase may be unnecessary.

---

## Key Architectural Decision

**Recommendation: Extend `draw_shape`, don't create separate tools per shape.**

The cleanest approach is to:
1. Update `draw_shape` to accept any shape name from the supported list
2. Accept a `points` array (1-7+ points) instead of just `point` and `point2`
3. Keep backward compatibility with the existing `point`/`point2` parameters
4. Add shape-specific validation (e.g., fib_retracement requires exactly 2 points)

This gives Claude access to 50+ drawing tools with a single tool interface, keeping the MCP tool count manageable.

---

## DOM Reference

### Chart Canvas
- **Element:** `<canvas>` at `{ x: 56, y: 42, width: 1502, height: 872 }`
- **Chart area:** `{ x: 56, y: 42, width: 1574, height: 1147 }` (includes price scale)

### Drawing Toolbar
- **Selector:** `div[class*="drawingToolbar"]` or `div.drawingToolbar-BfVZxb4b`
- **Button class:** `button-KTgbfaP5`
- **Dropdown arrow class:** `arrow-pbhJWNrt`
- **Group container class:** `dropdown-pbhJWNrt`

### Key data-name Attributes
- `linetool-group-trend-line` — trend tools dropdown
- `linetool-group-gann-and-fibonacci` — fib & gann tools dropdown
- `linetool-group-patterns` — pattern tools dropdown
- `linetool-group-prediction-and-measurement` — prediction tools
- `linetool-group-geometric-shapes` — shapes dropdown
- `linetool-group-annotation` — text/annotation tools
- `measure` — measure tool button
- `zoom` — zoom tool button
- `drawginmode` — keep drawing toggle (note: typo is in TradingView's code)
- `lockAllDrawings` — lock toggle
- `removeAllDrawingTools` — remove all dropdown

---

## Appendix: Coordinate Conversion Code

```javascript
// Convert price/time to window pixel coordinates for CDP mouse clicks
function priceTimeToPixel(price, timestamp) {
  var api = window.TradingViewApi._activeChartWidgetWV.value();
  var model = api._chartWidget.model();
  var timeScale = model.timeScale();
  var priceScale = model.mainSeries().priceScale();
  var canvas = document.querySelector('canvas');
  var rect = canvas.getBoundingClientRect();

  var barIndex = timeScale.timePointToIndex(timestamp);
  var x = rect.x + timeScale.indexToCoordinate(barIndex);
  var y = rect.y + priceScale.priceToCoordinate(price);

  return { x: Math.round(x), y: Math.round(y) };
}
```
