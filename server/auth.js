const crypto = require('crypto');

const APP_USERNAME = process.env.APP_USERNAME;
const APP_PASSWORD = process.env.APP_PASSWORD;

// This login can switch real-money trading on, so throttle guessing.
const MAX_FAILS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const fails = new Map();

function same(a, b) {
  const ha = crypto.createHash('sha256').update(String(a || '')).digest();
  const hb = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function login(req, res) {
  const now = Date.now();
  const entry = fails.get(req.ip);
  if (entry && now - entry.first < WINDOW_MS && entry.count >= MAX_FAILS) {
    return res.status(429).json({ ok: false, error: 'Too many attempts — try again in 15 minutes' });
  }
  const { username, password } = req.body || {};
  if (APP_USERNAME && APP_PASSWORD && same(username, APP_USERNAME) && same(password, APP_PASSWORD)) {
    fails.delete(req.ip);
    return req.session.regenerate(() => {
      req.session.authed = true;
      res.json({ ok: true });
    });
  }
  if (!entry || now - entry.first >= WINDOW_MS) fails.set(req.ip, { first: now, count: 1 });
  else entry.count += 1;
  return res.status(401).json({ ok: false, error: 'Invalid username or password' });
}

function logout(req, res) {
  req.session.destroy(() => res.json({ ok: true }));
}

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  return res.redirect('/login.html');
}

module.exports = { login, logout, requireAuth };
