// The Work Number (Equifax) payroll file: one record per paycheck, filled by
// hand or from uploaded paystubs/registers, exported in the DTS Prime ONE
// layout from /root/tmp/ODoubleG/O Double G - DTS Prime ONE Spec - MASTER
// TEMPLATE.xlsx (copy in templates/twn-spec-template.xlsx). Signed-in users only
// (server/index.js puts requireAuth in front).
//
// Records hold SSNs and birth dates, so each one is stored AES-256-GCM
// encrypted with TWN_DATA_KEY from .env. Uploaded files stay in memory and
// are never written to disk.

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const db = require('./db');
const TWN = require('../public/js/twn-fields');
const { extractFile } = require('./twnExtract');

const router = express.Router();
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const TEMPLATE = path.join(__dirname, '..', 'templates', 'twn-spec-template.xlsx');

db.exec(`
CREATE TABLE IF NOT EXISTS twn_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS twn_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data_enc TEXT NOT NULL,       -- encrypted JSON of the record's fields
  updated_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
`);

// ---- encryption ----
function key() {
  const k = process.env.TWN_DATA_KEY || '';
  if (!/^[0-9a-f]{64}$/i.test(k)) throw Object.assign(new Error('TWN_DATA_KEY missing'), { userMessage: 'TWN_DATA_KEY is not set on the server.' });
  return Buffer.from(k, 'hex');
}
function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map(b => b.toString('base64')).join('.');
}
function decrypt(s) {
  const [iv, tag, body] = s.split('.').map(p => Buffer.from(p, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(body), d.final()]).toString('utf8'));
}

// ---- settings ----
const DEFAULT_SETTINGS = {
  client_name: 'O Double G',
  contact: 'Darrell',
  file_type: 'test',          // test -> _tstin, prod -> _prodin
  include_tci: false,
  defaults: { employer_code: '11716064', status: 'A', employee_type: 'C', pay_frequency: '7', pay_rate_code: '09', loc_status: 'O' },
};
function getSettings() {
  const row = db.prepare('SELECT data FROM twn_settings WHERE id = 1').get();
  const s = row ? JSON.parse(row.data) : {};
  return { ...DEFAULT_SETTINGS, ...s, defaults: { ...DEFAULT_SETTINGS.defaults, ...(s.defaults || {}) } };
}

