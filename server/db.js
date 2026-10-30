const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, '..', 'db', 'medreview.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',   -- queued | processing | done | error
    error TEXT,
    analysis TEXT,                           -- JSON from analyze.js
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
    analyzed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_ids TEXT NOT NULL,                   -- JSON array of document ids it covered
    summary TEXT NOT NULL,                   -- JSON
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Anything left mid-analysis by a restart gets picked up again.
db.prepare("UPDATE documents SET status = 'queued' WHERE status = 'processing'").run();

module.exports = db;
