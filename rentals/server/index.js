const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const express = require('express');
const session = require('express-session');
const auth = require('./auth');
const rq = require('./requests');

const PORT = Number(process.env.PORT) || 4800;
const PUBLIC = path.join(__dirname, '..', 'public');
const PROD = process.env.NODE_ENV === 'production';
if (!process.env.SESSION_SECRET) throw new Error('SESSION_SECRET is not set');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  });
  next();
});
app.use(express.json({ limit: '128kb' }));
app.use(session({
  name: 'rentals.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 12 * 60 * 60 * 1000 },
}));

// Public ---------------------------------------------------------------------
app.get('/api/catalog', (req, res) => res.json(rq.catalog));

const SUBMIT_LIMIT = 6;
const SUBMIT_WINDOW_MS = 60 * 60 * 1000;
const submits = new Map();
setInterval(() => {
  const cutoff = Date.now() - SUBMIT_WINDOW_MS;
  for (const [ip, times] of submits) {
    const kept = times.filter((t) => t > cutoff);
    if (kept.length) submits.set(ip, kept); else submits.delete(ip);
  }
}, SUBMIT_WINDOW_MS).unref();

app.post('/api/requests', (req, res) => {
  const body = req.body || {};
  // Hidden field people never see; pretend it worked so a bot doesn't adapt.
  if (body.website) return res.json({ ok: true, ref: 'R-RECEIVED' });

  const recent = (submits.get(req.ip) || []).filter((t) => t > Date.now() - SUBMIT_WINDOW_MS);
  if (recent.length >= SUBMIT_LIMIT) {
    return res.status(429).json({ error: 'Too many requests from this connection. Please try again in an hour.' });
  }
  const { errors, value, items } = rq.validate(body);
  if (errors) return res.status(400).json({ error: 'Please fix the highlighted fields.', fields: errors });

  const ref = rq.saveRequest(value, items);
  recent.push(Date.now());
  submits.set(req.ip, recent);
  res.status(201).json({ ok: true, ref });
});

// Private inbox --------------------------------------------------------------
app.post('/api/login', auth.login);
app.post('/api/logout', auth.logout);
app.get('/admin', auth.requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

app.get('/api/admin/requests', auth.requireAuth, (req, res) => {
  res.json({ statuses: rq.STATUSES, requests: rq.listRequests() });
});
app.get('/api/admin/requests/:id', auth.requireAuth, (req, res) => {
  const r = rq.getRequest(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Request not found' });
  res.json(r);
});
app.put('/api/admin/requests/:id', auth.requireAuth, (req, res) => {
  const { status, internal_notes } = req.body || {};
  if (!rq.STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status' });
  if (!rq.updateRequest(Number(req.params.id), { status, internal_notes })) return res.status(404).json({ error: 'Request not found' });
  res.json({ ok: true });
});

app.use(express.static(PUBLIC));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    return res.status(400).json({ error: 'That request could not be read.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our end. Please try again.' });
});

app.listen(PORT, '127.0.0.1', () => console.log(`rentals-odoubleg on 127.0.0.1:${PORT}`));
