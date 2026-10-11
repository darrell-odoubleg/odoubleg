// Scholarship essays: a student keeps a profile (and uploads a resume,
// transcript, past essays...), adds scholarships with their prompts, and
// Claude drafts each essay from that material (services/essayWriter.js).
//
// Its own logins (scholar_users), separate from crew/admin: role "parent"
// can see every student and create student logins; a "student" sees only
// their own things. Sessions use req.session.scholarUserId.

const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const db = require('../db/init');
const writer = require('../services/essayWriter');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'scholarships');
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const ALLOWED_TYPES = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'text',
  'text/markdown': 'text',
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
};

db.exec(`
CREATE TABLE IF NOT EXISTS scholar_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student', -- student, parent
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scholar_profiles (
  student_id INTEGER PRIMARY KEY REFERENCES scholar_users(id) ON DELETE CASCADE,
  data TEXT NOT NULL DEFAULT '{}', -- JSON: { field: text }
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scholar_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES scholar_users(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  description TEXT,
  uploaded_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scholar_essays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES scholar_users(id) ON DELETE CASCADE,
  scholarship TEXT NOT NULL,
  prompt TEXT NOT NULL,
  word_limit INTEGER,
  deadline TEXT,
  angle TEXT,
  status TEXT NOT NULL DEFAULT 'writing', -- writing, ready, error
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scholar_essay_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  essay_id INTEGER NOT NULL REFERENCES scholar_essays(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  notes TEXT,          -- Claude's notes: facts to check, [placeholders] to fill
  source TEXT NOT NULL, -- draft, revision, edit
  instruction TEXT,     -- what was asked for, for revisions
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// A server restart mid-draft would leave essays stuck on "writing".
db.prepare(`UPDATE scholar_essays SET status = 'error', error = 'The server restarted while this was being written. Click Retry.' WHERE status = 'writing'`).run();

// ---- auth ----
function currentUser(req) {
  if (!req.session || !req.session.scholarUserId) return null;
  return db.prepare('SELECT id, email, name, role FROM scholar_users WHERE id = ?').get(req.session.scholarUserId) || null;
}

function requireScholar(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Please log in.' });
  req.scholar = user;
  next();
}

function requireParent(req, res, next) {
  if (req.scholar.role !== 'parent') return res.status(403).json({ error: 'Only a parent account can do that.' });
  next();
}

// The student this request is about: students always get themselves;
// parents pass ?studentId= (or body.studentId).
function studentFor(req) {
  if (req.scholar.role === 'student') return req.scholar.id;
  const id = Number(req.query.studentId || (req.body && req.body.studentId));
  if (!id) throw Object.assign(new Error('Pick a student first.'), { status: 400 });
  const s = db.prepare(`SELECT id FROM scholar_users WHERE id = ? AND role = 'student'`).get(id);
  if (!s) throw Object.assign(new Error('Student not found.'), { status: 404 });
  return s.id;
}

function withStudent(handler) {
  return (req, res) => {
    try {
      handler(req, res, studentFor(req));
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'Something went wrong.' });
    }
  };
}

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM scholar_users WHERE email = ?').get(String(email || '').trim());
  if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  req.session.scholarUserId = user.id;
  res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

router.post('/logout', (req, res) => {
  delete req.session.scholarUserId;
  res.json({ success: true });
});

router.get('/me', (req, res) => {
  res.json({ user: currentUser(req) });
});

router.use(requireScholar);

router.post('/password', (req, res) => {
  const { current, next } = req.body || {};
  const row = db.prepare('SELECT password_hash FROM scholar_users WHERE id = ?').get(req.scholar.id);
  if (!bcrypt.compareSync(String(current || ''), row.password_hash)) return res.status(400).json({ error: 'Current password is wrong.' });
  if (String(next || '').length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  db.prepare('UPDATE scholar_users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(next, 10), req.scholar.id);
  res.json({ success: true });
});

// ---- students (parent only) ----
router.get('/students', requireParent, (req, res) => {
  res.json({ students: db.prepare(`SELECT id, name, email, created_at FROM scholar_users WHERE role = 'student' ORDER BY name`).all() });
});

router.post('/students', requireParent, (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  const email = String((req.body && req.body.email) || '').trim();
  const password = String((req.body && req.body.password) || '');
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  try {
    const info = db.prepare(`INSERT INTO scholar_users (email, password_hash, name, role) VALUES (?, ?, ?, 'student')`)
      .run(email, bcrypt.hashSync(password, 10), name);
    res.json({ student: { id: info.lastInsertRowid, name, email } });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'That email already has a login.' });
    throw err;
  }
});

// ---- profile ----
function loadProfile(studentId) {
  const row = db.prepare('SELECT data, updated_at FROM scholar_profiles WHERE student_id = ?').get(studentId);
  return { data: row ? JSON.parse(row.data) : {}, updatedAt: row ? row.updated_at : null };
}

router.get('/profile', withStudent((req, res, studentId) => {
  res.json(loadProfile(studentId));
}));

router.put('/profile', withStudent((req, res, studentId) => {
  const data = {};
  for (const [k, v] of Object.entries((req.body && req.body.data) || {})) {
    if (writer.PROFILE_FIELDS.some(f => f.key === k)) data[k] = String(v || '').slice(0, 20000);
  }
  db.prepare(`INSERT INTO scholar_profiles (student_id, data, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(student_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
    .run(studentId, JSON.stringify(data));
  res.json(loadProfile(studentId));
}));

