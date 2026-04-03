import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/drawing.js';

export function registerDrawingTools(server) {
  server.tool('draw_shape', 'Draw any shape/annotation on the chart (supports 50+ TradingView drawing types including Fib, Elliott Wave, Gann, Pitchfork, patterns)', {
    shape: z.string().describe(
      'Shape type. Common: horizontal_line, vertical_line, trend_line, rectangle, text. ' +
      'Fibonacci: fib_retracement, fib_channel, fib_circles, fib_speed_resistance_fan, fib_timezone. ' +
      'Gann: gann_fan, gann_box. Pitchfork: pitchfork, schiff_pitchfork, inside_pitchfork. ' +
      'Elliott: elliott_impulse_wave (6pts), elliott_correction (4pts). ' +
      'Patterns: xabcd_pattern (5pts), abcd_pattern (4pts), head_and_shoulders (7pts), triangle_pattern (3pts). ' +
      'Prediction: long_position, short_position, forecast. Measurement: date_range, price_range. ' +
      'Trend: ray, extended, trend_angle, parallel_channel (3pts), regression_trend, info_line, arrow, anchored_vwap. ' +
      'Shapes: circle, ellipse, triangle (3pts), rotated_rectangle, arc (3pts). ' +
      'Annotation: callout, note, anchored_text, price_label, balloon, signpost, flag.'
    ),
    points: z.array(z.object({ time: z.coerce.number(), price: z.coerce.number() }))
      .optional()
      .describe('Array of {time, price} points. Length depends on shape: 1 for annotations, 2 for lines/fibs/gann, 3 for pitchfork/channels, 4+ for patterns/waves. Preferred over point/point2.'),
    point: z.object({ time: z.coerce.number(), price: z.coerce.number() })
      .optional()
      .describe('(Legacy) First point. Use "points" array instead for new shapes.'),
    point2: z.object({ time: z.coerce.number(), price: z.coerce.number() })
      .optional()
      .describe('(Legacy) Second point for two-point shapes. Use "points" array instead.'),
    overrides: z.string().optional().describe('JSON string of style overrides (e.g., \'{"linecolor": "#ff0000", "linewidth": 2}\')'),
    text: z.string().optional().describe('Text content for text/annotation shapes'),
  }, async ({ shape, points, point, point2, overrides, text }) => {
    try { return jsonResult(await core.drawShape({ shape, point, point2, points, overrides, text })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('draw_list', 'List all shapes/drawings on the chart', {}, async () => {
    try { return jsonResult(await core.listDrawings()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('draw_clear', 'Remove all drawings from the chart', {}, async () => {
    try { return jsonResult(await core.clearAll()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('draw_remove_one', 'Remove a specific drawing by entity ID', {
    entity_id: z.string().describe('Entity ID of the drawing to remove (from draw_list)'),
  }, async ({ entity_id }) => {
    try { return jsonResult(await core.removeOne({ entity_id })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('draw_get_properties', 'Get properties and points of a specific drawing', {
    entity_id: z.string().describe('Entity ID of the drawing (from draw_list)'),
  }, async ({ entity_id }) => {
    try { return jsonResult(await core.getProperties({ entity_id })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
