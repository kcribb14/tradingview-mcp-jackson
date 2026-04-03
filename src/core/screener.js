/**
 * Core screener logic.
 * Reads and controls the TradingView Stock Screener panel via CDP DOM access.
 */
import { evaluate, getClient } from '../connection.js';

/**
 * Find the main screener table in the DOM.
 * Returns a JS expression path for further queries, or throws.
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
 * Open the screener panel via the bottom-bar button.
 */
export async function open() {
  // Check if screener is already open (has a visible table with >2 headers)
  const alreadyOpen = await evaluate(FIND_TABLE);
  if (alreadyOpen >= 0) {
    return { success: true, action: 'already_open', screener_visible: true };
  }

  // Click the screener button to open it
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

  // Verify it opened
  const tableIdx = await evaluate(FIND_TABLE);
  if (tableIdx < 0) {
    // Maybe the click closed it instead — try one more click
    await evaluate(`document.querySelector('[data-name="screener-dialog-button"]').click()`);
    await new Promise(r => setTimeout(r, 3000));
  }

  const finalCheck = await evaluate(FIND_TABLE);
  return { success: true, action: 'opened', screener_visible: finalCheck >= 0 };
}

/**
 * Read screener results: headers + all visible rows.
 * @param {object} opts
 * @param {number} opts.max_rows - max rows to return (default 100)
 * @param {string} opts.view - screener tab to read: overview, performance, valuation, dividends, technicals, etc.
 */
export async function read({ max_rows = 100, view } = {}) {
  // Optionally switch view tab first
  if (view) {
    await switchView(view);
    await new Promise(r => setTimeout(r, 1000));
  }

  const data = await evaluate(`
    (function() {
      var maxRows = ${max_rows};
      var tables = document.querySelectorAll('table');
      var table = null;
      for (var i = 0; i < tables.length; i++) {
        if (tables[i].querySelectorAll('th').length > 2) { table = tables[i]; break; }
      }
      if (!table) return { error: 'Screener table not found. Is the screener panel open?' };

      // Read headers
      var headers = [];
      table.querySelectorAll('th').forEach(function(th) {
        var text = th.textContent.trim();
        if (text) headers.push(text);
      });

      // Read rows
      var rows = [];
      var trs = table.querySelectorAll('tbody tr');
      for (var j = 0; j < Math.min(maxRows, trs.length); j++) {
        var cells = [];
        trs[j].querySelectorAll('td').forEach(function(td) {
          cells.push(td.textContent.trim());
        });
        // Build object from headers + cells
        var row = {};
        for (var k = 0; k < headers.length && k < cells.length; k++) {
          row[headers[k]] = cells[k];
        }
        if (Object.keys(row).length > 0) rows.push(row);
      }

      return { headers: headers, row_count: rows.length, total_visible: trs.length, rows: rows };
    })()
  `);

  if (data?.error) throw new Error(data.error);
  return { success: true, ...data };
}

/**
 * Sort the screener by clicking a column header.
 * Clicking once = descending, twice = ascending, three times = default.
 * @param {string} column - column header text to sort by (e.g., "Market cap", "Change %")
 * @param {string} order - "asc" or "desc" (desc = single click, asc = double click)
 */