router.get('/profile-fields', (req, res) => res.json({ fields: writer.PROFILE_FIELDS }));

// ---- files ----
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); cb(null, UPLOAD_DIR); },
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '')}`),
  }),
  limits: { fileSize: MAX_FILE_BYTES, files: 10 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES[file.mimetype] || /\.(md|txt)$/i.test(file.originalname)) return cb(null, true);
    cb(Object.assign(new Error(`${file.originalname}: use PDF, Word (.docx), text, or an image (JPG/PNG).`), { status: 400 }));
  },
});

function listFiles(studentId) {
  return db.prepare('SELECT id, original_name, mime, size, description, uploaded_at FROM scholar_files WHERE student_id = ? ORDER BY uploaded_at DESC').all(studentId);
}

router.get('/files', withStudent((req, res, studentId) => res.json({ files: listFiles(studentId) })));

router.post('/files', (req, res) => {
  upload.array('files', 10)(req, res, (err) => {
    const cleanup = () => (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
    if (err) {
      cleanup();
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Each file must be 15 MB or smaller.' : err.message;
      return res.status(err.status || 400).json({ error: msg });
    }
    let studentId;
    try { studentId = studentFor(req); } catch (e) { cleanup(); return res.status(e.status || 400).json({ error: e.message }); }
    const description = String((req.body && req.body.description) || '').trim().slice(0, 500) || null;
    const insert = db.prepare('INSERT INTO scholar_files (student_id, original_name, stored_name, mime, size, description) VALUES (?, ?, ?, ?, ?, ?)');
    for (const f of req.files || []) {
      const mime = ALLOWED_TYPES[f.mimetype] ? f.mimetype : 'text/plain';
      insert.run(studentId, f.originalname, path.basename(f.path), mime, f.size, description);
    }
    res.json({ files: listFiles(studentId) });
  });
});

function ownedFile(req, studentId) {
  const f = db.prepare('SELECT * FROM scholar_files WHERE id = ? AND student_id = ?').get(Number(req.params.id), studentId);
  if (!f) throw Object.assign(new Error('File not found.'), { status: 404 });
  return f;
}

router.get('/files/:id', withStudent((req, res, studentId) => {
  const f = ownedFile(req, studentId);
  res.download(path.join(UPLOAD_DIR, f.stored_name), f.original_name);
}));

router.delete('/files/:id', withStudent((req, res, studentId) => {
  const f = ownedFile(req, studentId);
  db.prepare('DELETE FROM scholar_files WHERE id = ?').run(f.id);
  fs.unlink(path.join(UPLOAD_DIR, f.stored_name), () => {});
  res.json({ files: listFiles(studentId) });
}));

// ---- essays ----
function essayRow(id, studentId) {
  const e = db.prepare('SELECT * FROM scholar_essays WHERE id = ? AND student_id = ?').get(Number(id), studentId);
  if (!e) throw Object.assign(new Error('Essay not found.'), { status: 404 });
  return e;
}

function essayWithVersions(e) {
  const versions = db.prepare('SELECT * FROM scholar_essay_versions WHERE essay_id = ? ORDER BY id DESC').all(e.id);
  return { ...e, versions: versions.map(v => ({ ...v, words: writer.wordCount(v.text) })) };
}

// Runs in the background; the page polls GET /essays/:id until it's ready.
function startWriting(essayId, studentId, revision) {
  db.prepare(`UPDATE scholar_essays SET status = 'writing', error = NULL, updated_at = datetime('now') WHERE id = ?`).run(essayId);
  (async () => {
    const essay = db.prepare('SELECT * FROM scholar_essays WHERE id = ?').get(essayId);
    const student = db.prepare('SELECT name FROM scholar_users WHERE id = ?').get(studentId);
    const files = db.prepare('SELECT * FROM scholar_files WHERE student_id = ? ORDER BY uploaded_at').all(studentId)
      .map(f => ({ ...f, path: path.join(UPLOAD_DIR, f.stored_name) }));
    const result = await writer.writeEssay({
      studentName: student.name,
      profile: loadProfile(studentId).data,
      files,
      essay,
      revision,
    });
    db.prepare('INSERT INTO scholar_essay_versions (essay_id, text, notes, source, instruction) VALUES (?, ?, ?, ?, ?)')
      .run(essayId, result.essay, result.notes || null, revision ? 'revision' : 'draft', revision ? revision.instruction : null);
    db.prepare(`UPDATE scholar_essays SET status = 'ready', error = NULL, updated_at = datetime('now') WHERE id = ?`).run(essayId);
  })().catch(err => {
    console.error(`Essay ${essayId} failed:`, err);
    db.prepare(`UPDATE scholar_essays SET status = 'error', error = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(err.userMessage || 'Writing the essay failed. Click Retry.', essayId);
  });
}

