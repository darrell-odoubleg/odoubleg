const express = require('express');
const router = express.Router();
const db = require('../db/init');
const { requireAdmin } = require('../middleware/auth');

// ---- Admin: full schedule of confirmed crew across gigs, optionally filtered by date range ----
router.get('/', requireAdmin, (req, res) => {
  const { start, end } = req.query;
  let query = `
    SELECT g.id as gig_id, g.title, g.event_date, g.call_time, g.venue, g.city,
           a.id as application_id, a.role_applied, c.id as crew_id, c.first_name, c.last_name, c.phone
    FROM applications a
    JOIN gigs g ON g.id = a.gig_id
    JOIN crew c ON c.id = a.crew_id
    WHERE a.status = 'confirmed'`;
  const params = [];
  if (start) { query += ' AND g.event_date >= ?'; params.push(start); }
  if (end) { query += ' AND g.event_date <= ?'; params.push(end); }
  query += ' ORDER BY g.event_date ASC, g.call_time ASC';
  res.json(db.prepare(query).all(...params));
});

module.exports = router;
