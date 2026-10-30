// Imports the Cascade County ExpoPark iCalendar feed into the events table (source = 'county').
// Private bookings are skipped. Runs at startup and hourly; admins can hide individual imported events.
const { db, getSettings, setSetting } = require('./db');

const DEFAULT_URL = 'https://www.cascadecountymt.gov/common/modules/iCalendar/iCalendar.aspx?catID=24&feed=calendar';
const SITE = 'https://www.cascadecountymt.gov';
const TZ = process.env.TZ_NAME || 'America/Denver';
// The county types these by hand: "PRIVATE EVENT", "PRVATE EVENT", "Private Event ".
const PRIVATE_RE = /\bp\s*r?\s*i?\s*v\s*a\s*t\s*e\s+event\b/i;
const KEEP_UPPER = new Set(['PRCA', 'NACS', 'FFA', 'MSF', 'USA', 'II', 'III', 'IV', 'BBQ', 'DJ', 'MT', '4-H', 'NW', 'ATV', 'RV', 'NRA', 'HS']);

function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

function unescapeText(v) {
  return v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

function parseIcs(text) {
  const out = [];
  for (const block of unfold(text).split('BEGIN:VEVENT').slice(1)) {
    const body = block.split('END:VEVENT')[0];
    const ev = {};
    for (const line of body.split('\n')) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const [name, ...params] = line.slice(0, i).split(';');
      if (!(name in ev)) ev[name] = { params: params.join(';'), value: line.slice(i + 1) };
    }
    out.push(ev);
  }
  return out;
}

// UTC "Z" times are converted to fair-local time; TZID times are already local.
function toLocal(prop) {
  if (!prop) return null;
  const v = prop.value.trim();
  if (/VALUE=DATE/.test(prop.params) || /^\d{8}$/.test(v)) return { date: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`, time: null };
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/);
  if (!m) return null;
  if (v.endsWith('Z')) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
  }
  return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}` };
}

// "2027 PRCA BIG SKY PRO RODEO" → "2027 PRCA Big Sky Pro Rodeo"
function titleCase(s) {
  const letters = s.replace(/[^A-Za-z]/g, '');
  if (!letters || letters.replace(/[^A-Z]/g, '').length / letters.length < 0.7) return s;
  return s.toLowerCase().replace(/[^\s/-]+/g, (w, i) => {
    const up = w.toUpperCase();
    if (KEEP_UPPER.has(up.replace(/[^A-Z0-9-]/g, '')) || /^"?[a-z]"?$/.test(w)) return up;
    if (i > 0 && /^(of|the|and|for|at|in|on|a|an|to|with|featuring)$/.test(w)) return w;
    if (/^\d+(st|nd|rd|th)$/.test(w)) return w;
    return w.replace(/[a-z]/, (c) => c.toUpperCase());
  });
}

