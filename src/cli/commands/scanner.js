import { register } from '../router.js';
import * as scanner from '../../core/scanner.js';
import * as fgScanner from '../../core/fg_scanner.js';

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
      description: 'Deep F&G scan — reads Fear & Greed indicator per symbol',
      options: {
        max: { type: 'string', short: 'n', description: 'Max symbols to scan (default 30)' },
        wait: { type: 'string', description: 'Wait ms per symbol (default 2000)' },
      },
      handler: (opts, positionals) => {
        const symbols = positionals.length > 0 ? positionals : undefined;
        return fgScanner.fgScan({
          max_candidates: opts.max ? Number(opts.max) : 30,
          wait_ms: opts.wait ? Number(opts.wait) : 2000,
          skip_screener: !!symbols,
          symbols,
        });
      },
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
