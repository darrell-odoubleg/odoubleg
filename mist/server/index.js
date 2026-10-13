const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const session = require('express-session');

const { login, logout, requireAuth } = require('./auth');
const { getApStatus, acknowledge } = require('./mist');
const { recordAck, listHistory } = require('./history');
const { setClosed } = require('./seasonState');

const app = express();
const PORT = process.env.PORT || 3600;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || 'mist.odoubleg.com';

// nginx terminates TLS in front of this app.
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Single shared login, low traffic — MemoryStore is fine here.
app.use(session({
  name: 'mistid',
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

// Mist's API rate-limits, and one refresh now fans out to every org under
// the MSP, so cache longer than a single-org lookup would need.
const CACHE_MS = 45 * 1000;
let cache = { data: null, expiresAt: 0 };

async function getCachedApStatus() {
  if (!cache.data || Date.now() > cache.expiresAt) {
    cache.data = await getApStatus();
    cache.expiresAt = Date.now() + CACHE_MS;
  }
  return cache.data;
}

app.get('/api/aps', async (req, res) => {
  try {
    res.json(await getCachedApStatus());
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Failed to reach Mist API', detail: err.message });
  }
});

// Acknowledging updates the shared server-side state (not just the current
// cache snapshot) so the flash clears for every viewer, not just this tab.
// Requires a ServiceNow ticket number so every dismissed alert is traceable.
app.post('/api/aps/:id/ack', async (req, res) => {
  const result = acknowledge(req.params.id, req.body && req.body.ticket);
  if (!result.ok) {
    return res.status(result.error === 'Unknown AP id' ? 404 : 400).json({ error: result.error });
  }

  let ap = null;
  try {
    const data = await getCachedApStatus();
    ap = data.offline.find((a) => a.id === req.params.id);
    if (ap) { ap.acknowledged = true; ap.ticket = result.ticket; }
  } catch (err) {
    console.error('Failed to look up AP details for history record:', err.message);
  }

  recordAck({
    apId: req.params.id,
    apName: ap && ap.name,
    orgName: ap && ap.orgName,
    siteName: ap && ap.siteName,
    ticket: result.ticket,
  });
  res.json({ ok: true });
});

// Marks a single device closed (or reopened) for the season. The cached
// status is dropped so the next poll re-sorts it into the right list.
app.post('/api/devices/:id/season', async (req, res) => {
  const body = req.body || {};
  if (typeof body.closed !== 'boolean') {
    return res.status(400).json({ error: '`closed` must be true or false' });
  }

  let device = null;
  try {
    const data = await getCachedApStatus();
    device = [...data.online, ...data.offline, ...data.closed].find((d) => d.id === req.params.id);
  } catch (err) {
    console.error('Failed to look up device for season toggle:', err.message);
  }
  if (body.closed && !device) return res.status(404).json({ error: 'Unknown device id' });

  setClosed(req.params.id, body.closed, device ? {
    name: device.name,
    siteName: device.siteName,
    orgName: device.orgName,
  } : {});
  cache.expiresAt = 0;
  res.json({ ok: true });
});

app.get('/api/ack-history', (req, res) => {
  const apId = typeof req.query.apId === 'string' ? req.query.apId : undefined;
  res.json({ history: listHistory({ apId }) });
});

app.get('/api/me', (req, res) => res.json({ user: process.env.APP_USERNAME }));

app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.listen(PORT, () => {
  console.log(`mist.odoubleg.com server running on port ${PORT}`);
});