// "Pacific Steel & Recycling Arena - 400 3rd St NW  Great Falls" → "Pacific Steel & Recycling Arena"
function cleanLocation(v) {
  const text = unescapeText(v || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
  const name = text.split(/\s+-\s+/)[0].replace(/\s+/g, ' ').trim();
  return /^great falls/i.test(name) ? '' : name;
}

function guessCategory(title) {
  const t = title.toLowerCase();
  if (/rodeo|bull|bronc|barrel/.test(t)) return 'rodeo';
  if (/concert|band|music|howl|featuring/.test(t)) return 'music';
  if (/livestock|cattle|ranch|sale\b.*(bull|heifer)|production sale|4-h|horse/.test(t)) return 'livestock';
  if (/tournament|basketball|hockey|wrestling|volleyball|derby|race/.test(t)) return 'contest';
  if (/show|expo|bazaar|craft|market|pop up|sale/.test(t)) return 'exhibits';
  if (/banquet|food|bbq|margarita|taste/.test(t)) return 'food';
  if (/state fair/.test(t)) return 'grandstand';
  return 'other';
}

function matchLocation(text, locations) {
  if (!text) return null;
  const t = text.toLowerCase();
  // Prefer the closest name, so "Arena" doesn't win over "Arena Box Office" by accident of id order.
  const hit = locations
    .filter((l) => t.includes(l.name.toLowerCase()) || l.name.toLowerCase().includes(t))
    .sort((a, b) => Math.abs(a.name.length - t.length) - Math.abs(b.name.length - t.length))[0];
  return hit ? hit.id : null;
}

function toRows(events, locations) {
  const rows = [];
  for (const ev of events) {
    const summary = unescapeText((ev.SUMMARY && ev.SUMMARY.value) || '').trim();
    if (!summary || PRIVATE_RE.test(summary)) continue;
    const uid = ev.UID && ev.UID.value.trim();
    const start = toLocal(ev.DTSTART);
    if (!uid || !start) continue;
    const end = toLocal(ev.DTEND);
    const allDay = !start.time;
    const locText = cleanLocation(ev.LOCATION && ev.LOCATION.value) || 'Montana ExpoPark';
    const desc = unescapeText((ev.DESCRIPTION && ev.DESCRIPTION.value) || '').trim();
    const link = (desc.match(/https?:\/\/\S+/) || [])[0] || (ev.URL && /^https?:/.test(ev.URL.value) ? ev.URL.value : null);
    const text = desc.replace(/https?:\/\/\S+/g, '').trim();
    rows.push({
      ext_uid: uid,
      title: titleCase(summary).slice(0, 200),
      description: text || null,
      date: start.date,
      start_time: start.time || '00:00',
      end_time: !allDay && end && end.date === start.date && end.time > start.time ? end.time : null,
      all_day: allDay ? 1 : 0,
      location_id: matchLocation(locText, locations),
      location_text: locText,
      category: guessCategory(summary),
      url: link && link.startsWith('/') ? SITE + link : link,
    });
  }
  return rows;
}

const upsert = db.prepare(`
  INSERT INTO events (source, ext_uid, title, description, date, start_time, end_time, all_day, location_id, location_text, category, url)
  VALUES ('county', @ext_uid, @title, @description, @date, @start_time, @end_time, @all_day, @location_id, @location_text, @category, @url)
  ON CONFLICT(source, ext_uid) DO UPDATE SET
    title = excluded.title, description = excluded.description, date = excluded.date, start_time = excluded.start_time,
    end_time = excluded.end_time, all_day = excluded.all_day, location_id = COALESCE(events.location_id, excluded.location_id),
    location_text = excluded.location_text, category = excluded.category, url = excluded.url,
    updated_at = CASE WHEN events.title IS excluded.title AND events.date IS excluded.date AND events.start_time IS excluded.start_time
      AND events.end_time IS excluded.end_time AND events.location_text IS excluded.location_text THEN events.updated_at ELSE datetime('now') END`);

async function sync() {
  const url = getSettings().county_feed_url || DEFAULT_URL;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'msf.odoubleg.com calendar sync' }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('Not an iCalendar feed');
    const locations = db.prepare('SELECT id, name FROM locations').all();
    const rows = toRows(parseIcs(text), locations);
    db.transaction(() => {
      for (const row of rows) upsert.run(row);
      // Drop imported events the county removed (or re-labeled private).
      const keep = new Set(rows.map((r) => r.ext_uid));
      for (const e of db.prepare("SELECT id, ext_uid FROM events WHERE source = 'county'").all()) {
        if (!keep.has(e.ext_uid)) db.prepare('DELETE FROM events WHERE id = ?').run(e.id);
      }
    })();
    setSetting('county_last_sync', JSON.stringify({ at: new Date().toISOString(), ok: true, count: rows.length }));
    return { ok: true, count: rows.length };
  } catch (err) {
    console.error('[county feed]', err.message);
    setSetting('county_last_sync', JSON.stringify({ at: new Date().toISOString(), ok: false, error: err.message }));
    return { ok: false, error: err.message };
  }
}

function start() {
  sync();
  setInterval(sync, 60 * 60 * 1000).unref();
}

module.exports = { sync, start, parseIcs, toRows, DEFAULT_URL, PRIVATE_RE };
