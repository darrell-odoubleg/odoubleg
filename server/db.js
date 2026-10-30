const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, '..', 'data', 'msf.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  map_id TEXT,
  x REAL,            -- meters from the map's top-left, same units as the Mist SDK
  y REAL,
  notes TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  date TEXT NOT NULL,          -- YYYY-MM-DD, fair local time
  start_time TEXT NOT NULL,    -- HH:MM 24h
  end_time TEXT,
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  location_text TEXT,          -- free text when there's no mapped location (or extra detail like "Barn 3")
  category TEXT,
  featured INTEGER NOT NULL DEFAULT 0,
  cancelled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS events_date ON events(date, start_time);
`);

// Added 2026-10-30 for the county calendar import.
const eventCols = new Set(db.prepare('PRAGMA table_info(events)').all().map((c) => c.name));
for (const [col, def] of [
  ['source', "TEXT NOT NULL DEFAULT 'manual'"], // 'manual' (admin page) or 'county' (iCal feed)
  ['ext_uid', 'TEXT'],
  ['all_day', 'INTEGER NOT NULL DEFAULT 0'],
  ['hidden', 'INTEGER NOT NULL DEFAULT 0'],    // admins can hide an imported event; survives re-syncs
  ['url', 'TEXT'],
]) {
  if (!eventCols.has(col)) db.exec(`ALTER TABLE events ADD COLUMN ${col} ${def}`);
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS events_ext ON events(source, ext_uid)');

const DEFAULT_SETTINGS = {
  fair_name: 'Montana State Fair',
  fair_start: '',
  fair_end: '',
  kiosk_speed: '40',
  mist_sdk_token: '',
  county_feed_url: 'https://www.cascadecountymt.gov/common/modules/iCalendar/iCalendar.aspx?catID=24&feed=calendar',
  county_feed_enabled: '1',
};

function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// salt:scrypt64, same scheme as the Mother Puppers apps.
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(String(pw), salt, 64).toString('hex');
}

function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = crypto.scryptSync(String(pw), salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { db, getSettings, setSetting, DEFAULT_SETTINGS, hashPassword, checkPassword };
