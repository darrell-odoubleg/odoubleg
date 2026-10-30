// Read-only Mist API access for the ExpoPark floor plans. Map metadata is cached for
// 10 minutes; images are cached on disk because Mist's image URLs are short-lived signed links.
const fs = require('fs');
const path = require('path');

const HOST = process.env.MIST_HOST || 'api.mist.com';
const TOKEN = process.env.MIST_API_TOKEN;
const SITE_ID = process.env.MIST_SITE_ID;
const IMG_DIR = path.join(__dirname, '..', 'data', 'maps');
const META_TTL = 10 * 60 * 1000;
const IMG_TTL = 24 * 60 * 60 * 1000;

fs.mkdirSync(IMG_DIR, { recursive: true });

let cache = { at: 0, maps: null, raw: null };

async function mistGet(p) {
  const r = await fetch(`https://${HOST}/api/v1${p}`, { headers: { Authorization: `Token ${TOKEN}` } });
  if (!r.ok) throw new Error(`Mist ${p} → ${r.status}`);
  return r.json();
}

function enabled() { return Boolean(TOKEN && SITE_ID); }

async function listMaps() {
  if (!enabled()) return [];
  if (cache.maps && Date.now() - cache.at < META_TTL) return cache.maps;
  try {
    const raw = await mistGet(`/sites/${SITE_ID}/maps`);
    cache = {
      at: Date.now(),
      raw: new Map(raw.map((m) => [m.id, m])),
      maps: raw.filter((m) => m.type === 'image').map((m) => ({
        id: m.id,
        name: m.name,
        width: m.width,
        height: m.height,
        ppm: m.ppm,
        width_m: m.width_m,
        height_m: m.height_m,
        wayfinding: (m.wayfinding_path && m.wayfinding_path.nodes) || [],
        modified: m.modified_time,
      })),
    };
  } catch (err) {
    // Keep serving the last good copy if Mist is unreachable.
    if (!cache.maps) throw err;
    console.warn('[mist] map refresh failed, using cache:', err.message);
  }
  return cache.maps;
}

async function mapImagePath(id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const file = path.join(IMG_DIR, id);
  const fresh = fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < IMG_TTL;
  if (fresh) return file;
  await listMaps();
  const m = cache.raw && cache.raw.get(id);
  if (!m || !m.url) return fs.existsSync(file) ? file : null;
  try {
    const r = await fetch(m.url);
    if (!r.ok) throw new Error(`image ${r.status}`);
    fs.writeFileSync(file + '.tmp', Buffer.from(await r.arrayBuffer()));
    fs.renameSync(file + '.tmp', file);
  } catch (err) {
    console.warn('[mist] image fetch failed:', err.message);
    if (!fs.existsSync(file)) return null;
  }
  return file;
}

module.exports = { enabled, listMaps, mapImagePath };
