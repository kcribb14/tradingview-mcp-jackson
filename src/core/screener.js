/**
 * Core screener logic.
 * Reads and controls the TradingView Stock Screener panel via CDP DOM access.
 *
 * Architecture: The screener renders inside an iframe/webview in the chart page.
 * - Reading (table DOM) works via the chart page's evaluate()
 * - Sorting requires accessing the screener's own CDP target (separate page at /screener/)
 *   to walk the React fiber tree and call setSort() directly.
 */
import { evaluate, getClient } from '../connection.js';
import CDP from 'chrome-remote-interface';

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;

/**
 * Find the main screener table in the DOM (chart page context).
 */
const FIND_TABLE = `
(function() {
  var tables = document.querySelectorAll('table');
  for (var i = 0; i < tables.length; i++) {
    if (tables[i].querySelectorAll('th').length > 2) return i;
  }
  return -1;
})()
`;

/**
 * Column ID mapping: display names → internal screener column IDs.
 * Used by setSort() to find the right column object in React state.
 */
const COLUMN_MAP = {
  'symbol': 'TickerUniversal',
  'price': 'Price',
  'change': 'Change', 'change %': 'Change',
  'volume': 'Volume',
  'rel volume': 'RelativeVolume', 'relative volume': 'RelativeVolume',
  'market cap': 'MarketCap', 'market_cap': 'MarketCap',
  'p/e': 'PriceToEarnings', 'pe': 'PriceToEarnings',
  'eps': 'EpsDiluted', 'eps dil': 'EpsDiluted',
  'eps growth': 'EpsDilutedGrowth', 'eps dil growth': 'EpsDilutedGrowth',
  'div yield': 'DividendsYield', 'div yield %': 'DividendsYield', 'dividend': 'DividendsYield',
  'sector': 'Sector',
  'analyst rating': 'AnalystRating', 'rating': 'AnalystRating',
  // Technicals
  'rsi': 'RSI', 'rsi (14)': 'RSI',
  'tech rating': 'TechRating',
  'ma rating': 'MARating',
  // Performance
  'perf %': 'Performance',
  'revenue growth': 'RevenueGrowth',
  'peg': 'PEG',
  'roe': 'ROE',
  'beta': 'Beta',
};

/**
 * Get a CDP client connected to the screener target (separate from chart).
 */
async function getScreenerClient() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  const screenerTarget = targets.find(t => t.type === 'page' && /screener/i.test(t.url));
  if (!screenerTarget) return null;
  const client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: screenerTarget.id });
  await client.Runtime.enable();
  return client;
}

/**
 * Evaluate JS in the screener's own page context (not the chart page).
 */
