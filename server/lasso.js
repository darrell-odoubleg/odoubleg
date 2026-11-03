// lasso.js: reads crew (employee) profiles from the Lasso Workforce API
// (odoubleg.lasso.io, key in .env LASSO_API_KEY, header LASSO-APIKEY) and
// turns each into Work Number employee fields. Read-only: this never writes
// to Lasso. server/twn.js applies the result to the saved records.
//
// Lasso has no SSNs or pay data. What it has: legal name, email, phone, home
// address, birth date (crew settings, when entered), onboarded date,
// classification (full/part time) and status (active/inactive/pending/
// preregister; no termination date).

const TWN = require('../public/js/twn-fields');

const BASE = (process.env.LASSO_BASE_URL || 'https://odoubleg.lasso.io/api/v1').replace(/\/$/, '');
const PAGE = 100;

async function get(path) {
  const key = process.env.LASSO_API_KEY;
  if (!key) throw Object.assign(new Error('LASSO_API_KEY missing'), { userMessage: 'The Lasso API key is not set on the server.' });
  const res = await fetch(BASE + path, { headers: { 'LASSO-APIKEY': key, Accept: 'application/json' } });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch {
    // Lasso answers with an HTML page when the key or URL is wrong
    throw Object.assign(new Error(`Lasso ${res.status}: not JSON`), { userMessage: 'Lasso did not accept the request. Check the API key and URL.' });
  }
  if (!res.ok) throw Object.assign(new Error(`Lasso ${res.status}: ${text.slice(0, 200)}`), { userMessage: `Lasso returned an error (${res.status}).` });
  return json;
}

async function getAll(path) {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const sep = path.includes('?') ? '&' : '?';
    const page = await get(`${path}${sep}limit=${PAGE}&offset=${offset}`);
    out.push(...(page.results || []));
    if (!page.next || !(page.results || []).length) break;
    if (offset > 50000) break; // safety
  }
  return out;
}

const CLASSIFICATION = { fulltime: 'F', parttime: 'P' }; // contractor/volunteer/vendor/exempt: no Work Number type

function pickAddress(addresses) {
  const list = (addresses || []).filter(a => a.status !== 'deleted' && (a.street1 || a.locality));
  return list.find(a => a.status === 'active') || list[0] || null;
}

// One Lasso crew member -> { ids, email, name, fields, lasso }
function toPerson(c, positionNames) {
  const f = {};
  const set = (k, v) => { if (v != null && String(v).trim() !== '') f[k] = TWN.normalize(k, v); };
  set('first_name', c.legal_first_name || c.first_name);
  set('last_name', c.legal_last_name || c.last_name);
  set('email', c.email);
  set('home_phone', c.phone);
  const a = pickAddress(c.addresses);
  if (a) {
    set('address1', a.street1);
    set('address2', [a.street2, a.street3].filter(Boolean).join(' '));
    set('city', a.locality);
    set('state', a.region);
    if (!a.country || /^(us|usa|united states)/i.test(a.country)) set('zip', a.postal_code);
  } else if (c.us_state_of_residence) set('state', c.us_state_of_residence);
  set('dob', c.settings && c.settings.date_of_birth);
  set('original_hire_date', c.date_onboarded);
  if (CLASSIFICATION[c.classification]) f.employee_type = CLASSIFICATION[c.classification];
  // status is not a fill-in field: server/twn.js keeps it in step with Lasso
  const approved = (c.positions || []).filter(p => p.status === 'approved' && positionNames[p.position]);
  if (approved.length === 1) set('job_title', positionNames[approved[0].position]);
  const ids = [c.external_code, c.code].map(v => String(v || '').trim().toLowerCase()).filter(Boolean);
  return {
    ids,
    user_id: c.external_code || c.code || '',
    email: String(c.email || '').trim().toLowerCase(),
    names: [...new Set([`${c.legal_first_name || ''} ${c.legal_last_name || ''}`, `${c.first_name || ''} ${c.last_name || ''}`]
      .map(n => n.trim().toLowerCase().replace(/\s+/g, ' ')).filter(n => n.includes(' ')))],
    display: `${c.first_name || ''} ${c.last_name || ''}`.trim() || c.email || `Lasso #${c.id}`,
    status: c.status,
    classification: c.classification,
    fields: f,
  };
}

async function fetchPeople() {
  const [crew, positions] = await Promise.all([getAll('/crew'), getAll('/positions').catch(() => [])]);
  const positionNames = Object.fromEntries(positions.map(p => [p.id, p.name || p.title || '']));
  return crew.map(c => toPerson(c, positionNames));
}

module.exports = { fetchPeople };
