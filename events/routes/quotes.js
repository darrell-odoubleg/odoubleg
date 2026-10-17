// Labor quotes for O Double G event staffing — the online version of the
// "2027 time sheet.xlsm" workbook. Admin only.
//
// quote_rates is the workbook's Pay Rate sheet (crew pay per craft; the bill
// rate on a quote defaults to pay x markup). quote_settings holds the other
// numbers the workbook hard-coded (hotel, per diem, mileage, payroll fee...).
// Mileage comes from Google's Distance Matrix like the workbook's
// GetRoundTripMileage macro, cached in quote_distances.
// The math lives in public/js/quote-calc.js, shared with the page.

const express = require('express');
const db = require('../db/init');
const { requireAdmin } = require('../middleware/auth');
const { calcQuote } = require('../public/js/quote-calc');

const router = express.Router();
router.use(requireAdmin);

db.exec(`
CREATE TABLE IF NOT EXISTS quote_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT UNIQUE NOT NULL COLLATE NOCASE,
  pay_rate REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT 'hour', -- hour, day
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS quote_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quote_distances (
  origin TEXT NOT NULL COLLATE NOCASE,
  destination TEXT NOT NULL COLLATE NOCASE,
  miles REAL NOT NULL, -- one way
  fetched_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (origin, destination)
);

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client TEXT,
  event_name TEXT,
  venue TEXT,
  location_city TEXT,     -- where the work is; mileage is measured from here
  start_date TEXT,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'draft', -- draft, sent, accepted, declined
  notes TEXT,
  data TEXT NOT NULL,     -- JSON: { lines, payroll_fee_pct, include_expenses }
  total REAL,
  created_by INTEGER REFERENCES admins(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
`);

const DEFAULT_SETTINGS = {
  markup: 1.35,          // bill rate = pay rate x markup
  payroll_fee_pct: 35,
  hotel_rate: 115,
  per_diem_rate: 68,
  mileage_rate: 0.76,
  ot_threshold: 40,
  ot_multiplier: 1.5,
  dt_multiplier: 2,
};

// Pay Rate sheet as of the 2027 workbook
const SEED_RATES = [
  ['Event Staff Supervisor', 17.68], ['Stage Hand - Day Rate', 312, 'day'], ['Pusher', 23.348],
  ['Carpenter Crew Head', 24.388], ['FlyMan', 28.548], ['Concessions-Runner', 13.832], ['Props', 23.348],
  ['Forklift Operator', 26], ['Video', 23.348], ['VIP Driver', 26], ['Props Crew Head', 24.388],
  ['Crew Chief', 29.692], ['Truck Loader', 23.348], ['House Lights', 23.348], ['Hair', 24.388],
  ['Stage Manager', 31.2], ['Concessions-Cook', 13.832], ['Spotlight Operator', 26],
  ['Concessions-Cashier II', 15.912], ['Stage Hand', 23.92], ['Truck Loader Crew Head', 24.388],
  ['Electrician Crew Head', 24.388], ['Runner - Day Rate', 312, 'day'], ['Team Leader', 31.2],
  ['Up-Rigger', 36.4], ['Concessions-Cashier', 13.832], ['Down-Rigger', 32.24], ['Video Crew Head', 24.388],
  ['Camera Operator', 26], ['Electrician', 23.348], ['Event Staff', 13.832], ['Runner', 23.348],
  ['Steward', 31.2], ['Event Staff Plus', 15.6], ['Pipe & Drape', 21.58], ['Audio Crew Head', 24.388],
  ['Wardrobe / Laundry', 23.348], ['Carpenter', 23.348], ['Concessions', 13.832], ['Audio', 23.348],
  ['Event Staff Cleaning', 13.832], ['Wardrobe', 23.348], ['Event Staff-Ticketing', 13.832],
];