router.get('/essays', withStudent((req, res, studentId) => {
  const essays = db.prepare(`SELECT e.id, e.scholarship, e.word_limit, e.deadline, e.status, e.updated_at,
      (SELECT COUNT(*) FROM scholar_essay_versions v WHERE v.essay_id = e.id) AS version_count
    FROM scholar_essays e WHERE e.student_id = ? ORDER BY e.updated_at DESC`).all(studentId);
  res.json({ essays });
}));

function essayFields(body) {
  const scholarship = String(body.scholarship || '').trim().slice(0, 300);
  const prompt = String(body.prompt || '').trim().slice(0, 10000);
  if (!scholarship || !prompt) throw Object.assign(new Error('Scholarship name and essay prompt are required.'), { status: 400 });
  const limit = parseInt(body.word_limit, 10);
  return {
    scholarship,
    prompt,
    word_limit: limit > 0 ? limit : null,
    deadline: String(body.deadline || '').trim().slice(0, 20) || null,
    angle: String(body.angle || '').trim().slice(0, 5000) || null,
  };
}

router.post('/essays', withStudent((req, res, studentId) => {
  const f = essayFields(req.body || {});
  const info = db.prepare('INSERT INTO scholar_essays (student_id, scholarship, prompt, word_limit, deadline, angle) VALUES (?, ?, ?, ?, ?, ?)')
    .run(studentId, f.scholarship, f.prompt, f.word_limit, f.deadline, f.angle);
  startWriting(info.lastInsertRowid, studentId, null);
  res.json({ essay: essayWithVersions(essayRow(info.lastInsertRowid, studentId)) });
}));

router.get('/essays/:id', withStudent((req, res, studentId) => {
  res.json({ essay: essayWithVersions(essayRow(req.params.id, studentId)) });
}));

// Edit the scholarship details (doesn't rewrite the essay).
router.put('/essays/:id', withStudent((req, res, studentId) => {
  const e = essayRow(req.params.id, studentId);
  const f = essayFields(req.body || {});
  db.prepare(`UPDATE scholar_essays SET scholarship = ?, prompt = ?, word_limit = ?, deadline = ?, angle = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(f.scholarship, f.prompt, f.word_limit, f.deadline, f.angle, e.id);
  res.json({ essay: essayWithVersions(essayRow(e.id, studentId)) });
}));

// Save the student's own edits as a new version.
router.post('/essays/:id/edit', withStudent((req, res, studentId) => {
  const e = essayRow(req.params.id, studentId);
  const text = String((req.body && req.body.text) || '').trim();
  if (!text) return res.status(400).json({ error: 'The essay is empty.' });
  db.prepare(`INSERT INTO scholar_essay_versions (essay_id, text, source) VALUES (?, ?, 'edit')`).run(e.id, text.slice(0, 50000));
  db.prepare(`UPDATE scholar_essays SET updated_at = datetime('now') WHERE id = ?`).run(e.id);
  res.json({ essay: essayWithVersions(essayRow(e.id, studentId)) });
}));

// Ask Claude to revise the latest version, or write a fresh draft.
router.post('/essays/:id/revise', withStudent((req, res, studentId) => {
  const e = essayRow(req.params.id, studentId);
  if (e.status === 'writing') return res.status(409).json({ error: 'Still writing. Give it a moment.' });
  const instruction = String((req.body && req.body.instruction) || '').trim().slice(0, 3000);
  const latest = db.prepare('SELECT text FROM scholar_essay_versions WHERE essay_id = ? ORDER BY id DESC LIMIT 1').get(e.id);
  const fresh = Boolean(req.body && req.body.fresh) || !latest;
  if (!fresh && !instruction) return res.status(400).json({ error: 'Say what to change.' });
  startWriting(e.id, studentId, fresh ? null : { instruction, text: latest.text });
  res.json({ essay: essayWithVersions(essayRow(e.id, studentId)) });
}));

router.delete('/essays/:id', withStudent((req, res, studentId) => {
  const e = essayRow(req.params.id, studentId);
  db.prepare('DELETE FROM scholar_essays WHERE id = ?').run(e.id);
  res.json({ success: true });
}));

module.exports = router;
