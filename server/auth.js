const APP_USERNAME = process.env.APP_USERNAME;
const APP_PASSWORD = process.env.APP_PASSWORD;

function login(req, res) {
  const { username, password } = req.body || {};
  if (username === APP_USERNAME && password === APP_PASSWORD) {
    req.session.authed = true;
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

module.exports = { login, logout, requireAuth };
