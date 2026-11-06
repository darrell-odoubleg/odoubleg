// Public request intake and the private inbox queries.
const crypto = require('crypto');
const db = require('./db');
const products = require('./products');

const STATUSES = ['New', 'Quoted', 'Booked', 'Declined', 'Closed'];
const DELIVERY = ['Deliver to venue', 'Pick up', 'Not sure yet'];
const MAX_LINES = 150;
const MAX_QTY = 99;
const CUSTOM = 'Custom request';

const text = (v, max) => String(v == null ? '' : v).replace(/\r\n/g, '\n').trim().slice(0, max);
const oneLine = (v, max) => text(v, max).replace(/\s+/g, ' ');

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Checks everything except the gear. Returns { errors, value }.
function validateFields(b, { allowPast = false } = {}) {
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
  else if (!allowPast && value.start_date < yesterday) errors.start_date = 'This date has already passed.';
  if (!validDate(value.end_date)) errors.end_date = 'Enter the last day you need the gear.';
  else if (!errors.start_date && value.end_date < value.start_date) errors.end_date = 'This can\'t be before the first day.';

  return { errors, value };
}

// Returns { errors } keyed by field, or { value, items } ready to save.
function validate(body) {
  const b = body && typeof body === 'object' ? body : {};
  const { errors, value } = validateFields(b);
  const lines = Array.isArray(b.items) ? b.items : [];
  const items = [];
  const seen = new Set();
  let badLine = lines.length > MAX_LINES;
  for (const line of lines.slice(0, MAX_LINES)) {
    const qty = Number(line && line.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) { badLine = true; continue; }
    if (line.custom) {
      const name = oneLine(line.name, 200);
      if (!name) { badLine = true; continue; }
      items.push({ gear: name, category: CUSTOM, qty, spec: oneLine(line.spec, 500) });
      continue;
    }
    const gear = products.get(line.id);
    if (!gear || seen.has(gear.id)) { badLine = true; continue; }
    seen.add(gear.id);
    items.push({ gear: gear.name, category: gear.category, qty, spec: oneLine(line.spec, 200) });
  }
  if (badLine) errors.items = 'Something in your gear list wasn\'t recognized. Reload the page and try again.';
  else if (!items.length) errors.items = 'Add at least one item or a custom request.';

  return Object.keys(errors).length ? { errors } : { value, items };
}

const insertRequest = db.prepare(`INSERT INTO requests
  (ref, name, company, email, phone, event_name, venue, city_state, start_date, end_date, artist, delivery, notes)
  VALUES (@ref, @name, @company, @email, @phone, @event_name, @venue, @city_state, @start_date, @end_date, @artist, @delivery, @notes)`);
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
  r.original = r.original ? JSON.parse(r.original) : null;
  return r;
}

function updateRequest(id, { status, internal_notes }) {
  return db.prepare(`UPDATE requests SET status = ?, internal_notes = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(status, text(internal_notes, 5000), id).changes;
}

const DETAIL_FIELDS = ['name', 'company', 'email', 'phone', 'event_name', 'venue', 'city_state', 'start_date', 'end_date', 'artist', 'delivery', 'notes'];
const snapshot = (r) => ({ ...Object.fromEntries(DETAIL_FIELDS.map((f) => [f, r[f]])), items: r.items });

// Staff edits. Past dates are allowed, since an old request may need correcting. An item
// may no longer be on the product list, so names are free text: an item already on the
// request keeps its category, one matching a product takes that product's name and
// category, and anything else counts as custom.
function editRequest(id, body) {
  const current = getRequest(id);
  if (!current) return { status: 404, error: 'Request not found' };
  const b = body && typeof body === 'object' ? body : {};
  const { errors, value } = validateFields(b, { allowPast: true });

  const lines = Array.isArray(b.items) ? b.items : [];
  const items = [];
  let badLine = lines.length > MAX_LINES;
  for (const line of lines.slice(0, MAX_LINES)) {
    const gear = oneLine(line && line.gear, 200);
    const qty = Number(line && line.qty);
    if (!gear || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) { badLine = true; continue; }
    const spec = oneLine(line.spec, 500);
    const already = current.items.find((i) => i.gear === gear);
    const product = already ? null : products.getByName(gear);
    if (already) items.push({ gear, category: already.category, qty, spec });
    else if (product) items.push({ gear: product.name, category: product.category, qty, spec });
    else items.push({ gear, category: CUSTOM, qty, spec });
  }
  if (badLine) errors.items = `Each item needs a name and a quantity from 1 to ${MAX_QTY}.`;
  else if (!items.length) errors.items = 'A request needs at least one item.';
  if (Object.keys(errors).length) return { status: 400, error: 'Please fix the highlighted fields.', fields: errors };

  const before = snapshot(current);
  const after = { ...value, items };
  if (JSON.stringify(before) === JSON.stringify(snapshot(after))) return { ok: true, changed: false };

  db.transaction(() => {
    const original = current.original ? JSON.stringify(current.original) : JSON.stringify(before);
    db.prepare(`UPDATE requests SET name = @name, company = @company, email = @email, phone = @phone,
        event_name = @event_name, venue = @venue, city_state = @city_state, start_date = @start_date,
        end_date = @end_date, artist = @artist, delivery = @delivery, notes = @notes, original = @original,
        edited_at = datetime('now'), updated_at = datetime('now') WHERE id = @id`).run({ ...value, original, id });
    db.prepare('DELETE FROM request_items WHERE request_id = ?').run(id);
    for (const i of items) insertItem.run(id, i.gear, i.category, i.qty, i.spec);
  })();
  return { ok: true, changed: true };
}

module.exports = { STATUSES, CUSTOM, validate, saveRequest, listRequests, getRequest, updateRequest, editRequest };
