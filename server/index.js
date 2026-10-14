const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const session = require('express-session');

const { login, logout, requireAuth, requireAdmin } = require('./auth');
const { getApStatus, listSites, acknowledge } = require('./mist');
const { recordAck, listHistory } = require('./history');
const { setClosed } = require('./seasonState');
const { today, getContract, contractStatus, hasActiveContract, setContract, deleteContract } = require('./contracts');

const app = express();
const PORT = process.env.PORT || 3600;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// Outside PUBLIC_DIR so the static handler can't serve it ahead of requireAdmin.
const ADMIN_DIR = path.join(__dirname, '..', 'admin');
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
  // Reopening is always allowed; closing needs a site contract covering today.
  if (body.closed && !hasActiveContract(device.siteId)) {
    return res.status(403).json({ error: `${device.siteName} has no active contract, so its devices can't be put in vacation mode` });
  }

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

app.get('/api/me', (req, res) => res.json({
  user: req.session.admin ? process.env.ADMIN_USERNAME : process.env.APP_USERNAME,
  admin: !!req.session.admin,
}));

app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(ADMIN_DIR, 'admin.html')));
app.get('/admin.js', requireAdmin, (req, res) => res.sendFile(path.join(ADMIN_DIR, 'admin.js')));

app.get('/api/admin/sites', requireAdmin, async (req, res) => {
  try {
    const { sites, warnings } = await listSites();
    // closed-device counts come from the cached status the dashboard already uses
    const closedBySite = new Map();
    try {
      for (const d of (await getCachedApStatus()).closed) {
        closedBySite.set(d.siteId, (closedBySite.get(d.siteId) || 0) + 1);
      }
    } catch (err) {
      console.error('Failed to count closed devices for admin page:', err.message);
    }
    const day = today();
    res.json({
      today: day,
      warnings,
      sites: sites.map((s) => {
        const contract = getContract(s.id);
        return { ...s, contract, status: contractStatus(contract, day), closed: closedBySite.get(s.id) || 0 };
      }),
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Failed to reach Mist API', detail: err.message });
  }
});

app.put('/api/admin/contracts/:siteId', requireAdmin, async (req, res) => {
  const body = req.body || {};
  let site = null;
  try {
    site = (await listSites()).sites.find((s) => s.id === req.params.siteId);
  } catch (err) {
    console.error('Failed to look up site for contract:', err.message);
  }
  if (!site) return res.status(404).json({ error: 'Unknown site id' });

  const result = setContract(site.id, { ...body, siteName: site.name, orgName: site.orgName });
  if (!result.ok) return res.status(400).json({ error: result.error });
  // a shortened contract may need to reopen devices on the next poll
  cache.expiresAt = 0;
  res.json({ ok: true, contract: result.contract, status: contractStatus(result.contract) });
});

app.delete('/api/admin/contracts/:siteId', requireAdmin, (req, res) => {
  deleteContract(req.params.siteId);
  cache.expiresAt = 0;
  res.json({ ok: true });
});

app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.listen(PORT, () => {
  console.log(`mist.odoubleg.com server running on port ${PORT}`);
});
