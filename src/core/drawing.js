/**
 * Core drawing logic.
 * Supports 50+ native TradingView drawing tools via createMultipointShape.
 */
import { evaluate, getChartApi } from '../connection.js';

// Shape name -> { min, max } point requirements.
// Shapes not in this map pass through to TradingView without validation.
const SHAPE_POINTS = {
  // 1-point shapes
  horizontal_line: { min: 1, max: 1 },
  vertical_line: { min: 1, max: 1 },
  horizontal_ray: { min: 1, max: 1 },
  text: { min: 1, max: 1 },
  callout: { min: 1, max: 1 },
  note: { min: 1, max: 1 },
  anchored_text: { min: 1, max: 1 },
  price_label: { min: 1, max: 1 },
  balloon: { min: 1, max: 1 },
  signpost: { min: 1, max: 1 },
  flag: { min: 1, max: 1 },
  sticker: { min: 1, max: 1 },
  arrow_marker: { min: 1, max: 1 },
  image: { min: 1, max: 1 },
  ghost_feed: { min: 1, max: 1 },
  anchored_vwap: { min: 1, max: 1 },

  // 2-point shapes
  trend_line: { min: 2, max: 2 },
  rectangle: { min: 2, max: 2 },
  rotated_rectangle: { min: 2, max: 2 },
  fib_retracement: { min: 2, max: 2 },
  fib_circles: { min: 2, max: 2 },
  fib_speed_resistance_fan: { min: 2, max: 2 },
  fib_speed_resistance_arcs: { min: 2, max: 2 },
  fib_timezone: { min: 2, max: 2 },
  fib_spiral: { min: 2, max: 2 },
  gann_fan: { min: 2, max: 2 },
  gann_box: { min: 2, max: 2 },
  long_position: { min: 2, max: 2 },
  short_position: { min: 2, max: 2 },
  forecast: { min: 2, max: 2 },
  date_range: { min: 2, max: 2 },
  price_range: { min: 2, max: 2 },
  date_and_price_range: { min: 2, max: 2 },
  bars_pattern: { min: 2, max: 2 },
  ray: { min: 2, max: 2 },
  extended: { min: 2, max: 2 },
  trend_angle: { min: 2, max: 2 },
  disjoint_angle: { min: 2, max: 2 },
  flat_bottom: { min: 2, max: 2 },
  regression_trend: { min: 2, max: 2 },
  info_line: { min: 2, max: 2 },
  circle: { min: 2, max: 2 },
  ellipse: { min: 2, max: 2 },
  arrow: { min: 2, max: 2 },

  // 3-point shapes
  fib_channel: { min: 3, max: 3 },
  fib_wedge: { min: 3, max: 3 },
  pitchfork: { min: 3, max: 3 },
  schiff_pitchfork: { min: 3, max: 3 },
  schiff_pitchfork2: { min: 3, max: 3 },
  inside_pitchfork: { min: 3, max: 3 },
  parallel_channel: { min: 3, max: 3 },
  triangle_pattern: { min: 3, max: 3 },
  triangle: { min: 3, max: 3 },
  projection: { min: 3, max: 3 },
  arc: { min: 3, max: 3 },

  // 4-point shapes
  abcd_pattern: { min: 4, max: 4 },
  elliott_correction: { min: 4, max: 4 },

  // 5-point shapes
  xabcd_pattern: { min: 5, max: 5 },
  cypher_pattern: { min: 5, max: 5 },
  three_drives_pattern: { min: 5, max: 7 },

  // 6-point shapes
  elliott_impulse_wave: { min: 6, max: 6 },
  elliott_triangle_wave: { min: 6, max: 6 },
  elliott_double_combo: { min: 6, max: 8 },
  elliott_triple_combo: { min: 6, max: 10 },

  // 7-point shapes
  head_and_shoulders: { min: 7, max: 7 },

  // Variable
  polyline: { min: 3, max: 10 },
};

export async function drawShape({ shape, point, point2, points: pointsRaw, overrides: overridesRaw, text }) {
  const overrides = overridesRaw ? (typeof overridesRaw === 'string' ? JSON.parse(overridesRaw) : overridesRaw) : {};
  const apiPath = await getChartApi();
  const overridesStr = JSON.stringify(overrides || {});
  const textStr = text ? JSON.stringify(text) : '""';

  // Normalize points: support both legacy (point/point2) and new (points array)
  let resolvedPoints;
  if (pointsRaw && pointsRaw.length > 0) {
    resolvedPoints = pointsRaw;
  } else if (point) {
    resolvedPoints = point2 ? [point, point2] : [point];
  } else {
    throw new Error('Either "points" array or "point" parameter is required');
  }

  // Validate point count against shape requirements
  const spec = SHAPE_POINTS[shape];
  if (spec) {
    if (resolvedPoints.length < spec.min || resolvedPoints.length > spec.max) {
      const expected = spec.min === spec.max ? `exactly ${spec.min}` : `${spec.min}-${spec.max}`;
      throw new Error(`Shape "${shape}" requires ${expected} point(s), got ${resolvedPoints.length}`);
    }
  }

  const before = await evaluate(`${apiPath}.getAllShapes().map(function(s) { return s.id; })`);

  // Build points array string for JS evaluation
  const pointsStr = resolvedPoints.map(p => `{ time: ${p.time}, price: ${p.price} }`).join(', ');

  if (resolvedPoints.length === 1) {
    // Use createShape for single-point shapes (proven path)
    await evaluate(`
      ${apiPath}.createShape(
        { time: ${resolvedPoints[0].time}, price: ${resolvedPoints[0].price} },
        { shape: '${shape}', overrides: ${overridesStr}, text: ${textStr} }
      )
    `);
  } else {
    // Use createMultipointShape for all multi-point shapes
    await evaluate(`
      ${apiPath}.createMultipointShape(
        [${pointsStr}],
        { shape: '${shape}', overrides: ${overridesStr}, text: ${textStr} }
      )
    `);
  }

  await new Promise(r => setTimeout(r, 200));
  const after = await evaluate(`${apiPath}.getAllShapes().map(function(s) { return s.id; })`);
  const newId = (after || []).find(id => !(before || []).includes(id)) || null;
  return { success: true, shape, entity_id: newId, points_used: resolvedPoints.length };
}

