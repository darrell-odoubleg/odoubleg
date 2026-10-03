const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const db = require('../db/init');

// ---- Crew signup ----
router.post('/crew/signup', (req, res) => {
  const { email, password, first_name, last_name, phone, city, state, skills, certifications, bio, hourly_rate } = req.body;
  if (!email || !password || !first_name || !last_name) {
    return res.status(400).json({ error: 'Email, password, first name, and last name are required' });
  }
  try {
    const hash = bcrypt.hashSync(password, 10);
    const stmt = db.prepare(`INSERT INTO crew
      (email, password_hash, first_name, last_name, phone, city, state, skills, certifications, bio, hourly_rate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const info = stmt.run(email, hash, first_name, last_name, phone || null, city || null, state || null,
      skills || null, certifications || null, bio || null, hourly_rate || null);
    req.session.crewId = info.lastInsertRowid;
    res.json({ success: true, crewId: info.lastInsertRowid });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'An account with that email already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'Signup failed' });
  }
});

// ---- Crew login ----
router.post('/crew/login', (req, res) => {
  const { email, password } = req.body;
  const crew = db.prepare('SELECT * FROM crew WHERE email = ?').get(email);
  if (!crew || !bcrypt.compareSync(password, crew.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  req.session.crewId = crew.id;
  res.json({ success: true, crew: { id: crew.id, first_name: crew.first_name, last_name: crew.last_name, email: crew.email } });
});

// ---- Admin login ----
router.post('/admin/login', (req, res) => {
  const { email, password } = req.body;
  const admin = db.prepare('SELECT * FROM admins WHERE email = ?').get(email);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  req.session.adminId = admin.id;
  res.json({ success: true, admin: { id: admin.id, name: admin.name, email: admin.email } });
});

// ---- Logout (works for either session type) ----
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ---- Who am I ----
router.get('/me', (req, res) => {
  if (req.session.adminId) {
    const admin = db.prepare('SELECT id, name, email FROM admins WHERE id = ?').get(req.session.adminId);
    return res.json({ role: 'admin', user: admin });
  }
  if (req.session.crewId) {
    const crew = db.prepare('SELECT id, first_name, last_name, email FROM crew WHERE id = ?').get(req.session.crewId);
    return res.json({ role: 'crew', user: crew });
  }
  res.json({ role: null });
});

module.exports = router;
