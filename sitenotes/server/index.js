const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const session = require('express-session');

const { login, logout, requireAuth } = require('./auth');
const notesRouter = require('../routes/notes');

const app = express();
const PORT = process.env.PORT || 3700;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || 'sitenotes.odoubleg.com';

// nginx terminates TLS in front of this app.
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Single shared login, low traffic — MemoryStore is fine here.
app.use(session({
  name: 'sitenotesid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  proxy: true,
  cookie: {
    domain: COOKIE_DOMAIN,
    secure: process.env.COOKIE_SECURE !== 'false',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 12 * 60 * 60 * 1000,
  },
}));

app.post('/login', login);
app.post('/logout', logout);
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// index:false so /login.html isn't silently served at "/" ahead of requireAuth.
app.use(express.static(PUBLIC_DIR, { index: false }));

app.use(requireAuth);

app.use('/api', notesRouter);

app.get('/api/me', (req, res) => res.json({ user: process.env.APP_USERNAME }));

app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.listen(PORT, () => {
  console.log(`sitenotes.odoubleg.com server running on port ${PORT}`);
});
