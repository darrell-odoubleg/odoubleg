const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config();

const dbPath = process.env.DB_PATH || path.join(__dirname, 'events.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS crew (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT,
  city TEXT,
  state TEXT,
  skills TEXT,            -- comma-separated tags: audio, lighting, stagehand, security, etc
  certifications TEXT,
  bio TEXT,
  hourly_rate REAL,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS availability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  crew_id INTEGER NOT NULL REFERENCES crew(id) ON DELETE CASCADE,
  date TEXT NOT NULL,      -- YYYY-MM-DD
  status TEXT NOT NULL DEFAULT 'available', -- available, unavailable
  UNIQUE(crew_id, date)
);

CREATE TABLE IF NOT EXISTS gigs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  venue TEXT,
  city TEXT,
  state TEXT,
  event_date TEXT NOT NULL,   -- YYYY-MM-DD
  call_time TEXT,             -- HH:MM
  end_time TEXT,
  roles_needed TEXT NOT NULL, -- JSON string: [{"role":"stagehand","count":3,"pay_rate":25}]
  status TEXT NOT NULL DEFAULT 'open', -- open, filled, completed, cancelled
  created_by INTEGER REFERENCES admins(id),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gig_id INTEGER NOT NULL REFERENCES gigs(id) ON DELETE CASCADE,
  crew_id INTEGER NOT NULL REFERENCES crew(id) ON DELETE CASCADE,
  role_applied TEXT,
  status TEXT NOT NULL DEFAULT 'applied', -- applied, confirmed, declined, withdrawn
  notes TEXT,
  applied_at TEXT DEFAULT (datetime('now')),
  decided_at TEXT,
  UNIQUE(gig_id, crew_id, role_applied)
);

CREATE INDEX IF NOT EXISTS idx_gigs_date ON gigs(event_date);
CREATE INDEX IF NOT EXISTS idx_apps_gig ON applications(gig_id);
CREATE INDEX IF NOT EXISTS idx_apps_crew ON applications(crew_id);
CREATE INDEX IF NOT EXISTS idx_avail_crew_date ON availability(crew_id, date);
`);

// Bootstrap first admin if none exists
const adminCount = db.prepare('SELECT COUNT(*) as c FROM admins').get().c;
if (adminCount === 0 && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10);
  db.prepare('INSERT INTO admins (email, password_hash, name) VALUES (?, ?, ?)')
    .run(process.env.ADMIN_EMAIL, hash, 'Darrell Ogg');
  console.log(`Bootstrap admin created: ${process.env.ADMIN_EMAIL}`);
}

module.exports = db;
