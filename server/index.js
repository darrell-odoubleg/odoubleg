require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const { db, getSettings, setSetting, DEFAULT_SETTINGS, checkPassword } = require('./db');
const mist = require('./mist');
const county = require('./countyFeed');

const PORT = process.env.PORT || 4400;
const TZ = process.env.TZ_NAME || 'America/Denver';
const APK_DIR = path.join(__dirname, '..', 'data', 'apk');
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

// Sessions live in SQLite so restarts don't sign everyone out.
class SqliteStore extends session.Store {
  get(sid, cb) {
    const row = db.prepare('SELECT data, expires FROM sessions WHERE sid = ?').get(sid);
    if (!row || row.expires < Date.now()) return cb(null, null);
    cb(null, JSON.parse(row.data));
  }
  set(sid, sess, cb) {
    const expires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
    db.prepare('INSERT OR REPLACE INTO sessions (sid, data, expires) VALUES (?, ?, ?)').run(sid, JSON.stringify(sess), expires);
    cb && cb(null);
  }
  destroy(sid, cb) {
    db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
    cb && cb(null);
  }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()), 3600000).unref();

app.use(session({
  store: new SqliteStore(),
  name: 'msf.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === '1', maxAge: 14 * 86400000 },
}));

// ---------- helpers ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function localNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function dateRange(start, end) {
  if (!DATE_RE.test(start) || !DATE_RE.test(end) || end < start) return [];
  const out = [];
  const d = new Date(start + 'T12:00:00Z');
  const last = new Date(end + 'T12:00:00Z');
  while (d <= last && out.length < 60) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// Public events: not hidden, and county imports only while the feed is switched on.
function visibleWhere(s = getSettings()) {
  return s.county_feed_enabled === '0' ? "e.hidden = 0 AND e.source <> 'county'" : 'e.hidden = 0';
}

// Day tabs: every fair day, plus upcoming days that have something on at the ExpoPark.
function scheduleDays(s = getSettings()) {
  const fair = dateRange(s.fair_start, s.fair_end);
  const upcoming = db.prepare(`SELECT DISTINCT e.date FROM events e WHERE ${visibleWhere(s)} AND e.date >= ? ORDER BY e.date LIMIT 45`)
    .all(localNow().date).map((r) => r.date);
  return [...new Set([...fair, ...upcoming])].sort();
}

const EVENT_SELECT = `
  SELECT e.*, l.name AS location_name, l.map_id, l.x, l.y
  FROM events e LEFT JOIN locations l ON l.id = e.location_id`;

function cleanEvent(b) {
  const title = String(b.title || '').trim();
  if (!title) throw new Error('Title is required');
  const allDay = b.all_day ? 1 : 0;
  if (allDay) { b.start_time = '00:00'; b.end_time = ''; }
  if (!TIME_RE.test(b.start_time || '')) throw new Error('Start time is required');
  if (b.end_time && !TIME_RE.test(b.end_time)) throw new Error('End time is not valid');
  const locId = b.location_id ? Number(b.location_id) : null;
  if (locId && !db.prepare('SELECT 1 FROM locations WHERE id = ?').get(locId)) throw new Error('Unknown location');
  return {
    title: title.slice(0, 200),
    description: String(b.description || '').trim().slice(0, 4000) || null,
    start_time: b.start_time,
    end_time: b.end_time || null,
    all_day: allDay,
    location_id: locId,
    location_text: String(b.location_text || '').trim().slice(0, 200) || null,
    category: String(b.category || '').trim().slice(0, 40) || null,
    featured: b.featured ? 1 : 0,
    cancelled: b.cancelled ? 1 : 0,
  };
}

function cleanLocation(b) {
  const name = String(b.name || '').trim();
  if (!name) throw new Error('Name is required');
  const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    name: name.slice(0, 120),
    map_id: b.map_id ? String(b.map_id) : null,
    x: num(b.x),
    y: num(b.y),
    notes: String(b.notes || '').trim().slice(0, 500) || null,
    sort: Number.isInteger(Number(b.sort)) ? Number(b.sort) : 0,
  };
}

// ---------- auth ----------
const MAX_FAILS = 8;
const WINDOW_MS = 15 * 60 * 1000;
const fails = new Map();

function currentUser(req) {
  if (!req.session || !req.session.userId) return null;
  return db.prepare('SELECT id, username, name FROM users WHERE id = ?').get(req.session.userId) || null;
}

function requireAdmin(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Not signed in' });
  req.user = u;
  next();
}