router.get('/settings', (req, res) => res.json(getSettings()));
router.put('/settings', (req, res) => {
  const b = req.body || {};
  const defaults = {};
  for (const f of TWN.FIELDS) if ((f.def || f.settingOnly) && b.defaults && b.defaults[f.key] != null && String(b.defaults[f.key]).trim() !== '') {
    defaults[f.key] = TWN.normalize(f.key, b.defaults[f.key]);
  }
  const s = {
    client_name: String(b.client_name || '').trim().slice(0, 100),
    contact: String(b.contact || '').trim().slice(0, 100),
    file_type: b.file_type === 'prod' ? 'prod' : 'test',
    include_tci: !!b.include_tci,
    defaults,
  };
  db.prepare('INSERT INTO twn_settings (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(JSON.stringify(s));
  res.json(getSettings());
});

// ---- records ----
function loadAll() {
  return db.prepare('SELECT id, data_enc, updated_at FROM twn_records').all().map(r => ({ id: r.id, updated_at: r.updated_at, data: decrypt(r.data_enc) }));
}
function clean(data) {
  const rec = TWN.normalizeRecord(data);
  for (const k of Object.keys(rec)) if (rec[k] === '') delete rec[k];
  return rec;
}
const mask = ssn => (ssn && ssn.length >= 4 ? `***-**-${ssn.slice(-4)}` : ssn || '');

function summary(r, settings) {
  const { errors, warnings } = TWN.validate(r.data, settings);
  const d = r.data;
  return {
    id: r.id, updated_at: r.updated_at,
    first_name: d.first_name || '', last_name: d.last_name || '', ssn_masked: mask(d.ssn), job_title: d.job_title || '',
    check_date: d.check_date || '', gross_current: d.gross_current || '', status: d.status || '', source: d._source || '',
    errors, warnings,
  };
}

const sortKey = d => `${(d.last_name || '').toLowerCase()}|${(d.first_name || '').toLowerCase()}|${TWN.dateKey(d.check_date)}`;

router.get('/records', (req, res, next) => {
  try {
    const settings = getSettings();
    const rows = loadAll().sort((a, b) => sortKey(a.data).localeCompare(sortKey(b.data)));
    res.json({ records: rows.map(r => summary(r, settings)) });
  } catch (e) { next(e); }
});

router.get('/records/:id', (req, res, next) => {
  try {
    const row = db.prepare('SELECT id, data_enc, updated_at FROM twn_records WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ id: row.id, updated_at: row.updated_at, data: decrypt(row.data_enc) });
  } catch (e) { next(e); }
});

function insert(data, adminId) {
  return db.prepare('INSERT INTO twn_records (data_enc, updated_by) VALUES (?, ?)').run(encrypt(data), adminId).lastInsertRowid;
}
function update(id, data, adminId) {
  db.prepare("UPDATE twn_records SET data_enc = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?").run(encrypt(data), adminId, id);
}

// Records that share a User ID or an SSN are the same employee (linked
// transitively, so a record with only the User ID still joins the SSN ones):
// fill each one's blank employee details from the others, most recent check
// date first. Existing values are never changed. Name alone is not a match.
// Returns Map(id -> { data, fields }) of the records it filled.
const BACKFILL_KEYS = [...TWN.PERSON_KEYS.filter(k => k !== 'user_id'), 'fein'];
const ssnKey = d => { const s = String(d.ssn || '').replace(/\D/g, ''); return s.length === 9 ? s : ''; };
// Saved records grouped into people: same User ID or SSN, transitively.
function personGroups(rows) {
  const parent = rows.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const keyOf of [d => TWN.userIdKey(d), ssnKey]) {
    const seen = new Map();
    rows.forEach((r, i) => {
      const k = keyOf(r.data);
      if (!k) return;
      if (seen.has(k)) parent[find(i)] = find(seen.get(k)); else seen.set(k, i);
    });
  }
  const groups = new Map();
  rows.forEach((r, i) => { const g = find(i); (groups.get(g) || groups.set(g, []).get(g)).push(r); });
  return [...groups.values()];
}

function backfillByUserId(adminId) {
  const changed = new Map();
  for (const recs of personGroups(loadAll())) {
    if (recs.length < 2) continue;
    recs.sort((a, b) => TWN.dateKey(b.data.check_date).localeCompare(TWN.dateKey(a.data.check_date)) || b.id - a.id);
    for (const r of recs) {
      const data = { ...r.data };
      let n = 0;
      for (const k of BACKFILL_KEYS) {
        if (data[k] != null && data[k] !== '') continue;
        const src = recs.find(o => o !== r && o.data[k] != null && o.data[k] !== '');
        if (src) { data[k] = src.data[k]; n++; }
      }
      if (n) changed.set(r.id, { data, fields: n });
    }
  }
  if (changed.size) db.transaction(() => { for (const [id, c] of changed) update(id, c.data, adminId); })();
  return changed;
}

router.post('/records', (req, res, next) => {
  try {
    const data = clean(req.body.data);
    if (req.body.data && req.body.data._source) data._source = String(req.body.data._source).slice(0, 200);
    const id = insert(data, req.session.userId);
    const filled = backfillByUserId(req.session.userId);
    res.json({ id, data: filled.has(id) ? filled.get(id).data : data, filled: filled.has(id) ? filled.get(id).fields : 0, others_filled: [...filled.keys()].filter(k => k !== id).length });
  } catch (e) { next(e); }
});

router.put('/records/:id', (req, res, next) => {
  try {
    const row = db.prepare('SELECT data_enc FROM twn_records WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const old = decrypt(row.data_enc);
    const data = clean(req.body.data);
    if (old._source) data._source = old._source;
    update(req.params.id, data, req.session.userId);
    const id = Number(req.params.id);
    const filled = backfillByUserId(req.session.userId);
    res.json({ id, data: filled.has(id) ? filled.get(id).data : data, filled: filled.has(id) ? filled.get(id).fields : 0, others_filled: [...filled.keys()].filter(k => k !== id).length });
  } catch (e) { next(e); }
});

router.post('/records/delete', (req, res) => {
  const ids = (req.body.ids || []).map(Number).filter(Boolean);
  const del = db.prepare('DELETE FROM twn_records WHERE id = ?');
  db.transaction(() => ids.forEach(id => del.run(id)))();
  res.json({ deleted: ids.length });
});

// ---- uploads ----
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    if (/\.(pdf|png|jpe?g|gif|webp|xlsx|xlsm|xls|csv|tsv|txt|docx)$/i.test(file.originalname)) return cb(null, true);
    cb(Object.assign(new Error(`${file.originalname}: use PDF, an image, Excel (.xlsx), CSV, Word (.docx) or text.`), { status: 400 }));
  },
});

