// Public request intake and the private inbox queries.
const crypto = require('crypto');
const db = require('./db');
const catalog = require('../data/catalog.json');

const STATUSES = ['New', 'Quoted', 'Booked', 'Declined', 'Closed'];
const DELIVERY = ['Deliver to venue', 'Pick up', 'Not sure yet'];
const MAX_LINES = 150;
const MAX_QTY = 99;
const byId = new Map(catalog.items.map((i) => [i.id, i]));

const text = (v, max) => String(v == null ? '' : v).replace(/\r\n/g, '\n').trim().slice(0, max);
const oneLine = (v, max) => text(v, max).replace(/\s+/g, ' ');

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Returns { errors } keyed by field, or { value } ready to save.
function validate(body) {
  const b = body && typeof body === 'object' ? body : {};
  const errors = {};
  const value = {
    name: oneLine(b.name, 120),
    company: oneLine(b.company, 160),
    email: oneLine(b.email, 200),
    phone: oneLine(b.phone, 40),
    event_name: oneLine(b.event_name, 200),
    venue: oneLine(b.venue, 200),
    city_state: oneLine(b.city_state, 120),
    start_date: oneLine(b.start_date, 10),
    end_date: oneLine(b.end_date, 10),
    artist: oneLine(b.artist, 160),
    delivery: oneLine(b.delivery, 40),
    other_gear: text(b.other_gear, 3000),
    notes: text(b.notes, 3000),
  };

  if (!value.name) errors.name = 'Enter your name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) errors.email = 'Enter a valid email address.';
  if ((value.phone.match(/\d/g) || []).length < 7) errors.phone = 'Enter a phone number.';
  if (!value.event_name) errors.event_name = 'Enter the event name.';
  if (!value.city_state) errors.city_state = 'Enter the city and state.';
  if (!DELIVERY.includes(value.delivery)) errors.delivery = 'Choose delivery or pick up.';

  // Yesterday is the cutoff so a requester a time zone behind the server isn't refused.
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  if (!validDate(value.start_date)) errors.start_date = 'Enter the first day you need the gear.';
  else if (value.start_date < yesterday) errors.start_date = 'This date has already passed.';
  if (!validDate(value.end_date)) errors.end_date = 'Enter the last day you need the gear.';
  else if (!errors.start_date && value.end_date < value.start_date) errors.end_date = 'This can\'t be before the first day.';

  const lines = Array.isArray(b.items) ? b.items : [];
  const items = [];
  const seen = new Set();
  let badLine = lines.length > MAX_LINES;
  for (const line of lines.slice(0, MAX_LINES)) {
    const gear = line && byId.get(line.id);
    const qty = Number(line && line.qty);
    if (!gear || seen.has(gear.id) || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) { badLine = true; continue; }
    seen.add(gear.id);
    items.push({ gear: gear.name, category: gear.category, qty, spec: oneLine(line.spec, 200) });
  }
  if (badLine) errors.items = 'Something in your gear list wasn\'t recognized. Reload the page and try again.';
  else if (!items.length && !value.other_gear) errors.items = 'Add at least one item, or describe what you need under "Anything else".';

  return Object.keys(errors).length ? { errors } : { value, items };
}

const insertRequest = db.prepare(`INSERT INTO requests
  (ref, name, company, email, phone, event_name, venue, city_state, start_date, end_date, artist, delivery, other_gear, notes)
  VALUES (@ref, @name, @company, @email, @phone, @event_name, @venue, @city_state, @start_date, @end_date, @artist, @delivery, @other_gear, @notes)`);
const insertItem = db.prepare('INSERT INTO request_items (request_id, gear, category, qty, spec) VALUES (?, ?, ?, ?, ?)');

const REF_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newRef() {
  let out = 'R-';
  for (let i = 0; i < 6; i++) out += REF_CHARS[crypto.randomInt(REF_CHARS.length)];
  return db.prepare('SELECT 1 FROM requests WHERE ref = ?').get(out) ? newRef() : out;
}

const saveRequest = db.transaction((value, items) => {
  const ref = newRef();
  const { lastInsertRowid } = insertRequest.run({ ...value, ref });
  for (const i of items) insertItem.run(lastInsertRowid, i.gear, i.category, i.qty, i.spec);
  return ref;
});

function listRequests() {
  return db.prepare(`SELECT r.id, r.ref, r.status, r.name, r.company, r.event_name, r.city_state,
      r.start_date, r.end_date, r.created_at, COALESCE(SUM(i.qty), 0) AS item_count
    FROM requests r LEFT JOIN request_items i ON i.request_id = r.id
    GROUP BY r.id ORDER BY r.created_at DESC, r.id DESC`).all();
}

function getRequest(id) {
  const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
  if (!r) return null;
  r.items = db.prepare('SELECT gear, category, qty, spec FROM request_items WHERE request_id = ? ORDER BY id').all(id);
  return r;
}

function updateRequest(id, { status, internal_notes }) {
  return db.prepare(`UPDATE requests SET status = ?, internal_notes = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(status, text(internal_notes, 5000), id).changes;
}

module.exports = { STATUSES, catalog, validate, saveRequest, listRequests, getRequest, updateRequest };
