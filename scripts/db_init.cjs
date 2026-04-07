const Database = require('better-sqlite3');
const path = require('path');
const DB_PATH = path.join(process.env.HOME, '.tradingview-mcp', 'db', 'fg.db');

require('fs').mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS symbols (
  ticker TEXT PRIMARY KEY, name TEXT, category TEXT,
  asset_class TEXT, exchange TEXT, cik TEXT,
  market_cap INTEGER, added_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prices (
  ticker TEXT, date TEXT, open REAL, high REAL, low REAL,
  close REAL, volume INTEGER, source TEXT,
  PRIMARY KEY (ticker, date)
);

CREATE TABLE IF NOT EXISTS fg_history (
  ticker TEXT, date TEXT, fg_score REAL, zone TEXT,
  PRIMARY KEY (ticker, date)
);

CREATE TABLE IF NOT EXISTS fundamentals (
  ticker TEXT, period_end TEXT, period_type TEXT,
  revenue REAL, net_income REAL, eps REAL,
  total_assets REAL, total_liabilities REAL, equity REAL,
  pe_ratio REAL, roe REAL, gross_margin REAL, net_margin REAL,
  source TEXT, fetched_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (ticker, period_end, period_type)
);

CREATE TABLE IF NOT EXISTS filings (
  accession TEXT PRIMARY KEY, ticker TEXT, filing_type TEXT,
  filing_date TEXT, url TEXT, description TEXT,
  fetched_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS insider_trades (
  id TEXT PRIMARY KEY, ticker TEXT, filed_at TEXT,
  filer_name TEXT, transaction_type TEXT,
  shares INTEGER, value REAL, source TEXT
);

CREATE TABLE IF NOT EXISTS earnings (
  ticker TEXT, period TEXT, eps_actual REAL, eps_estimate REAL,
  surprise_pct REAL, PRIMARY KEY (ticker, period)
);

CREATE TABLE IF NOT EXISTS etl_log (
  job_id TEXT, ticker TEXT, source TEXT, status TEXT,
  rows_inserted INTEGER, error TEXT,
  ran_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (job_id, ticker)
);

CREATE INDEX IF NOT EXISTS idx_prices_ticker ON prices(ticker);
CREATE INDEX IF NOT EXISTS idx_prices_date ON prices(date);
CREATE INDEX IF NOT EXISTS idx_fg_ticker ON fg_history(ticker);
CREATE INDEX IF NOT EXISTS idx_fg_date ON fg_history(date);
CREATE INDEX IF NOT EXISTS idx_filings_ticker ON filings(ticker);
CREATE INDEX IF NOT EXISTS idx_insider_ticker ON insider_trades(ticker);
`);

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log('Database created at:', DB_PATH);
console.log('Tables:', tables.map(t => t.name).join(', '));
db.close();
