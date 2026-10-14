const APP_USERNAME = process.env.APP_USERNAME;
const APP_PASSWORD = process.env.APP_PASSWORD;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// Admins sign in through the same form; their session can do everything the
// shared login can, plus manage site contracts.
function login(req, res) {
  const { username, password } = req.body || {};
  if (ADMIN_USERNAME && ADMIN_PASSWORD && username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.authed = true;
    req.session.admin = true;
    return res.json({ ok: true });
  }
  if (username === APP_USERNAME && password === APP_PASSWORD) {
    req.session.authed = true;
    req.session.admin = false;
    return res.json({ ok: true });
  }
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

function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Admin login required' });
  return res.redirect('/login.html?admin=1');
}

module.exports = { login, logout, requireAuth, requireAdmin };
