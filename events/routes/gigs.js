const express = require('express');
const router = express.Router();
const db = require('../db/init');
const { requireAdmin } = require('../middleware/auth');

// ---- Public: list open gigs ----
router.get('/', (req, res) => {
  const gigs = db.prepare(`SELECT * FROM gigs WHERE status = 'open' AND event_date >= date('now') ORDER BY event_date ASC`).all();
  const parsed = gigs.map(g => ({ ...g, roles_needed: JSON.parse(g.roles_needed) }));
  res.json(parsed);
});

// ---- Public: get single gig ----
router.get('/:id', (req, res) => {
  const gig = db.prepare('SELECT * FROM gigs WHERE id = ?').get(req.params.id);
  if (!gig) return res.status(404).json({ error: 'Gig not found' });
  gig.roles_needed = JSON.parse(gig.roles_needed);
  const apps = db.prepare(`SELECT a.*, c.first_name, c.last_name FROM applications a
    JOIN crew c ON c.id = a.crew_id WHERE a.gig_id = ?`).all(req.params.id);
  res.json({ ...gig, applications: apps });
});

// ---- Admin: create gig ----
router.post('/', requireAdmin, (req, res) => {
  const { title, description, venue, city, state, event_date, call_time, end_time, roles_needed } = req.body;
  if (!title || !event_date || !roles_needed) {
    return res.status(400).json({ error: 'Title, event_date, and roles_needed are required' });
  }
  const stmt = db.prepare(`INSERT INTO gigs
    (title, description, venue, city, state, event_date, call_time, end_time, roles_needed, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const info = stmt.run(title, description || null, venue || null, city || null, state || null,
    event_date, call_time || null, end_time || null, JSON.stringify(roles_needed), req.session.adminId);
  res.json({ success: true, gigId: info.lastInsertRowid });
});

// ---- Admin: update gig ----
router.put('/:id', requireAdmin, (req, res) => {
  const gig = db.prepare('SELECT * FROM gigs WHERE id = ?').get(req.params.id);
  if (!gig) return res.status(404).json({ error: 'Gig not found' });
  const fields = ['title', 'description', 'venue', 'city', 'state', 'event_date', 'call_time', 'end_time', 'status'];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); values.push(req.body[f]); }
  }
  if (req.body.roles_needed !== undefined) {
    updates.push('roles_needed = ?');
    values.push(JSON.stringify(req.body.roles_needed));
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  values.push(req.params.id);
  db.prepare(`UPDATE gigs SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json({ success: true });
});

// ---- Admin: delete gig ----
router.delete('/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM gigs WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ---- Admin: list all gigs (any status) ----
router.get('/admin/all', requireAdmin, (req, res) => {
  const gigs = db.prepare('SELECT * FROM gigs ORDER BY event_date DESC').all();
  res.json(gigs.map(g => ({ ...g, roles_needed: JSON.parse(g.roles_needed) })));
});

module.exports = router;