{
  const insSetting = db.prepare('INSERT OR IGNORE INTO quote_settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, String(v));
  if (db.prepare('SELECT COUNT(*) AS c FROM quote_rates').get().c === 0) {
    const ins = db.prepare('INSERT INTO quote_rates (job, pay_rate, unit) VALUES (?, ?, ?)');
    db.transaction(() => { for (const [job, rate, unit] of SEED_RATES) ins.run(job, rate, unit || 'hour'); })();
  }
}

function getSettings() {
  const s = { ...DEFAULT_SETTINGS };
  for (const r of db.prepare('SELECT key, value FROM quote_settings').all()) {
    const n = Number(r.value);
    s[r.key] = Number.isFinite(n) ? n : r.value;
  }
  return s;
}

function cleanShifts(list) {
  return Array.isArray(list) ? list.slice(0, 31).map(sh => ({
    date: String(sh.date || '').slice(0, 10), in: String(sh.in || '').slice(0, 5), out: String(sh.out || '').slice(0, 5),
  })) : [];
}

function cleanData(data) {
  const d = data && typeof data === 'object' ? data : {};
  const schedule = cleanShifts(d.schedule);
  const lines = Array.isArray(d.lines) ? d.lines.slice(0, 200).map(l => ({
    craft: String(l.craft || '').slice(0, 120),
    qty: Number(l.qty) || 0,
    rate: Number(l.rate) || 0,
    unit: l.unit === 'day' ? 'day' : 'hour',
    use_schedule: l.use_schedule !== false,
    shifts: l.use_schedule !== false ? schedule : cleanShifts(l.shifts),
    nights: Number(l.nights) || 0,
    perdiem_days: Number(l.perdiem_days) || 0,
    travel_from: String(l.travel_from || '').slice(0, 120),
    rt_miles: Number(l.rt_miles) || 0,
  })) : [];
  return {
    schedule,
    lines,
    payroll_fee_pct: d.payroll_fee_pct === '' || d.payroll_fee_pct == null ? null : Number(d.payroll_fee_pct),
    include_expenses: d.include_expenses !== false,
  };
}

const QUOTE_FIELDS = ['client', 'event_name', 'venue', 'location_city', 'start_date', 'end_date', 'status', 'notes'];
const STATUSES = ['draft', 'sent', 'accepted', 'declined'];

function rowToQuote(r) {
  return { ...r, data: JSON.parse(r.data) };
}

// ---- Settings + rates ----
router.get('/config', (req, res) => {
  res.json({
    settings: getSettings(),
    rates: db.prepare('SELECT * FROM quote_rates ORDER BY job COLLATE NOCASE').all(),
    mapsEnabled: !!process.env.GOOGLE_MAPS_API_KEY,
  });
});

router.put('/settings', (req, res) => {
  const up = db.prepare('INSERT INTO quote_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  db.transaction(() => {
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (req.body[k] === undefined) continue;
      const n = Number(req.body[k]);
      if (!Number.isFinite(n) || n < 0) continue;
      up.run(k, String(n));
    }
  })();
  res.json({ settings: getSettings() });
});

router.post('/rates', (req, res) => {
  const job = String(req.body.job || '').trim();
  const pay = Number(req.body.pay_rate);
  if (!job || !Number.isFinite(pay)) return res.status(400).json({ error: 'Job and pay rate are required' });
  try {
    const info = db.prepare('INSERT INTO quote_rates (job, pay_rate, unit) VALUES (?, ?, ?)')
      .run(job, pay, req.body.unit === 'day' ? 'day' : 'hour');
    res.json(db.prepare('SELECT * FROM quote_rates WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(400).json({ error: 'That job is already in the list' });
    throw e;
  }
});

router.put('/rates/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM quote_rates WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Rate not found' });
  const job = req.body.job != null ? String(req.body.job).trim() : r.job;
  const pay = req.body.pay_rate != null ? Number(req.body.pay_rate) : r.pay_rate;
  const unit = req.body.unit ? (req.body.unit === 'day' ? 'day' : 'hour') : r.unit;
  if (!job || !Number.isFinite(pay)) return res.status(400).json({ error: 'Job and pay rate are required' });
  db.prepare('UPDATE quote_rates SET job = ?, pay_rate = ?, unit = ? WHERE id = ?').run(job, pay, unit, r.id);
  res.json(db.prepare('SELECT * FROM quote_rates WHERE id = ?').get(r.id));
});

