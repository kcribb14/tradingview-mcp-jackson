import { register } from '../router.js';
import * as core from '../../core/screener.js';

register('screener', {
  description: 'Stock screener tools (open, read, sort, filter, export)',
  subcommands: new Map([
    ['open', {
      description: 'Open the Stock Screener panel',
      handler: () => core.open(),
    }],
    ['read', {
      description: 'Read screener results',
      options: {
        max: { type: 'string', description: 'Max rows (default 100)' },
        view: { type: 'string', description: 'View tab: overview, performance, valuation, dividends, technicals' },
      },
      handler: (opts) => core.read({ max_rows: opts.max ? Number(opts.max) : 100, view: opts.view }),
    }],
    ['sort', {
      description: 'Sort screener by column (uses React fiber — reliable)',
      options: {
        order: { type: 'string', description: 'Sort order: asc or desc (default desc)' },
      },
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Column name required. Usage: tv screener sort "Market cap" --order desc');
        return core.sort({ column: positionals.join(' '), order: opts.order || 'desc' });
      },
    }],
    ['get-sort', {
      description: 'Get current screener sort state',
      handler: () => core.getSort(),
    }],
    ['filter', {
      description: 'Open a filter pill to view/set options',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Filter name required. Usage: tv screener filter "Sector"');
        return core.filter({ filter_name: positionals.join(' ') });
      },
    }],
    ['filters', {
      description: 'List available filter pills and view tabs',
      handler: () => core.getFilters(),
    }],
    ['export', {
      description: 'Export all screener data as JSON',
      handler: () => core.exportData(),
    }],
  ]),
});