// Reads the files and returns what was found. Saves nothing: the page either
// fills the open form or sends the records to /merge.
router.post('/extract', (req, res) => {
  upload.array('files', 10)(req, res, async (err) => {
    if (err) return res.status(err.status || 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Files must be under 25 MB.' : err.message });
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files received.' });
    const results = await Promise.all(files.map(async f => {
      try {
        const out = await extractFile(f);
        return { name: f.originalname, ...out };
      } catch (e) {
        console.error(`TWN extract ${f.originalname}:`, e.message);
        return { name: f.originalname, records: [], notes: '', error: e.userMessage || 'Could not read this file.' };
      }
    }));
    res.json({ files: results });
  });
});

// Applies extracted records to the saved ones:
//  - a record with a check date updates that person's record for the same
//    check date, or becomes a new record (prefilled with the person's details
//    from their latest record);
//  - a record without a check date (W-4, new-hire form...) fills that
//    person's details on all their records, or becomes a new record.
// Blank fields are filled; a different existing value is kept unless
// overwrite is on, and is reported either way.
router.post('/merge', (req, res, next) => {
  try {
    const overwrite = !!req.body.overwrite;
    const incoming = (req.body.records || []).map(r => ({ source: String(r._source || '').slice(0, 200), data: clean(r) })).filter(r => Object.keys(r.data).length);
    const all = loadAll();
    const touched = new Map(); // id -> data
    const created = [];
    const report = { created: 0, updated: 0, conflicts: [] };
    const who = d => `${d.first_name || ''} ${d.last_name || ''}`.trim() || mask(d.ssn) || 'Unnamed';

    const fill = (target, src, keys, idLabel) => {
      let changed = false;
      for (const k of keys) {
        const v = src[k];
        if (v == null || v === '') continue;
        if (target[k] == null || target[k] === '') { target[k] = v; changed = true; }
        else if (String(target[k]).trim().toLowerCase() !== String(v).trim().toLowerCase()) {
          const f = TWN.BY_KEY[k];
          report.conflicts.push({ who: idLabel, field: f.label, kept: overwrite ? v : target[k], other: overwrite ? target[k] : v, sensitive: !!f.sensitive });
          if (overwrite) { target[k] = v; changed = true; }
        }
      }
      return changed;
    };

    for (const { source, data } of incoming) {
      const pool = [...all.map(r => ({ id: r.id, data: touched.get(r.id) || r.data })), ...created.map((d, i) => ({ id: 'new' + i, data: d }))];
      const mine = pool.filter(r => TWN.samePerson(r.data, data));
      const label = `${who(data)}${data.check_date ? ' · ' + data.check_date : ''}`;
      const keys = Object.keys(data);
      if (data.check_date) {
        const same = mine.find(r => r.data.check_date === data.check_date);
        if (same) {
          const target = { ...same.data };
          if (fill(target, data, keys, label)) {
            if (typeof same.id === 'number') touched.set(same.id, target); else created[Number(same.id.slice(3))] = target;
          }
        } else {
          const latest = mine.sort((a, b) => TWN.dateKey(b.data.check_date).localeCompare(TWN.dateKey(a.data.check_date)))[0];
          const rec = { ...data, _source: source };
          if (latest) for (const k of TWN.PERSON_KEYS) if ((rec[k] == null || rec[k] === '') && latest.data[k]) rec[k] = latest.data[k];
          created.push(rec);
        }
      } else if (mine.length) {
        const personKeys = keys.filter(k => TWN.PERSON_KEYS.includes(k) || TWN.BY_KEY[k].group === 'tci' || k === 'fein');
        for (const r of mine) {
          const target = { ...r.data };
          if (fill(target, data, personKeys, `${who(r.data)}${r.data.check_date ? ' · ' + r.data.check_date : ''}`)) {
            if (typeof r.id === 'number') touched.set(r.id, target); else created[Number(r.id.slice(3))] = target;
          }
        }
      } else {
        created.push({ ...data, _source: source });
      }
    }

    db.transaction(() => {
      for (const [id, data] of touched) update(id, data, req.session.userId);
      for (const data of created) insert(data, req.session.userId);
    })();
    report.updated = touched.size;
    report.created = created.length;
    report.user_id_filled = backfillByUserId(req.session.userId).size;
    res.json(report);
  } catch (e) { next(e); }
});

// ---- export ----
function selected(req) {
  req = req.query ? req : { query: req };
  const ids = String(req.query.ids || '').split(',').map(Number).filter(Boolean);
  const from = TWN.toIso(TWN.normDate(req.query.from || '')), to = TWN.toIso(TWN.normDate(req.query.to || ''));
  return loadAll()
    .filter(r => !ids.length || ids.includes(r.id))
    .filter(r => { const d = TWN.dateKey(r.data.check_date); return (!from || (d && d >= from)) && (!to || (d && d <= to)); })
    .sort((a, b) => sortKey(a.data).localeCompare(sortKey(b.data)));
}

const NUM_FMT = { money: '0.00', hours: '0.00', int: '0' };

// -> { buffer, filename, type, rows, people, with_errors }
async function buildExport(query) {
  const settings = getSettings();
  const fields = TWN.exportFields(settings.include_tci);
  const recs = selected({ query });
  const rows = recs.map(r => TWN.effective(r.data, settings));
  const format = query.format === 'csv' ? 'csv' : 'xlsx';
  const meta = {
    filename: TWN.fileName(settings, format),
    rows: rows.length,
    people: new Set(rows.map(e => e.ssn || `${e.first_name} ${e.last_name}`)).size,
    with_errors: recs.filter(r => TWN.validate(r.data, settings).errors.length).length,
    file_type: settings.file_type,
  };
  if (format === 'csv') {
    const q = v => /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    const lines = [fields.map(f => q(f.label)).join(',')];
    for (const e of rows) lines.push(fields.map(f => q(csvValue(f, e[f.key]))).join(','));
    return { ...meta, type: 'text/csv', buffer: Buffer.from(lines.join('\r\n') + '\r\n', 'utf8') };
  }
  const wb = new ExcelJS.Workbook();
  wb.creator = 'O Double G';
  const ws = wb.addWorksheet('Sheet1'); // spec: one sheet, consistent name, usually "Sheet1"
  ws.addRow(fields.map(f => f.label));
  ws.getRow(1).font = { bold: true };
  for (const e of rows) {
    ws.addRow(fields.map(f => {
      const v = e[f.key];
      if (v === '') return null;
      if (NUM_FMT[f.type] && !isNaN(Number(v))) return Number(v);
      return v; // SSN, codes, dates and ZIPs stay text so leading zeros survive
    }));
  }
  fields.forEach((f, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.min(Math.max(f.label.length * 0.9, 12), 40);
    if (NUM_FMT[f.type]) col.numFmt = f.decimals === 4 ? '0.0000' : NUM_FMT[f.type];
    else col.numFmt = '@';
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return { ...meta, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(await wb.xlsx.writeBuffer()) };
}

router.get('/export', async (req, res, next) => {
  try {
    const out = await buildExport(req.query);
    res.set('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.type(out.type).send(out.buffer);
  } catch (e) { next(e); }
});

// ---- SFTP to Equifax MFT ----
const sftp = require('./sftp');
db.exec(`CREATE TABLE IF NOT EXISTS sftp_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sent_at TEXT DEFAULT (datetime('now')),
  user_id INTEGER REFERENCES users(id),
  host TEXT, remote_path TEXT, filename TEXT, bytes INTEGER,
  rows INTEGER, people INTEGER, with_errors INTEGER, date_from TEXT, date_to TEXT,
  ok INTEGER NOT NULL, error TEXT
)`);

router.get('/sftp/status', (req, res) => {
  res.json({
    ...sftp.info(),
    file_type: getSettings().file_type,
    log: db.prepare('SELECT s.*, u.name AS user_name FROM sftp_log s LEFT JOIN users u ON u.id = s.user_id ORDER BY s.id DESC LIMIT 20').all(),
  });
});

router.post('/sftp/test', async (req, res) => {
  try { res.json({ ok: true, ...(await sftp.test()) }); }
  catch (e) { res.status(502).json({ error: e.userMessage || e.message }); }
});

// Builds the same file as Download, for the same date range, and uploads it.
// Refuses to replace a file of the same name unless overwrite is set.
router.post('/sftp/send', async (req, res, next) => {
  const b = req.body || {};
  let out;
  try {
    out = await buildExport({ format: b.format, from: b.from, to: b.to, ids: b.ids });
    if (!out.rows) return res.status(400).json({ error: 'There are no paycheck records in that date range.' });
  } catch (e) { return next(e); }
  const log = (ok, error, remotePath) => db.prepare(`INSERT INTO sftp_log (user_id, host, remote_path, filename, bytes, rows, people, with_errors, date_from, date_to, ok, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.session.userId, sftp.info().host, remotePath || null, out.filename, out.buffer.length, out.rows, out.people, out.with_errors, b.from || null, b.to || null, ok ? 1 : 0, error || null);
  try {
    const r = await sftp.send(out.filename, out.buffer, { overwrite: !!b.overwrite });
    log(true, null, r.remote_path);
    res.json({ ok: true, filename: out.filename, remote_path: r.remote_path, bytes: out.buffer.length, rows: out.rows, people: out.people, with_errors: out.with_errors });
  } catch (e) {
    if (e.code === 'EXISTS') return res.status(409).json({ error: e.userMessage, exists: true, filename: out.filename });
    log(false, e.userMessage || e.message);
    res.status(502).json({ error: e.userMessage || e.message });
  }
});

function csvValue(f, v) {
  if (v === '' || v == null) return '';
  if ((f.type === 'money' || f.type === 'hours') && !isNaN(Number(v))) return Number(v).toFixed(f.decimals || 2);
  return String(v);
}

const letter = n => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const squash = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// The spec workbook with "Mapped Client Fields" (column E) filled in from
// our export layout, plus client name/code/contact, for sending to Equifax.
router.get('/export-spec', async (req, res, next) => {
  try {
    const settings = getSettings();
    const fields = TWN.exportFields(settings.include_tci);
    const rows = loadAll().map(r => TWN.effective(r.data, settings));
    const colOf = Object.fromEntries(fields.map((f, i) => [f.key, letter(i + 1)]));
    const hasData = k => rows.some(e => e[k] !== '');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(TEMPLATE);
    const ws = wb.getWorksheet('Data Specs');
    ws.getCell('D2').value = settings.client_name;
    ws.getCell('D3').value = settings.defaults.employer_code || '';
    ws.getCell('D4').value = settings.contact;

    const used = new Set();
    for (let r = 20; r <= ws.rowCount; r++) {
      const name = squash(ws.getCell(`A${r}`).text);
      const f = TWN.FIELDS.find(x => squash(x.spec) === name);
      if (!f || used.has(f.key)) continue;
      used.add(f.key);
      const cell = ws.getCell(`E${r}`);
      let text;
      if (f.key === 'tci_company_code') text = settings.include_tci && settings.defaults.tci_company_code ? `Hard Code Value: ${settings.defaults.tci_company_code}` : 'N/A';
      else if (!colOf[f.key] || (!hasData(f.key) && !f.required)) text = 'N/A';
      else text = `Column ${colOf[f.key]} - "${f.label}"`;
      if (f.type === 'code' && colOf[f.key] && text !== 'N/A') text += ' (Equifax codes sent directly)';
      const old = cell.value;
      cell.value = old && typeof old === 'object' && old.hyperlink ? { text, hyperlink: old.hyperlink } : text;
    }
    const codeTab = (sheet, addr, key) => {
      const s = wb.getWorksheet(sheet);
      if (s) s.getCell(addr).value = colOf[key] ? `Column ${colOf[key]} - Equifax codes sent directly` : 'N/A';
    };
    codeTab('Status Code Table', 'C31', 'status');
    codeTab('Pay Frequency Table', 'C11', 'pay_frequency');
    codeTab('Pay Rate Description Table', 'C35', 'pay_rate_code');

    const code = String(settings.defaults.employer_code || '').replace(/\D/g, '');
    res.set('Content-Disposition', `attachment; filename="O Double G - DTS Prime ONE Spec${code ? ' - ' + code : ''}.xlsx"`);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { next(e); }
});

// ---- Lasso (crew profiles) ----
const lasso = require('./lasso');
db.exec('CREATE TABLE IF NOT EXISTS lasso_sync (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)');

router.get('/lasso/status', (req, res) => {
  const row = db.prepare('SELECT data FROM lasso_sync WHERE id = 1').get();
  res.json({ configured: !!process.env.LASSO_API_KEY, last: row ? JSON.parse(row.data) : null });
});

// Downloads every Lasso crew profile and fills in the matching people's
// records. Match order: Lasso external_code or code = User ID, then email,
// then full name when only one Lasso crew member has that name. Blank fields
// are filled; with overwrite, Lasso's value replaces a different saved one.
// User ID is only ever filled, never replaced. dry_run reports without saving.
async function runLassoSync(opts = {}, userId = null) {
    const dryRun = !!opts.dry_run, overwrite = !!opts.overwrite, includeNew = !!opts.include_new;
    const people = await lasso.fetchPeople();
    const groups = personGroups(loadAll());
    const gInfo = groups.map(recs => ({
      recs,
      ids: new Set(recs.map(r => TWN.userIdKey(r.data)).filter(Boolean)),
      emails: new Set(recs.map(r => String(r.data.email || '').trim().toLowerCase()).filter(Boolean)),
      names: new Set(recs.map(r => `${r.data.first_name || ''} ${r.data.last_name || ''}`.trim().toLowerCase().replace(/\s+/g, ' ')).filter(Boolean)),
      who: `${recs[0].data.first_name || ''} ${recs[0].data.last_name || ''}`.trim() || 'Unnamed',
      lasso: null, how: '',
    }));
    const nameCount = new Map();
    for (const p of people) for (const n of p.names) nameCount.set(n, (nameCount.get(n) || 0) + 1);

    const matchedPeople = new Set();
    const pass = (how, test) => {
      for (const p of people) {
        if (matchedPeople.has(p)) continue;
        const hits = gInfo.filter(g => !g.lasso && test(g, p));
        for (const g of hits) { g.lasso = p; g.how = how; }
        if (hits.length) matchedPeople.add(p);
      }
    };
    const by = how => { const before = matchedPeople.size; return () => matchedPeople.size - before; };
    let c;
    c = by(); pass('User ID', (g, p) => p.ids.some(id => g.ids.has(id))); const nId = c();
    c = by(); pass('email', (g, p) => p.email && g.emails.has(p.email)); const nEmail = c();
    c = by(); pass('name', (g, p) => p.names.some(n => nameCount.get(n) === 1 && g.names.has(n))); const nName = c();

    const report = {
      dry_run: dryRun, lasso_crew: people.length, people_matched: 0, records_updated: 0, created: 0,
      filled: {}, conflicts: [], matched_by: { 'User ID': nId, email: nEmail, name: nName },
      lasso_not_in_app: [], app_not_in_lasso: [], inactive_in_lasso: [], not_employees: [],
    };
    const updates = new Map(), creates = [];
    for (const g of gInfo) {
      if (!g.lasso) { report.app_not_in_lasso.push(g.who); continue; }
      const p = g.lasso;
      if (p.status === 'inactive') report.inactive_in_lasso.push(g.who);
      if (!['parttime', 'fulltime'].includes(p.classification)) report.not_employees.push(`${g.who} (${p.classification || 'no classification'})`);
      for (const r of g.recs) {
        const data = { ...r.data };
        let changed = false;
        const want = { ...p.fields };
        if (p.user_id && !data.user_id) want.user_id = p.user_id;
        for (const [k, v] of Object.entries(want)) {
          const cur = data[k];
          if (cur == null || cur === '') { data[k] = v; changed = true; report.filled[TWN.BY_KEY[k].label] = (report.filled[TWN.BY_KEY[k].label] || 0) + 1; }
          else if (k !== 'user_id' && String(cur).trim().toLowerCase() !== String(v).trim().toLowerCase()) {
            const f = TWN.BY_KEY[k];
            if (report.conflicts.length < 300) report.conflicts.push({ who: `${g.who}${data.check_date ? ' · ' + data.check_date : ''}`, field: f.label, app: f.sensitive ? '(hidden)' : cur, lasso: f.sensitive ? '(hidden)' : v, replaced: overwrite });
            if (overwrite) { data[k] = v; changed = true; }
          }
        }
        if (changed) updates.set(r.id, data);
      }
    }
    // One Lasso crew member matching several sets of records (e.g. some under
    // the 202621 number, some under the DBLGP-U code) confirms they are one
    // person: share their other details (SSN, birth date...) across them.
    report.linked_ids = 0;
    for (const p of matchedPeople) {
      const gs = gInfo.filter(g => g.lasso === p);
      if (gs.length < 2) continue;
      report.linked_ids++;
      const recs = gs.flatMap(g => g.recs.map(r => ({ id: r.id, data: updates.get(r.id) || r.data })))
        .sort((a, b) => TWN.dateKey(b.data.check_date).localeCompare(TWN.dateKey(a.data.check_date)) || b.id - a.id);
      for (const r of recs) {
        const data = { ...r.data };
        let n = 0;
        for (const k of BACKFILL_KEYS) {
          if (data[k] != null && data[k] !== '') continue;
          const src = recs.find(o => o !== r && o.data[k] != null && o.data[k] !== '');
          if (src) { data[k] = src.data[k]; n++; report.filled[TWN.BY_KEY[k].label] = (report.filled[TWN.BY_KEY[k].label] || 0) + 1; }
        }
        if (n) updates.set(r.id, data);
      }
    }
    // Employee Status follows Lasso on every run (not just when blank):
    //  - Lasso active: A, unless the record already has another working code
    //    (P part time, Y temporary, N new...). An inactive code becomes A.
    //  - Lasso inactive: I (Inactive), unless the record already has an
    //    inactive-type code (G, R, L...). Equifax requires a termination/
    //    inactivity date for these; Lasso has none, so a blank one becomes the
    //    end of the person's last pay period here (else their last check date).
    //  - pending/preregister: left alone.
    report.status_changes = [];
    for (const p of matchedPeople) {
      if (p.status !== 'active' && p.status !== 'inactive') continue;
      const recs = gInfo.filter(g => g.lasso === p).flatMap(g => g.recs).map(r => ({ id: r.id, data: updates.get(r.id) || r.data }));
      const who = recs.length ? `${recs[0].data.first_name || ''} ${recs[0].data.last_name || ''}`.trim() : p.display;
      let lastDay = '';
      for (const r of recs) {
        const d = r.data.pp_end || r.data.check_date;
        if (d && TWN.dateKey(d) > TWN.dateKey(lastDay)) lastDay = d;
      }
      const before = new Set(), after = new Set();
      let termSet = '';
      for (const r of recs) {
        const data = { ...r.data };
        const cur = data.status || '';
        const isInactive = TWN.INACTIVE_STATUS.includes(cur);
        before.add(cur || '(blank)');
        if (p.status === 'active' && (!cur || isInactive)) data.status = 'A';
        if (p.status === 'inactive') {
          if (!isInactive) data.status = 'I';
          if (!data.term_date && lastDay) { data.term_date = lastDay; termSet = lastDay; }
        }
        after.add(data.status || '(blank)');
        if (data.status !== r.data.status || data.term_date !== r.data.term_date) updates.set(r.id, data);
      }
      const b = [...before].join('/'), a2 = [...after].join('/');
      if (b !== a2 || termSet) report.status_changes.push({ who, lasso: p.status, from: b, to: a2, term_date: termSet, active_with_term_date: p.status === 'active' && recs.some(r => (updates.get(r.id) || r.data).term_date) });
    }
    report.status_changes.sort((x, y) => x.who.localeCompare(y.who));
    report.records_updated = updates.size;

    report.people_matched = matchedPeople.size;
    for (const p of people) {
      if (matchedPeople.has(p)) continue;
      report.lasso_not_in_app.push(`${p.display}${p.status === 'inactive' ? ' (inactive)' : ''}`);
      if (includeNew) creates.push({ ...p.fields, ...(p.user_id ? { user_id: p.user_id } : {}), _source: 'Lasso crew profile' });
    }
    report.records_updated = updates.size;
    report.created = creates.length;
    if (!dryRun) {
      db.transaction(() => {
        for (const [id, data] of updates) update(id, data, userId);
        for (const data of creates) insert(clean(data), userId);
      })();
      report.user_id_filled = backfillByUserId(userId).size;
      const last = { at: new Date().toISOString(), by: userId, crew: people.length, matched: report.people_matched, updated: report.records_updated, created: report.created };
      db.prepare('INSERT INTO lasso_sync (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(JSON.stringify(last));
    }
    for (const k of ['lasso_not_in_app', 'app_not_in_lasso', 'inactive_in_lasso', 'not_employees']) report[k] = [...new Set(report[k])].sort();
    return report;
}

router.post('/lasso/sync', async (req, res, next) => {
  try { res.json(await runLassoSync(req.body || {}, req.session.userId)); } catch (e) { next(e); }
});

router.use((err, req, res, next) => {
  console.error('TWN:', err);
  res.status(500).json({ error: err.userMessage || 'Server error' });
});

try { const n = backfillByUserId(null).size; if (n) console.log(`TWN: filled ${n} record(s) from matching User IDs/SSNs`); } catch (e) { console.error('TWN backfill:', e.message); }

module.exports = router;
module.exports.runLassoSync = runLassoSync;