export async function listDrawings() {
  const apiPath = await getChartApi();
  const shapes = await evaluate(`
    (function() {
      var api = ${apiPath};
      var all = api.getAllShapes();
      return all.map(function(s) { return { id: s.id, name: s.name }; });
    })()
  `);
  return { success: true, count: shapes?.length || 0, shapes: shapes || [] };
}

export async function getProperties({ entity_id }) {
  const apiPath = await getChartApi();
  const result = await evaluate(`
    (function() {
      var api = ${apiPath};
      var eid = '${entity_id}';
      var props = { entity_id: eid };
      var shape = api.getShapeById(eid);
      if (!shape) return { error: 'Shape not found: ' + eid };
      var methods = [];
      try { for (var key in shape) { if (typeof shape[key] === 'function') methods.push(key); } props.available_methods = methods; } catch(e) {}
      try { var pts = shape.getPoints(); if (pts) props.points = pts; } catch(e) { props.points_error = e.message; }
      try { var ovr = shape.getProperties(); if (ovr) props.properties = ovr; } catch(e) {
        try { var ovr2 = shape.properties(); if (ovr2) props.properties = ovr2; } catch(e2) { props.properties_error = e2.message; }
      }
      try { props.visible = shape.isVisible(); } catch(e) {}
      try { props.locked = shape.isLocked(); } catch(e) {}
      try { props.selectable = shape.isSelectionEnabled(); } catch(e) {}
      try {
        var all = api.getAllShapes();
        for (var i = 0; i < all.length; i++) { if (all[i].id === eid) { props.name = all[i].name; break; } }
      } catch(e) {}
      return props;
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return { success: true, ...result };
}

export async function removeOne({ entity_id }) {
  const apiPath = await getChartApi();
  const result = await evaluate(`
    (function() {
      var api = ${apiPath};
      var eid = '${entity_id}';
      var before = api.getAllShapes();
      var found = false;
      for (var i = 0; i < before.length; i++) { if (before[i].id === eid) { found = true; break; } }
      if (!found) return { removed: false, error: 'Shape not found: ' + eid, available: before.map(function(s) { return s.id; }) };
      api.removeEntity(eid);
      var after = api.getAllShapes();
      var stillExists = false;
      for (var j = 0; j < after.length; j++) { if (after[j].id === eid) { stillExists = true; break; } }
      return { removed: !stillExists, entity_id: eid, remaining_shapes: after.length };
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return { success: true, entity_id: result?.entity_id, removed: result?.removed, remaining_shapes: result?.remaining_shapes };
}

export async function clearAll() {
  const apiPath = await getChartApi();
  await evaluate(`${apiPath}.removeAllShapes()`);
  return { success: true, action: 'all_shapes_removed' };
}

export async function saveDrawingState() {
  const apiPath = await getChartApi();
  const result = await evaluate(`
    (function() {
      var api = ${apiPath};
      var shapes = api.getAllShapes();
      var state = [];
      for (var i = 0; i < shapes.length; i++) {
        var s = shapes[i];
        var entry = { id: s.id, name: s.name };
        try {
          var shape = api.getShapeById(s.id);
          if (shape) {
            try { entry.points = shape.getPoints(); } catch(e) {}
            try { entry.properties = shape.getProperties(); } catch(e) {}
          }
        } catch(e) {}
        state.push(entry);
      }
      return state;
    })()
  `);
  return { success: true, shape_count: result?.length || 0, state: result || [] };
}

export async function loadDrawingState({ state, clear_existing }) {
  const apiPath = await getChartApi();

  if (clear_existing) {
    await evaluate(`${apiPath}.removeAllShapes()`);
    await new Promise(r => setTimeout(r, 200));
  }

  let created = 0;
  let failed = 0;
  const errors = [];

  for (const entry of state) {
    try {
      const pointsStr = (entry.points || []).map(p => `{ time: ${p.time}, price: ${p.price} }`).join(', ');
      const overridesStr = JSON.stringify(entry.properties || {});
      const textStr = entry.properties?.text ? JSON.stringify(entry.properties.text) : '""';

      if (!entry.points || entry.points.length === 0) {
        failed++;
        errors.push(`${entry.name}: no points`);
        continue;
      }

      if (entry.points.length === 1) {
        await evaluate(`
          ${apiPath}.createShape(
            { time: ${entry.points[0].time}, price: ${entry.points[0].price} },
            { shape: '${entry.name}', overrides: ${overridesStr}, text: ${textStr} }
          )
        `);
      } else {
        await evaluate(`
          ${apiPath}.createMultipointShape(
            [${pointsStr}],
            { shape: '${entry.name}', overrides: ${overridesStr}, text: ${textStr} }
          )
        `);
      }
      created++;
    } catch (e) {
      failed++;
      errors.push(`${entry.name}: ${e.message}`);
    }
  }

  await new Promise(r => setTimeout(r, 300));
  return { success: true, created, failed, errors: errors.length > 0 ? errors : undefined };
}
