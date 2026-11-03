// equifax.odoubleg.com: O Double G's payroll file for Equifax The Work Number.
// Form + uploads read by Claude + Equifax-format export (server/twn.js).
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const session = require('express-session');
const { login, logout, me, requireAuth } = require('./auth');

const app = express();
const PORT = process.env.PORT || 4700;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

app.set('trust proxy', 1); // nginx terminates TLS
app.use(express.json({ limit: '20mb' }));

// Few users, low traffic: MemoryStore is fine (a restart signs people out).
app.use(session({
  name: 'equifax.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  proxy: true,
  cookie: { secure: process.env.COOKIE_SECURE !== 'false', httpOnly: true, sameSite: 'strict', maxAge: 12 * 60 * 60 * 1000 },
}));

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.post('/api/login', express.json(), login);
app.post('/api/logout', logout);
app.get('/api/me', me);
app.get('/login.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.use('/css', express.static(path.join(PUBLIC_DIR, 'css')));

app.use(requireAuth);
app.use('/api/twn', require('./twn'));
app.use(express.static(PUBLIC_DIR));

app.listen(PORT, '127.0.0.1', () => console.log(`equifax.odoubleg.com running on port ${PORT}`));
