const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const session = require('express-session');
const multer = require('multer');

const db = require('./db');
const { login, logout, requireAuth } = require('./auth');
const { drain, summarize, UPLOAD_DIR, IMAGE_TYPES, hasKey } = require('./analyze');

const app = express();
const PORT = process.env.PORT || 4500;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || undefined;
const ALLOWED = ['application/pdf', 'text/plain', ...IMAGE_TYPES];

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// nginx terminates TLS in front of this app.
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

// Single login, low traffic — MemoryStore is fine here.
app.use(session({
  name: 'medreview.sid',
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

app.get('/login.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/styles.css', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'styles.css')));

app.use(requireAuth);
app.use(express.static(PUBLIC_DIR, { index: false }));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 30 * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED.includes(file.mimetype)),
});

const docRow = (d) => ({
  id: d.id,
  name: d.original_name,
  mime: d.mime,
  size: d.size,
  status: d.status,
  error: d.error,
  uploaded_at: d.uploaded_at,
  analyzed_at: d.analyzed_at,
  analysis: d.analysis ? JSON.parse(d.analysis) : null,
});

app.get('/api/documents', (req, res) => {
  res.json({
    ready: hasKey(),
    documents: db.prepare('SELECT * FROM documents ORDER BY id DESC').all().map(docRow),
  });
});

app.post('/api/documents', upload.array('files', 20), (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'Upload PDF, image (JPG/PNG/GIF/WEBP) or .txt files.' });
  const insert = db.prepare('INSERT INTO documents (original_name, stored_name, mime, size) VALUES (?, ?, ?, ?)');
  for (const f of files) insert.run(f.originalname, f.filename, f.mimetype, f.size);
  drain();
  res.json({ ok: true, added: files.length });
});

app.post('/api/documents/:id/reanalyze', (req, res) => {
  const info = db.prepare("UPDATE documents SET status = 'queued', error = NULL WHERE id = ? AND status IN ('done','error')").run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Not found or already running' });
  drain();
  res.json({ ok: true });
});

app.get('/api/documents/:id/file', (req, res) => {
  const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).end();
  res.type(d.mime);
  res.setHeader('Content-Disposition', `inline; filename="${d.original_name.replace(/["\\\r\n]/g, '')}"`);
  res.sendFile(path.join(UPLOAD_DIR, d.stored_name));
});

app.delete('/api/documents/:id', (req, res) => {
  const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  if (d.status === 'processing') return res.status(409).json({ error: 'Still being analyzed — try again in a moment' });
  db.prepare('DELETE FROM documents WHERE id = ?').run(d.id);
  fs.rm(path.join(UPLOAD_DIR, d.stored_name), { force: true }, () => {});
  res.json({ ok: true });
});

app.get('/api/summary', (req, res) => {
  const s = db.prepare('SELECT * FROM summaries ORDER BY id DESC LIMIT 1').get();
  res.json(s ? { id: s.id, doc_ids: JSON.parse(s.doc_ids), summary: JSON.parse(s.summary), created_at: s.created_at } : null);
});

let summarizing = false;
app.post('/api/summary', async (req, res) => {
  if (summarizing) return res.status(409).json({ error: 'A combined review is already running' });
  summarizing = true;
  try {
    res.json(await summarize());
  } catch (err) {
    console.error('summary:', err.message);
    res.status(500).json({ error: err.message || 'Combined review failed' });
  } finally {
    summarizing = false;
  }
});

app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`medreview server running on port ${PORT}`);
  drain();
});