async function evalInScreener(expression) {
  const client = await getScreenerClient();
  if (!client) throw new Error('Screener target not found. Is the screener panel open?');
  try {
    const result = await client.Runtime.evaluate({ expression, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result?.value;
  } finally {
    try { await client.close(); } catch {}
  }
}

/**
 * Open the screener panel via the bottom-bar button.
 */
export async function open() {
  // Check if screener is already open
  const alreadyOpen = await evaluate(FIND_TABLE);
  if (alreadyOpen >= 0) {
    return { success: true, action: 'already_open', screener_visible: true };
  }

  // Click the screener button
  const clicked = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="screener-dialog-button"]');
      if (!btn) return 'button_not_found';
      btn.click();
      return 'clicked';
    })()
  `);
  if (clicked === 'button_not_found') {
    throw new Error('Screener button not found. Is TradingView Desktop open with a chart?');
  }
  await new Promise(r => setTimeout(r, 3000));

  // Verify — retry once if needed
  let tableIdx = await evaluate(FIND_TABLE);
  if (tableIdx < 0) {
    await evaluate(`document.querySelector('[data-name="screener-dialog-button"]').click()`);
    await new Promise(r => setTimeout(r, 3000));
    tableIdx = await evaluate(FIND_TABLE);
  }

  return { success: true, action: 'opened', screener_visible: tableIdx >= 0 };
}

/**
 * Read screener results: headers + all visible rows.
 * Reads from the screener's own CDP target for accurate data after sorts.
 * Falls back to chart page DOM if screener target isn't available.
 */
export async function read({ max_rows = 100, view } = {}) {
  if (view) {
    await switchView(view);
    await new Promise(r => setTimeout(r, 1000));
  }

  const readExpr = `
    (function() {
      var maxRows = ${max_rows};
      var tables = document.querySelectorAll('table');
      var table = null;
      for (var i = 0; i < tables.length; i++) {
        if (tables[i].querySelectorAll('th').length > 2) { table = tables[i]; break; }
      }
      if (!table) return { error: 'Screener table not found. Is the screener panel open?' };

      var headers = [];
      table.querySelectorAll('th').forEach(function(th) {
        var text = th.textContent.trim();
        if (text) headers.push(text);
      });

      var rows = [];
      var trs = table.querySelectorAll('tbody tr');
      for (var j = 0; j < Math.min(maxRows, trs.length); j++) {
        var cells = [];
        trs[j].querySelectorAll('td').forEach(function(td, idx) {
          // For Symbol column (first td): extract ticker from dedicated element
          if (idx === 0) {
            var tickerEl = td.querySelector('a[class*="tickerNameBox"], a[class*="ticker"]');
            cells.push(tickerEl ? tickerEl.textContent.trim() : td.textContent.trim());
          } else {
            cells.push(td.textContent.trim());
          }
        });
        var row = {};
        for (var k = 0; k < headers.length && k < cells.length; k++) {
          row[headers[k]] = cells[k];
        }
        if (Object.keys(row).length > 0) rows.push(row);
      }

      return { headers: headers, row_count: rows.length, total_visible: trs.length, rows: rows };
    })()
  `;

  // Read from screener target first (always accurate after sort/filter operations).
  // Falls back to chart page DOM if screener target isn't available.
  let data;
  try {
    data = await evalInScreener(readExpr);
  } catch {
    data = await evaluate(readExpr);
  }

  if (data?.error) throw new Error(data.error);
  return { success: true, ...data };
}

/**
 * Sort the screener by calling React's setSort() directly via the fiber tree.
 * This is 100% reliable — no DOM clicks, no context menus.
 *
 * @param {string} column - column name (e.g., "Market cap", "Change %", "P/E", "Volume")
 * @param {string} order - "asc" or "desc"
 */
export async function sort({ column, order = 'desc' }) {
  // Resolve column name to internal ID
  const colLower = column.toLowerCase().replace(/\s+/g, ' ').replace(/%/g, '').trim();
  const columnId = COLUMN_MAP[colLower] || column;

  const result = await evalInScreener(`
    (function() {
      // Find the screener table
      var tables = document.querySelectorAll('table');
      var table = null;
      for (var i = 0; i < tables.length; i++) {
        if (tables[i].querySelectorAll('th').length > 2) { table = tables[i]; break; }
      }
      if (!table) return { error: 'Screener table not found in screener target' };

      // Get React fiber
      var fiberKey = Object.keys(table).find(function(k) {
        return k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance');
      });
      if (!fiberKey) return { error: 'React fiber not found on table element' };

      var fiber = table[fiberKey];
      var current = fiber;
      var setSort = null;
      var columns = null;

      // Walk up the fiber tree to find the component with setSort prop
      for (var i = 0; i < 50 && current; i++) {
        if (current.memoizedProps) {
          var props = current.memoizedProps;
          if (typeof props.setSort === 'function' && props.columns) {
            setSort = props.setSort;
            columns = props.columns;
            break;
          }
        }
        current = current.return;
      }

      if (!setSort) return { error: 'setSort function not found in React fiber tree' };

      // Find the matching column object
      var columnId = ${JSON.stringify(columnId)};
      var direction = ${JSON.stringify(order)};
      var targetCol = null;

      for (var j = 0; j < columns.length; j++) {
        var col = columns[j];
        if (col.id === columnId || (col.id && col.id.toLowerCase() === columnId.toLowerCase())) {
          targetCol = col;
          break;
        }
      }

      if (!targetCol) {
        var available = columns.map(function(c) { return c.id; });
        return { error: 'Column ID not found: ' + columnId + '. Available: ' + available.join(', ') };
      }

      // Call setSort with the column object and direction
      setSort(targetCol, direction);

      return {
        sorted_by: targetCol.id,
        direction: direction,
        column_display: ${JSON.stringify(column)}
      };
    })()
  `);

  if (result?.error) throw new Error(result.error);

  await new Promise(r => setTimeout(r, 1500));
  return { success: true, ...result };
}

/**
 * Get the current sort state from the screener's React state.
 */
export async function getSort() {
  const result = await evalInScreener(`
    (function() {
      var tables = document.querySelectorAll('table');
      var table = null;
      for (var i = 0; i < tables.length; i++) {
        if (tables[i].querySelectorAll('th').length > 2) { table = tables[i]; break; }
      }
      if (!table) return { error: 'Screener table not found' };

      var fiberKey = Object.keys(table).find(function(k) {
        return k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance');
      });
      if (!fiberKey) return { error: 'React fiber not found' };

      var fiber = table[fiberKey];
      var current = fiber;

      for (var i = 0; i < 50 && current; i++) {
        if (current.memoizedProps && current.memoizedProps.sort) {
          var s = current.memoizedProps.sort;
          return { sortBy: s.sortBy, sortOrder: s.sortOrder };
        }
        current = current.return;
      }
      return { error: 'Sort state not found in fiber tree' };
    })()
  `);

  if (result?.error) throw new Error(result.error);
  return { success: true, ...result };
}

/**
 * Click a filter pill to open its popup and read filter options.
 */
export async function filter({ filter_name }) {
  const coords = await evaluate(`
    (function() {
      var name = ${JSON.stringify(filter_name)};
      var pills = document.querySelectorAll('[data-name*="screener-filter-pill"]');
      var target = null;
      pills.forEach(function(p) {
        if (p.textContent.trim().toLowerCase().includes(name.toLowerCase())) target = p;
      });
      if (!target) return { error: 'Filter pill not found: ' + name };
      var rect = target.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), clicked: target.textContent.trim() };
    })()
  `);

  if (coords?.error) throw new Error(coords.error);
  const result = coords;

  // CDP click for React compatibility
  const c = await getClient();
  await c.Input.dispatchMouseEvent({ type: 'mousePressed', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
  await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });

  await new Promise(r => setTimeout(r, 1000));

  const popup = await evaluate(`
    (function() {
      var popups = document.querySelectorAll('[class*="popup"], [class*="Popup"], [class*="dialog"], [class*="Dialog"], [class*="dropdown"], [class*="Dropdown"], [role="dialog"], [role="listbox"]');
      if (popups.length === 0) return { options: [], note: 'No popup detected — filter may need manual interaction' };
      var lastPopup = popups[popups.length - 1];
      var options = [];
      lastPopup.querySelectorAll('label, [role="option"], [class*="item"], [class*="checkbox"]').forEach(function(el) {
        var txt = (el.textContent || '').trim().slice(0, 60);
        if (txt) options.push(txt);
      });
      var inputs = [];
      lastPopup.querySelectorAll('input').forEach(function(inp) {
        inputs.push({ type: inp.type, placeholder: inp.placeholder || '', value: inp.value || '' });
      });
      return { options: options.slice(0, 30), inputs: inputs, popup_class: lastPopup.className.slice(0, 80) };
    })()
  `);

  return { success: true, filter: result.clicked, ...popup };
}

/**
 * Switch the screener view tab (Overview, Performance, Valuation, etc.)
 */
export async function switchView(view) {
  const result = await evaluate(`
    (function() {
      var target = ${JSON.stringify(view)};
      var buttons = document.querySelectorAll('[class*="screener"] button, [class*="Screener"] button');
      var found = null;
      buttons.forEach(function(b) {
        var txt = (b.textContent || '').trim();
        if (txt.toLowerCase().includes(target.toLowerCase())) found = b;
      });
      if (!found) return { error: 'View tab not found: ' + target };
      found.click();
      return { switched: found.textContent.trim() };
    })()
  `);
  if (result?.error) throw new Error(result.error);
  await new Promise(r => setTimeout(r, 1000));
  return { success: true, ...result };
}

/**
 * Get available filter pills and screener tabs.
 */
export async function getFilters() {
  const data = await evaluate(`
    (function() {
      var result = {};
      var pills = [];
      document.querySelectorAll('[data-name*="screener-filter-pill"]').forEach(function(p) {
        pills.push(p.textContent.trim());
      });
      result.filters = pills;
      var tabs = [];
      var seen = {};
      document.querySelectorAll('[class*="screener"] button, [class*="Screener"] button').forEach(function(b) {
        var txt = (b.textContent || '').trim().replace(/(.+)\\1/, '$1');
        if (txt && !seen[txt] && txt.length > 2 && txt.length < 30 && !pills.includes(txt)) {
          seen[txt] = true;
          tabs.push(txt);
        }
      });
      result.views = tabs;
      var headers = [];
      var tables = document.querySelectorAll('table');
      for (var i = 0; i < tables.length; i++) {
        if (tables[i].querySelectorAll('th').length > 2) {
          tables[i].querySelectorAll('th').forEach(function(th) {
            var txt = th.textContent.trim();
            if (txt) headers.push(txt);
          });
          break;
        }
      }
      result.columns = headers;
      return result;
    })()
  `);
  return { success: true, ...data };
}

/**
 * Export all visible screener data as structured JSON.
 */
export async function exportData() {
  return read({ max_rows: 500 });
}