router.delete('/rates/:id', (req, res) => {
  db.prepare('DELETE FROM quote_rates WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ---- Mileage ----
router.get('/distance', async (req, res) => {
  const origin = String(req.query.origin || '').trim();
  const destination = String(req.query.destination || '').trim();
  if (!origin || !destination) return res.status(400).json({ error: 'Both cities are required' });
  const cached = db.prepare('SELECT miles FROM quote_distances WHERE origin = ? AND destination = ?').get(origin, destination)
    || db.prepare('SELECT miles FROM quote_distances WHERE origin = ? AND destination = ?').get(destination, origin);
  if (cached) return res.json({ miles: cached.miles, roundTrip: Math.round(cached.miles * 2), cached: true });
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return res.status(503).json({ error: 'Mileage lookup is not set up; enter round-trip miles by hand' });
  try {
    const url = 'https://maps.googleapis.com/maps/api/distancematrix/json?units=imperial'
      + `&origins=${encodeURIComponent(origin)}&destinations=${encodeURIComponent(destination)}&key=${key}`;
    const r = await fetch(url);
    const j = await r.json();
    const el = j.rows && j.rows[0] && j.rows[0].elements && j.rows[0].elements[0];
    if (j.status !== 'OK' || !el || el.status !== 'OK') {
      return res.status(404).json({ error: 'No driving route found between those cities' });
    }
    const miles = Math.round(el.distance.value / 1609.344 * 10) / 10;
    db.prepare('INSERT OR REPLACE INTO quote_distances (origin, destination, miles) VALUES (?, ?, ?)').run(origin, destination, miles);
    res.json({ miles, roundTrip: Math.round(miles * 2), cached: false });
  } catch (e) {
    console.error('distance lookup failed', e);
    res.status(502).json({ error: 'Mileage lookup failed; enter round-trip miles by hand' });
  }
});

// ---- Quotes ----
router.get('/', (req, res) => {
  const rows = db.prepare(`SELECT id, client, event_name, venue, location_city, start_date, end_date, status, total, updated_at
    FROM quotes ORDER BY updated_at DESC`).all();
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Quote not found' });
  res.json(rowToQuote(r));
});

function quoteValues(body) {
  const v = {};
  for (const f of QUOTE_FIELDS) v[f] = body[f] == null ? null : String(body[f]).slice(0, f === 'notes' ? 5000 : 200);
  if (!STATUSES.includes(v.status)) v.status = 'draft';
  const data = cleanData(body.data);
  v.data = JSON.stringify(data);
  v.total = calcQuote(data, getSettings()).total;
  return v;
}

router.post('/', (req, res) => {
  const v = quoteValues(req.body);
  const info = db.prepare(`INSERT INTO quotes (client, event_name, venue, location_city, start_date, end_date, status, notes, data, total, created_by)
    VALUES (@client, @event_name, @venue, @location_city, @start_date, @end_date, @status, @notes, @data, @total, @created_by)`)
    .run({ ...v, created_by: req.session.adminId });
  res.json(rowToQuote(db.prepare('SELECT * FROM quotes WHERE id = ?').get(info.lastInsertRowid)));
});

router.put('/:id', (req, res) => {
  if (!db.prepare('SELECT id FROM quotes WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Quote not found' });
  const v = quoteValues(req.body);
  db.prepare(`UPDATE quotes SET client = @client, event_name = @event_name, venue = @venue, location_city = @location_city,
    start_date = @start_date, end_date = @end_date, status = @status, notes = @notes, data = @data, total = @total,
    updated_at = datetime('now') WHERE id = @id`).run({ ...v, id: req.params.id });
  res.json(rowToQuote(db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id)));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM quotes WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
