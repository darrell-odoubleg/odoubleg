const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const session = require('express-session');

const { login, logout, requireAuth } = require('./auth');
const { agent, dashboard } = require('./routes');

const app = express();
const PORT = process.env.PORT || 3900;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || 'stocks.odoubleg.com';

// nginx terminates TLS in front of this app.
app.set('trust proxy', 1);

app.use(express.json({ limit: '1mb' }));

// The scheduled routine authenticates with a bearer token, not a session.
app.use('/api/agent', agent);

// Single login, low traffic — MemoryStore is fine here.
app.use(session({
  name: 'stocksid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  proxy: true,
  cookie: {
    domain: COOKIE_DOMAIN,
    secure: process.env.COOKIE_SECURE !== 'false',
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 12 * 60 * 60 * 1000,
  },
}));

app.post('/login', login);
app.post('/logout', logout);
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// index:false so /login.html isn't silently served at "/" ahead of requireAuth.
app.use(express.static(PUBLIC_DIR, { index: false }));

app.use(requireAuth);

app.use('/api', dashboard);

app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`stocks.odoubleg.com server running on port ${PORT}`);
});