export async function sort({ column, order = 'desc' }) {
  const clicks = order === 'asc' ? 2 : 1;

  // Step 1: Find the column header's bounding rect
  const coords = await evaluate(`
    (function() {
      var col = ${JSON.stringify(column)};
      var tables = document.querySelectorAll('table');
      var table = null;
      for (var i = 0; i < tables.length; i++) {
        if (tables[i].querySelectorAll('th').length > 2) { table = tables[i]; break; }
      }
      if (!table) return { error: 'Screener table not found' };

      var ths = table.querySelectorAll('th');
      var target = null;
      var colLower = col.toLowerCase().replace(/\\s+/g, ' ');
      ths.forEach(function(th) {
        var txt = th.textContent.trim().replace(/\\s+/g, ' ');
        if (txt === col || txt.toLowerCase() === colLower) target = th;
      });
      if (!target) {
        ths.forEach(function(th) {
          var txt = th.textContent.trim().replace(/\\s+/g, ' ').toLowerCase();
          if (txt.includes(colLower)) target = th;
        });
      }
      if (!target) {
        var available = [];
        ths.forEach(function(th) { var t = th.textContent.trim(); if (t) available.push(t); });
        return { error: 'Column not found: ' + col + '. Available: ' + available.join(', ') };
      }

      var clickTarget = target.querySelector('div[class*="cellWrapper"]') || target;
      var rect = clickTarget.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), col: col };
    })()
  `);

  if (coords?.error) throw new Error(coords.error);

  // Step 2: Click header to open context menu, then click sort option
  const c = await getClient();

  // First close any existing menu by pressing Escape
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });
  await new Promise(r => setTimeout(r, 300));

  // Click the column header to open context menu
  await c.Input.dispatchMouseEvent({ type: 'mousePressed', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
  await new Promise(r => setTimeout(r, 50));
  await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
  await new Promise(r => setTimeout(r, 800));

  // Find and click the "Sort ascending" or "Sort descending" option in the dropdown
  const sortLabel = order === 'asc' ? 'ascending' : 'descending';
  await new Promise(r => setTimeout(r, 500));
  const menuCoords = await evaluate(`
    (function() {
      var label = ${JSON.stringify(sortLabel)};
      // Search broadly for any visible element containing the sort text
      var target = null;
      var allEls = document.querySelectorAll('div, span, button, [role="menuitem"], [role="option"]');
      for (var i = 0; i < allEls.length; i++) {
        var el = allEls[i];
        var txt = (el.textContent || '').trim().toLowerCase();
        var rect = el.getBoundingClientRect();
        // Must contain "sort" and the direction, be visible, and reasonably sized
        if (txt.includes('sort') && txt.includes(label) && rect.width > 30 && rect.height > 5 && rect.height < 60) {
          // Prefer innermost matching element (fewest children)
          if (!target || el.children.length < target.children.length) target = el;
        }
      }
      if (!target) {
        // Fallback: any element just containing the direction label
        for (var i = 0; i < allEls.length; i++) {
          var el = allEls[i];
          var txt = (el.textContent || '').trim().toLowerCase();
          var rect = el.getBoundingClientRect();
          if (txt === 'sort ' + label && rect.width > 30 && rect.height > 5) { target = el; break; }
        }
      }
      if (!target) return { error: 'Sort option not found. Menu may not have opened.' };
      var r = target.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()
  `);

  if (menuCoords?.error) throw new Error(menuCoords.error);

  // Click the sort option
  await c.Input.dispatchMouseEvent({ type: 'mousePressed', x: menuCoords.x, y: menuCoords.y, button: 'left', clickCount: 1 });
  await new Promise(r => setTimeout(r, 50));
  await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x: menuCoords.x, y: menuCoords.y, button: 'left', clickCount: 1 });

  await new Promise(r => setTimeout(r, 1500));

  // Verify screener is still open — the menu click may have closed it
  const stillOpen = await evaluate(FIND_TABLE);
  if (stillOpen < 0) {
    // Re-open it
    await evaluate(`
      (function() {
        var btn = document.querySelector('[data-name="screener-dialog-button"]');
        if (btn) btn.click();
      })()
    `);
    await new Promise(r => setTimeout(r, 3000));
  }

  return { success: true, sorted: column, order: order };
}

/**
 * Click a filter pill to open its popup, then read what filter options are available.
 * @param {string} filter_name - the filter pill text (e.g., "Sector", "Market cap", "P/E")
 */
export async function filter({ filter_name }) {
  // Find the filter pill coordinates
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

  if (result?.error) throw new Error(result.error);

  // Wait for popup to appear
  await new Promise(r => setTimeout(r, 1000));

  // Read the popup content
  const popup = await evaluate(`
    (function() {
      // Look for recently opened popup/dialog
      var popups = document.querySelectorAll('[class*="popup"], [class*="Popup"], [class*="dialog"], [class*="Dialog"], [class*="dropdown"], [class*="Dropdown"], [role="dialog"], [role="listbox"]');
      if (popups.length === 0) return { options: [], note: 'No popup detected — filter may need manual interaction' };

      var lastPopup = popups[popups.length - 1];
      var options = [];

      // Check for checkboxes/labels
      lastPopup.querySelectorAll('label, [role="option"], [class*="item"], [class*="checkbox"]').forEach(function(el) {
        var txt = (el.textContent || '').trim().slice(0, 60);
        if (txt) options.push(txt);
      });

      // Check for input fields (range filters)
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

      // Filter pills
      var pills = [];
      document.querySelectorAll('[data-name*="screener-filter-pill"]').forEach(function(p) {
        pills.push(p.textContent.trim());
      });
      result.filters = pills;

      // View tabs
      var tabs = [];
      var seen = {};
      document.querySelectorAll('[class*="screener"] button, [class*="Screener"] button').forEach(function(b) {
        var txt = (b.textContent || '').trim().replace(/(.+)\\1/, '$1'); // dedupe doubled text
        if (txt && !seen[txt] && txt.length > 2 && txt.length < 30 && !pills.includes(txt)) {
          seen[txt] = true;
          tabs.push(txt);
        }
      });
      result.views = tabs;

      // Table headers (current columns)
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