app.post('/api/login', (req, res) => {
  const now = Date.now();
  const key = req.ip;
  const f = fails.get(key);
  if (f && f.count >= MAX_FAILS && now - f.first < WINDOW_MS) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
  if (!u || !checkPassword(password || '', u.password_hash)) {
    const cur = f && now - f.first < WINDOW_MS ? f : { count: 0, first: now };
    cur.count++;
    fails.set(key, cur);
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  fails.delete(key);
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Session error' });
    req.session.userId = u.id;
    res.json({ user: { id: u.id, username: u.username, name: u.name } });
  });
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', (req, res) => res.json({ user: currentUser(req) }));

// ---------- public API ----------
app.get('/api/info', (req, res) => {
  const s = getSettings();
  res.json({
    fair_name: s.fair_name,
    fair_start: s.fair_start,
    fair_end: s.fair_end,
    kiosk_speed: Number(s.kiosk_speed) || 40,
    days: scheduleDays(s),
    fair_days: dateRange(s.fair_start, s.fair_end),
    now: localNow(),
    tz: TZ,
    apk: fs.existsSync(path.join(APK_DIR, 'msf.apk')),
  });
});

// ?all=1 (signed-in admins only) includes hidden events.
app.get('/api/events', (req, res) => {
  const { date, from, to } = req.query;
  const vis = req.query.all === '1' && currentUser(req) ? '1 = 1' : visibleWhere();
  const order = 'ORDER BY e.date, e.all_day DESC, e.start_time, e.title';
  let rows;
  if (DATE_RE.test(date || '')) {
    rows = db.prepare(`${EVENT_SELECT} WHERE ${vis} AND e.date = ? ${order}`).all(date);
  } else if (DATE_RE.test(from || '') && DATE_RE.test(to || '')) {
    rows = db.prepare(`${EVENT_SELECT} WHERE ${vis} AND e.date BETWEEN ? AND ? ${order}`).all(from, to);
  } else {
    rows = db.prepare(`${EVENT_SELECT} WHERE ${vis} ${order}`).all();
  }
  res.set('Cache-Control', 'no-store').json({ events: rows, now: localNow() });
});

app.get('/api/locations', (req, res) => {
  res.json({ locations: db.prepare('SELECT * FROM locations ORDER BY sort, name').all() });
});

// The printed fairgrounds map comes first; Mist floor plans follow. It has no real scale,
// so ppm is 1 and location x/y on it are image pixels. Only Mist maps support indoor location.
const FAIRGROUNDS_IMG = path.join(__dirname, '..', 'assets', 'fairgrounds-map.png');
const FAIRGROUNDS = { id: 'fairgrounds', name: 'Fairgrounds', width: 1680, height: 1100, ppm: 1, width_m: 1680, height_m: 1100, wayfinding: [], static: true, center: [570, 640] };

app.get('/api/maps', async (req, res) => {
  try {
    res.json({ maps: [FAIRGROUNDS, ...await mist.listMaps()] });
  } catch (err) {
    console.error('[maps]', err.message);
    res.json({ maps: [FAIRGROUNDS] });
  }
});

app.get('/api/maps/:id/image', async (req, res) => {
  if (req.params.id === FAIRGROUNDS.id) return res.set('Cache-Control', 'public, max-age=3600').sendFile(FAIRGROUNDS_IMG);
  try {
    const file = await mist.mapImagePath(req.params.id);
    if (!file) return res.status(404).end();
    const head = Buffer.alloc(4);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    const type = head[0] === 0x89 ? 'image/png' : head[0] === 0x47 ? 'image/gif' : 'image/jpeg';
    res.set('Cache-Control', 'public, max-age=3600').type(type).sendFile(file);
  } catch (err) {
    console.error('[map image]', err.message);
    res.status(502).end();
  }
});

// Runtime config for the Android app, so the Mist SDK secret can be set or rotated without a new APK.
// The SDK secret is meant to ship inside client apps; it only enrolls devices for location.
app.get('/api/app-config', (req, res) => {
  const s = getSettings();
  res.set('Cache-Control', 'no-store').json({
    mist: {
      enabled: Boolean(s.mist_sdk_token),
      token: s.mist_sdk_token || '',
      org_id: process.env.MIST_ORG_ID || '',
    },
  });
});

app.get('/download', (req, res) => {
  const file = path.join(APK_DIR, 'msf.apk');
  if (!fs.existsSync(file)) return res.status(404).send('The Android app has not been published yet.');
  res.download(file, 'MontanaStateFair.apk', { headers: { 'Content-Type': 'application/vnd.android.package-archive' } });
});

// ---------- admin API ----------
const insertEvent = db.prepare(`INSERT INTO events
  (title, description, date, start_time, end_time, all_day, location_id, location_text, category, featured, cancelled)
  VALUES (@title, @description, @date, @start_time, @end_time, @all_day, @location_id, @location_text, @category, @featured, @cancelled)`);

// One request can add the same event on several days (daily shows, multiple performances).
app.post('/api/events', requireAdmin, (req, res) => {
  try {
    const ev = cleanEvent(req.body);
    const dates = [...new Set([].concat(req.body.dates || req.body.date || []))].filter((d) => DATE_RE.test(d));
    if (!dates.length) throw new Error('Pick at least one day');
    const ids = db.transaction(() => dates.map((date) => insertEvent.run({ ...ev, date }).lastInsertRowid))();
    res.json({ ids });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/events/:id', requireAdmin, (req, res) => {
  try {
    const ev = cleanEvent(req.body);
    if (!DATE_RE.test(req.body.date || '')) throw new Error('Date is required');
    const cur = db.prepare('SELECT source FROM events WHERE id = ?').get(Number(req.params.id));
    if (cur && cur.source === 'county') throw new Error('County calendar events update from the feed. You can hide them or set their map location.');
    const r = db.prepare(`UPDATE events SET title=@title, description=@description, date=@date, start_time=@start_time,
      end_time=@end_time, all_day=@all_day, location_id=@location_id, location_text=@location_text, category=@category,
      featured=@featured, cancelled=@cancelled, updated_at=datetime('now') WHERE id=@id`)
      .run({ ...ev, date: req.body.date, id: Number(req.params.id) });
    if (!r.changes) return res.status(404).json({ error: 'Event not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/events/:id', requireAdmin, (req, res) => {
  db.prepare("DELETE FROM events WHERE id = ? AND source <> 'county'").run(Number(req.params.id));
  res.json({ ok: true });
});

// Imported events can't be edited (the next sync would undo it), but they can be hidden or pinned to a mapped location.
app.put('/api/events/:id/county', requireAdmin, (req, res) => {
  const b = req.body || {};
  const locId = b.location_id ? Number(b.location_id) : null;
  if (locId && !db.prepare('SELECT 1 FROM locations WHERE id = ?').get(locId)) return res.status(400).json({ error: 'Unknown location' });
  const r = db.prepare("UPDATE events SET hidden = ?, featured = ?, location_id = ? WHERE id = ? AND source = 'county'")
    .run(b.hidden ? 1 : 0, b.featured ? 1 : 0, locId, Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'Event not found' });
  res.json({ ok: true });
});

app.post('/api/county/sync', requireAdmin, async (req, res) => {
  res.json(await county.sync());
});

app.post('/api/locations', requireAdmin, (req, res) => {
  try {
    const l = cleanLocation(req.body);
    const r = db.prepare('INSERT INTO locations (name, map_id, x, y, notes, sort) VALUES (@name, @map_id, @x, @y, @notes, @sort)').run(l);
    res.json({ id: r.lastInsertRowid });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/locations/:id', requireAdmin, (req, res) => {
  try {
    const l = cleanLocation(req.body);
    db.prepare('UPDATE locations SET name=@name, map_id=@map_id, x=@x, y=@y, notes=@notes, sort=@sort WHERE id=@id')
      .run({ ...l, id: Number(req.params.id) });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/locations/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM locations WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.get('/api/settings', requireAdmin, (req, res) => res.json({ settings: getSettings() }));

app.put('/api/settings', requireAdmin, (req, res) => {
  const b = req.body || {};
  for (const k of ['fair_start', 'fair_end']) {
    if (b[k] && !DATE_RE.test(b[k])) return res.status(400).json({ error: 'Dates must be YYYY-MM-DD' });
  }
  if (b.fair_start && b.fair_end && b.fair_end < b.fair_start) return res.status(400).json({ error: 'The fair ends before it starts' });
  if (b.county_feed_url && !/^https:\/\//.test(b.county_feed_url)) return res.status(400).json({ error: 'The calendar link must start with https://' });
  const before = getSettings();
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (k in b) setSetting(k, String(b[k] ?? '').trim().slice(0, 500));
  }
  const after = getSettings();
  if (after.county_feed_url !== before.county_feed_url) county.sync();
  res.json({ settings: after });
});

// ---------- pages ----------
app.get('/kiosk', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'kiosk.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`msf-odoubleg listening on 127.0.0.1:${PORT}`);
  county.start();
});
