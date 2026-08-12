const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'history.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS ack_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ap_id TEXT NOT NULL,
    ap_name TEXT,
    org_name TEXT,
    site_name TEXT,
    ticket TEXT NOT NULL,
    acknowledged_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ack_history_ap_id ON ack_history(ap_id);
  CREATE INDEX IF NOT EXISTS idx_ack_history_acknowledged_at ON ack_history(acknowledged_at);
`);

const insertStmt = db.prepare(`
  INSERT INTO ack_history (ap_id, ap_name, org_name, site_name, ticket, acknowledged_at)
  VALUES (@apId, @apName, @orgName, @siteName, @ticket, @acknowledgedAt)
`);

function recordAck({ apId, apName, orgName, siteName, ticket }) {
  insertStmt.run({
    apId,
    apName: apName || null,
    orgName: orgName || null,
    siteName: siteName || null,
    ticket,
    acknowledgedAt: new Date().toISOString(),
  });
}

function listHistory({ apId, limit = 200 } = {}) {
  if (apId) {
    return db
      .prepare('SELECT * FROM ack_history WHERE ap_id = ? ORDER BY acknowledged_at DESC LIMIT ?')
      .all(apId, limit);
  }
  return db.prepare('SELECT * FROM ack_history ORDER BY acknowledged_at DESC LIMIT ?').all(limit);
}

module.exports = { recordAck, listHistory };
