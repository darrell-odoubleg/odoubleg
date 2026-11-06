// Email/password logins for the request inbox (users table, scrypt hashes). Add
// or reset one with `node scripts/user.js <email> <name> [password]`.
const crypto = require('crypto');
const db = require('./db');

const MAX_FAILS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const fails = new Map();

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(got, Buffer.from(hash, 'hex'));
}
// Same work whether or not the email exists.
const DUMMY = hashPassword(crypto.randomBytes(8).toString('hex'));

function login(req, res) {
  const now = Date.now();
  const entry = fails.get(req.ip);
  if (entry && now - entry.first < WINDOW_MS && entry.count >= MAX_FAILS) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim());
  const ok = checkPassword(password, user ? user.password_hash : DUMMY) && !!user;
  if (!ok) {
    if (!entry || now - entry.first >= WINDOW_MS) fails.set(req.ip, { first: now, count: 1 });
    else entry.count += 1;
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  fails.delete(req.ip);
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Could not sign in' });
    req.session.userId = user.id;
    res.json({ ok: true, name: user.name });
  });
}

function logout(req, res) {
  req.session.destroy(() => { res.clearCookie('rentals.sid'); res.json({ ok: true }); });
}

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in' });
  return res.redirect('/login.html');
}

module.exports = { login, logout, requireAuth, hashPassword };
