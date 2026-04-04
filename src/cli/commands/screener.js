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
    ['read-filters', {
      description: 'Read current filter state from Redux',
      handler: () => core.readFilters(),
    }],
    ['set-filter', {
      description: 'Set a filter (e.g., tv screener set-filter "Market cap" ">=" 1000000000000)',
      handler: (opts, positionals) => {
        if (positionals.length < 3) throw new Error('Usage: tv screener set-filter "column" "operator" value\nExample: tv screener set-filter "P/E" "<" 15');
        const column = positionals[0];
        const operator = positionals[1];
        let value = positionals[2];
        // Try to parse as number
        if (!isNaN(value)) value = Number(value);
        // Try to parse as array
        if (typeof value === 'string' && value.startsWith('[')) {
          try { value = JSON.parse(value); } catch {}
        }
        return core.setFilter({ column, operator, value });
      },
    }],
    ['reset-filter', {
      description: 'Reset a specific filter',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Column name required. Usage: tv screener reset-filter "Market cap"');
        return core.resetFilter({ column: positionals.join(' ') });
      },
    }],
    ['reset-all', {
      description: 'Reset all filters to defaults',
      handler: () => core.resetAllFilters(),
    }],
    ['export', {
      description: 'Export all screener data as JSON',
      handler: () => core.exportData(),
    }],
    ['market', {
      description: 'Switch screener type and/or market. Usage: tv screener market [market] [--type stock|crypto|forex|etf|bond]',
      options: {
        type: { type: 'string', short: 't', description: 'Screener type: stock, crypto, forex, etf, bond, cex, dex' },
      },
      handler: (opts, positionals) => {
        const market = positionals.length > 0 ? positionals.join(' ') : undefined;
        return core.setMarket({ type: opts.type, market });
      },
    }],
    ['get-market', {
      description: 'Get current screener type and market',
      handler: () => core.getMarket(),
    }],
  ]),
});
