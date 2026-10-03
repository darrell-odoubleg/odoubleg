const express = require('express');
const router = express.Router();
const db = require('../db/init');
const { requireAdmin, requireCrew } = require('../middleware/auth');

// ---- Crew: get my profile ----
router.get('/me', requireCrew, (req, res) => {
  const crew = db.prepare('SELECT id, email, first_name, last_name, phone, city, state, skills, certifications, bio, hourly_rate FROM crew WHERE id = ?').get(req.session.crewId);
  res.json(crew);
});

// ---- Crew: update my profile ----
router.put('/me', requireCrew, (req, res) => {
  const fields = ['first_name', 'last_name', 'phone', 'city', 'state', 'skills', 'certifications', 'bio', 'hourly_rate'];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); values.push(req.body[f]); }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  values.push(req.session.crewId);
  db.prepare(`UPDATE crew SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json({ success: true });
});

// ---- Crew: set availability for a date ----
router.post('/me/availability', requireCrew, (req, res) => {
  const { date, status } = req.body; // status: available/unavailable
  if (!date || !status) return res.status(400).json({ error: 'date and status are required' });
  db.prepare(`INSERT INTO availability (crew_id, date, status) VALUES (?, ?, ?)
    ON CONFLICT(crew_id, date) DO UPDATE SET status = excluded.status`).run(req.session.crewId, date, status);
  res.json({ success: true });
});

// ---- Crew: get my availability ----
router.get('/me/availability', requireCrew, (req, res) => {
  const rows = db.prepare('SELECT date, status FROM availability WHERE crew_id = ? ORDER BY date ASC').all(req.session.crewId);
  res.json(rows);
});

// ---- Admin: crew directory (searchable) ----
router.get('/', requireAdmin, (req, res) => {
  const { skill, city } = req.query;
  let query = 'SELECT id, email, first_name, last_name, phone, city, state, skills, certifications, hourly_rate, active FROM crew WHERE 1=1';
  const params = [];
  if (skill) { query += ' AND skills LIKE ?'; params.push(`%${skill}%`); }
  if (city) { query += ' AND city LIKE ?'; params.push(`%${city}%`); }
  query += ' ORDER BY last_name ASC';
  res.json(db.prepare(query).all(...params));
});

// ---- Admin: crew availability for a specific date (for scheduling) ----
router.get('/available-on/:date', requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT c.id, c.first_name, c.last_name, c.skills, c.phone, c.email
    FROM crew c
    LEFT JOIN availability a ON a.crew_id = c.id AND a.date = ?
    WHERE c.active = 1 AND (a.status IS NULL OR a.status = 'available')`).all(req.params.date);
  res.json(rows);
});

module.exports = router;
