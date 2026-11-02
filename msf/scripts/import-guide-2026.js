#!/usr/bin/env node
// Loads the 2026 Montana State Fair Guide's daily schedules (assets/guide-2026-events.json,
// pulled from "2026 FAIR GUIDE PRINT.pdf" pages 12-20) as events with source 'guide'.
// Safe to run again: events are matched by ext_uid and updated, not duplicated.
// Guide place names that aren't on the map index get their own location, on the pin of the
// building they're in (e.g. "Exhibition Hall" on #4).
const path = require('path');
const { db } = require('../server/db');

const events = require(path.join(__dirname, '..', 'assets', 'guide-2026-events.json'));

// New guide place -> existing location whose pin it shares.
const NEW_PLACES = {
  'Exhibition Hall': '4-H, Schools, Creative Arts, Quilts',
  'Mercantile Building': 'Mercantile Commercial Vendors',
  'Fine Arts Building': 'Fine Arts',
  'FFA Barn': 'Draft Mules and FFA',
  'Family Living Center': 'Culinary, Home Arts',
  'Livestock Pavilion': 'Open Class Livestock, Jr. Livestock Show & Sale',
  'Rabbit/Poultry Barn': 'Poultry, Rabbits, Pigeons',
  'Pony Barn': 'Ponies & Mini Horses',
  'South Park': 'Kids Carnival',
};

const byName = (name) => db.prepare('SELECT * FROM locations WHERE name = ?').get(name);

const run = db.transaction(() => {
  let maxSort = db.prepare('SELECT COALESCE(MAX(sort), 0) AS s FROM locations').get().s;
  for (const [name, pinOf] of Object.entries(NEW_PLACES)) {
    if (byName(name)) continue;
    const pin = byName(pinOf);
    if (!pin) throw new Error(`No location named "${pinOf}"`);
    db.prepare('INSERT INTO locations (name, map_id, x, y, notes, sort) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, pin.map_id, pin.x, pin.y, `2026 Fair Guide (same pin as ${pinOf})`, ++maxSort);
  }

  const upsert = db.prepare(`
    INSERT INTO events (title, description, date, start_time, end_time, location_id, location_text, category, featured, source, ext_uid)
    VALUES (@title, @description, @date, @start_time, @end_time, @location_id, @location_text, @category, @featured, 'guide', @uid)
    ON CONFLICT(source, ext_uid) DO UPDATE SET
      title = excluded.title, description = excluded.description, date = excluded.date, start_time = excluded.start_time,
      end_time = excluded.end_time, location_id = excluded.location_id, location_text = excluded.location_text,
      category = excluded.category, featured = excluded.featured, updated_at = datetime('now')`);
  let n = 0;
  for (const e of events) {
    const loc = e.location ? byName(e.location) : null;
    if (e.location && !loc) throw new Error(`No location named "${e.location}"`);
    upsert.run({ ...e, location_id: loc ? loc.id : null, featured: e.featured ? 1 : 0 });
    n++;
  }
  return n;
});

console.log(`Loaded ${run()} events from the 2026 Fair Guide.`);
