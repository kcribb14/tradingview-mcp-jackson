import { register } from '../router.js';
import * as scanner from '../../core/scanner.js';
import * as fgScanner from '../../core/fg_scanner.js';
import * as fgFast from '../../core/fg_fast_scanner.js';

register('scan', {
  description: 'Bulk scanner — scan 100 stocks in seconds with custom scoring',
  subcommands: new Map([
    ['run', {
      description: 'Run a bulk scan (default: balanced preset, top 20)',
      options: {
        preset: { type: 'string', short: 'p', description: 'Preset: momentum, value, trend, volume_anomaly, balanced' },
        top: { type: 'string', short: 'n', description: 'Top N results (default 20)' },
      },
      handler: (opts) => scanner.bulkScan({
        preset: opts.preset || 'balanced',
        top: opts.top ? Number(opts.top) : 20,
      }),
    }],
    ['momentum', {
      description: 'Scan for highest momentum stocks',
      options: { top: { type: 'string', short: 'n', description: 'Top N (default 20)' } },
      handler: (opts) => scanner.bulkScan({ preset: 'momentum', top: opts.top ? Number(opts.top) : 20 }),
    }],
    ['value', {
      description: 'Scan for best value stocks',
      options: { top: { type: 'string', short: 'n', description: 'Top N (default 20)' } },
      handler: (opts) => scanner.bulkScan({ preset: 'value', top: opts.top ? Number(opts.top) : 20 }),
    }],
    ['trend', {
      description: 'Scan for strongest trends',
      options: { top: { type: 'string', short: 'n', description: 'Top N (default 20)' } },
      handler: (opts) => scanner.bulkScan({ preset: 'trend', top: opts.top ? Number(opts.top) : 20 }),
    }],
    ['volume', {
      description: 'Scan for volume anomalies',
      options: { top: { type: 'string', short: 'n', description: 'Top N (default 20)' } },
      handler: (opts) => scanner.bulkScan({ preset: 'volume_anomaly', top: opts.top ? Number(opts.top) : 20 }),
    }],
    ['fg', {
      description: 'Deep F&G scan on specific symbols',
      options: {
        wait: { type: 'string', description: 'Wait ms per symbol (default 2000)' },
      },
      handler: (opts, positionals) => {
        if (positionals.length === 0) throw new Error('Symbols required. Usage: tv scan fg AAPL MSFT BTCUSD');
        return fgScanner.fgScan({
          max_candidates: positionals.length,
          wait_ms: opts.wait ? Number(opts.wait) : 2000,
          skip_screener: true,
          symbols: positionals,
        });
      },
    }],
    ['fg-bulk', {
      description: '3-tier F&G bulk scan: proxy(100) → deep(15) → chart(5)',
      options: {
        universe: { type: 'string', short: 'u', description: 'Tier 1 stock count (default 100)' },
        deep: { type: 'string', short: 'd', description: 'Tier 2 deep scan count (default 15)' },
        chart: { type: 'string', short: 'c', description: 'Tier 3 chart analysis count (default 5)' },
        wait: { type: 'string', description: 'Wait ms per symbol (default 2000)' },
      },
      handler: (opts) => fgScanner.fgBulkScan({
        universe: opts.universe ? Number(opts.universe) : 100,
        deep: opts.deep ? Number(opts.deep) : 15,
        chart: opts.chart ? Number(opts.chart) : 5,
        wait_ms: opts.wait ? Number(opts.wait) : 2000,
      }),
    }],
    ['quick', {
      description: 'Ultra-fast screener scan: 100 stocks scored in <8s, no chart interaction',
      options: {
        universe: { type: 'string', short: 'u', description: 'Stocks to scan (default 100)' },
        top: { type: 'string', short: 'n', description: 'Top N results (default 20)' },
        sort: { type: 'string', short: 's', description: 'Sort: fear, greed, momentum, composite (default: fear)' },
      },
      handler: (opts) => fgFast.quickScan({
        universe: opts.universe ? Number(opts.universe) : 100,
        top: opts.top ? Number(opts.top) : 20,
        sort: opts.sort || 'fear',
      }),
    }],
    ['fg-fast', {
      description: 'Fast F&G: screener proxy(100) + Pine batch(38) in <25s',
      options: {
        universe: { type: 'string', short: 'u', description: 'Tier 1 stock count (default 100)' },
        deep: { type: 'string', short: 'd', description: 'Tier 2 Pine batch count (default 38, max 38)' },
        'pine-wait': { type: 'string', description: 'Ms to wait for Pine calc (default 4000)' },
      },
      handler: (opts) => fgFast.fgFastScan({
        universe: opts.universe ? Number(opts.universe) : 100,
        deep: opts.deep ? Number(opts.deep) : 38,
        pine_wait_ms: opts['pine-wait'] ? Number(opts['pine-wait']) : 4000,
      }),
    }],
    ['parse', {
      description: 'Parse a TradingView value string to number',
      handler: (opts, positionals) => {
        const val = positionals.join(' ');
        return { input: val, parsed: scanner.parseValue(val) };
      },
    }],
  ]),
});
