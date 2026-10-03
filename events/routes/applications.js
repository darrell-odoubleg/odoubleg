const express = require('express');
const router = express.Router();
const db = require('../db/init');
const { requireAdmin, requireCrew } = require('../middleware/auth');

// ---- Crew: apply to a gig ----
router.post('/', requireCrew, (req, res) => {
  const { gig_id, role_applied, notes } = req.body;
  if (!gig_id) return res.status(400).json({ error: 'gig_id is required' });
  try {
    const stmt = db.prepare(`INSERT INTO applications (gig_id, crew_id, role_applied, notes)
      VALUES (?, ?, ?, ?)`);
    const info = stmt.run(gig_id, req.session.crewId, role_applied || null, notes || null);
    res.json({ success: true, applicationId: info.lastInsertRowid });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'You already applied to this role' });
    }
    console.error(err);
    res.status(500).json({ error: 'Application failed' });
  }
});

// ---- Crew: withdraw application ----
router.put('/:id/withdraw', requireCrew, (req, res) => {
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
  if (!app || app.crew_id !== req.session.crewId) return res.status(404).json({ error: 'Application not found' });
  db.prepare(`UPDATE applications SET status = 'withdrawn', decided_at = datetime('now') WHERE id = ?`).run(req.params.id);
  res.json({ success: true });
});

// ---- Crew: my applications ----
router.get('/mine', requireCrew, (req, res) => {
  const apps = db.prepare(`SELECT a.*, g.title, g.event_date, g.venue FROM applications a
    JOIN gigs g ON g.id = a.gig_id WHERE a.crew_id = ? ORDER BY g.event_date DESC`).all(req.session.crewId);
  res.json(apps);
});

// ---- Admin: confirm or decline an application ----
router.put('/:id/decide', requireAdmin, (req, res) => {
  const { status } = req.body; // 'confirmed' or 'declined'
  if (!['confirmed', 'declined'].includes(status)) {
    return res.status(400).json({ error: "status must be 'confirmed' or 'declined'" });
  }
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
  if (!app) return res.status(404).json({ error: 'Application not found' });
  db.prepare(`UPDATE applications SET status = ?, decided_at = datetime('now') WHERE id = ?`).run(status, req.params.id);
  res.json({ success: true });
});

module.exports = router;
