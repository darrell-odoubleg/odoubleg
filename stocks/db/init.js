const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, 'stocks.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- One row per routine run: its overall read of the market.
  CREATE TABLE IF NOT EXISTS runs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    mode       TEXT NOT NULL,
    summary    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Every symbol the routine looked at, bought or not, with its reasoning.
  CREATE TABLE IF NOT EXISTS picks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id     INTEGER NOT NULL REFERENCES runs(id),
    symbol     TEXT NOT NULL,
    asset_type TEXT NOT NULL CHECK (asset_type IN ('stock', 'crypto')),
    action     TEXT NOT NULL CHECK (action IN ('buy', 'watch', 'skip')),
    conviction INTEGER,
    amount     REAL,
    price      REAL,
    reasoning  TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Budget reservations. An order must be reserved here before it is placed.
  -- status: dry_run | reserved | placed | filled | failed | released
  CREATE TABLE IF NOT EXISTS orders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    pick_id         INTEGER REFERENCES picks(id),
    symbol          TEXT NOT NULL,
    asset_type      TEXT NOT NULL CHECK (asset_type IN ('stock', 'crypto')),
    amount          REAL NOT NULL,
    status          TEXT NOT NULL,
    broker_order_id TEXT,
    filled_amount   REAL,
    filled_qty      REAL,
    avg_price       REAL,
    error           TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- A filled (or paper) buy is a lot; each lot is sold whole, once.
  -- status: dry_run | placed | filled | failed
  -- reason: stop_loss | take_profit | signal
  CREATE TABLE IF NOT EXISTS sells (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    lot_id          INTEGER NOT NULL REFERENCES orders(id),
    reason          TEXT NOT NULL CHECK (reason IN ('stop_loss', 'take_profit', 'signal')),
    status          TEXT NOT NULL,
    reasoning       TEXT,
    broker_order_id TEXT,
    qty             REAL,
    avg_price       REAL,
    proceeds        REAL,
    error           TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Exit tracking on each lot.
const orderCols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
for (const [col, type] of [['high_water', 'REAL'], ['stop_order_id', 'TEXT'], ['protection', 'TEXT']]) {
  if (!orderCols.includes(col)) db.exec(`ALTER TABLE orders ADD COLUMN ${col} ${type}`);
}

const DEFAULTS = {
  mode: 'dry_run',      // dry_run | live | paused
  budget_total: '500',  // starting pot, dollars; sells return money to it
  max_order: '100',     // cap per single order, dollars
  stop_loss_pct: '8',   // trailing stop: sell when price falls this far below its high
  take_profit_pct: '15',// sell when price is this far above entry
};
const insertDefault = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULTS)) insertDefault.run(k, v);

module.exports = db;
