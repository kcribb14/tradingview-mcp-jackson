import { register } from '../router.js';
import * as scanner from '../../core/scanner.js';

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
    ['parse', {
      description: 'Parse a TradingView value string to number',
      handler: (opts, positionals) => {
        const val = positionals.join(' ');
        return { input: val, parsed: scanner.parseValue(val) };
      },
    }],
  ]),
});
