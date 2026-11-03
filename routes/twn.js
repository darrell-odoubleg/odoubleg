// The Work Number (Equifax) payroll file: one record per paycheck, filled by
// hand or from uploaded paystubs/registers, exported in the DTS Prime ONE
// layout from /root/tmp/ODoubleG/O Double G - DTS Prime ONE Spec - MASTER
// TEMPLATE.xlsx (copy in templates/twn-spec-template.xlsx). Admin only.
//
// Records hold SSNs and birth dates, so each one is stored AES-256-GCM
// encrypted with TWN_DATA_KEY from .env. Uploaded files stay in memory and
// are never written to disk.

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const db = require('../db/init');
const { requireAdmin } = require('../middleware/auth');
const TWN = require('../public/js/twn-fields');
const { extractFile } = require('../services/twnExtract');

const router = express.Router();
router.use(requireAdmin);
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
  updated_by INTEGER REFERENCES admins(id),
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

router.post('/records', (req, res, next) => {
  try {
    const data = clean(req.body.data);
    if (req.body.data && req.body.data._source) data._source = String(req.body.data._source).slice(0, 200);
    const id = insert(data, req.session.adminId);
    res.json({ id, data });
  } catch (e) { next(e); }
});

router.put('/records/:id', (req, res, next) => {
  try {
    const row = db.prepare('SELECT data_enc FROM twn_records WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const old = decrypt(row.data_enc);
    const data = clean(req.body.data);
    if (old._source) data._source = old._source;
    update(req.params.id, data, req.session.adminId);
    res.json({ id: Number(req.params.id), data });
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
        else if (String(target[k]) !== String(v)) {
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
      for (const [id, data] of touched) update(id, data, req.session.adminId);
      for (const data of created) insert(data, req.session.adminId);
    })();
    report.updated = touched.size;
    report.created = created.length;
    res.json(report);
  } catch (e) { next(e); }
});

// Crew list, to start a record from someone already in the system.
router.get('/crew', (req, res) => {
  res.json({ crew: db.prepare('SELECT id, first_name, last_name, email, phone, city, state FROM crew ORDER BY last_name, first_name').all() });
});

// ---- export ----
function selected(req) {
  const ids = String(req.query.ids || '').split(',').map(Number).filter(Boolean);
  const from = TWN.toIso(TWN.normDate(req.query.from || '')), to = TWN.toIso(TWN.normDate(req.query.to || ''));
  return loadAll()
    .filter(r => !ids.length || ids.includes(r.id))
    .filter(r => { const d = TWN.dateKey(r.data.check_date); return (!from || (d && d >= from)) && (!to || (d && d <= to)); })
    .sort((a, b) => sortKey(a.data).localeCompare(sortKey(b.data)));
}

const NUM_FMT = { money: '0.00', hours: '0.00', int: '0' };

router.get('/export', async (req, res, next) => {
  try {
    const settings = getSettings();
    const fields = TWN.exportFields(settings.include_tci);
    const rows = selected(req).map(r => TWN.effective(r.data, settings));
    const format = req.query.format === 'csv' ? 'csv' : 'xlsx';
    const filename = TWN.fileName(settings, format);
    res.set('Content-Disposition', `attachment; filename="${filename}"`);

    if (format === 'csv') {
      const q = v => /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
      const lines = [fields.map(f => q(f.label)).join(',')];
      for (const e of rows) lines.push(fields.map(f => q(csvValue(f, e[f.key]))).join(','));
      res.type('text/csv').send(lines.join('\r\n') + '\r\n');
      return;
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = 'O Double G Events';
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
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { next(e); }
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

router.use((err, req, res, next) => {
  console.error('TWN:', err);
  res.status(500).json({ error: err.userMessage || 'Server error' });
});

module.exports = router;
