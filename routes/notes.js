const express = require('express');
const db = require('../db/init');
const { LOCATIONS } = require('../server/locations');

const router = express.Router();

const listStmt = db.prepare('SELECT * FROM notes WHERE location = ? ORDER BY created_at DESC, id DESC');
const insertStmt = db.prepare('INSERT INTO notes (location, author, body) VALUES (?, ?, ?)');
const getStmt = db.prepare('SELECT * FROM notes WHERE id = ?');

router.get('/locations', (req, res) => {
  res.json({ locations: LOCATIONS });
});

router.get('/notes', (req, res) => {
  const { location } = req.query;
  if (!LOCATIONS.includes(location)) {
    return res.status(400).json({ error: 'Unknown location' });
  }
  res.json({ notes: listStmt.all(location) });
});

router.post('/notes', (req, res) => {
  const { location, author, body } = req.body || {};
  if (!LOCATIONS.includes(location)) {
    return res.status(400).json({ error: 'Unknown location' });
  }
  const trimmedBody = (body || '').trim();
  if (!trimmedBody) {
    return res.status(400).json({ error: 'Note text is required' });
  }
  const trimmedAuthor = (author || '').trim() || null;
  const result = insertStmt.run(location, trimmedAuthor, trimmedBody);
  res.status(201).json({ note: getStmt.get(result.lastInsertRowid) });
});

module.exports = router;
