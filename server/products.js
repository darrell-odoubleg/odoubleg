// The gear list. data/catalog.json only seeds a brand-new database; after that the
// admin page owns the list, so deleted products stay deleted across restarts.
// Requests store the gear name as text, so deleting a product leaves them intact.
const crypto = require('crypto');
const db = require('./db');
const seed = require('../data/catalog.json');

const MAX_MAKES = 8;
const oneLine = (v, max) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ').slice(0, max);
const slug = (s) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const fresh = !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'products'").get();
db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  makes TEXT NOT NULL DEFAULT '[]',
  popular INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL
);
`);
if (fresh) {
  const popular = new Set(seed.popular);
  const insert = db.prepare('INSERT INTO products (id, name, category, makes, popular, sort) VALUES (?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    seed.items.forEach((i, n) => insert.run(i.id, i.name, i.category, JSON.stringify(i.makes), popular.has(i.id) ? 1 : 0, n));
  })();
}

const shape = (r) => ({ id: r.id, name: r.name, category: r.category, makes: JSON.parse(r.makes) });

function catalog() {
  const rows = db.prepare('SELECT * FROM products ORDER BY sort, id').all();
  return {
    categories: [...new Set(rows.map((r) => r.category))],
    popular: rows.filter((r) => r.popular).map((r) => r.id),
    items: rows.map(shape),
  };
}

function get(id) {
  const r = db.prepare('SELECT * FROM products WHERE id = ?').get(String(id));
  return r ? shape(r) : null;
}

// Returns { product }, or { error, status }.
function add(body) {
  const b = body && typeof body === 'object' ? body : {};
  const name = oneLine(b.name, 100);
  let category = oneLine(b.category, 60);
  if (!name) return { status: 400, error: 'Enter a product name.' };
  if (!category) return { status: 400, error: 'Choose or enter a category.' };

  if (db.prepare('SELECT 1 FROM products WHERE name = ? COLLATE NOCASE').get(name)) {
    return { status: 409, error: `"${name}" is already on the list.` };
  }
  // "drums" joins the existing "Drums" category rather than starting a second one.
  const existing = db.prepare('SELECT category FROM products WHERE category = ? COLLATE NOCASE LIMIT 1').get(category);
  if (existing) category = existing.category;

  const makes = [...new Set(String(b.makes == null ? '' : b.makes).split(',').map((m) => oneLine(m, 40)).filter(Boolean))].slice(0, MAX_MAKES);
  let id = slug(name) || `item-${crypto.randomBytes(3).toString('hex')}`;
  if (db.prepare('SELECT 1 FROM products WHERE id = ?').get(id)) id = `${id}-${crypto.randomBytes(2).toString('hex')}`;
  const { next } = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS next FROM products').get();
  db.prepare('INSERT INTO products (id, name, category, makes, sort) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, category, JSON.stringify(makes), next);
  return { product: get(id) };
}

const remove = (id) => db.prepare('DELETE FROM products WHERE id = ?').run(String(id)).changes;

module.exports = { catalog, get, add, remove };
