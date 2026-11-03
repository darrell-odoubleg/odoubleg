// twnExtract.js: reads uploaded payroll documents with Claude and returns
// Work Number records (server/twn.js). Nothing here touches the database.
//
// Two ways in:
//  - Paystubs, PDFs, images, Word, text and small spreadsheets: Claude reads
//    the document and returns the records directly.
//  - Large spreadsheets/CSVs (payroll registers): Claude only sees the top of
//    each sheet and returns a column -> field mapping plus code translations;
//    the rows are converted here, so a 2,000-row register costs one short call.

const Anthropic = require('@anthropic-ai/sdk');
const ExcelJS = require('exceljs');
const mammoth = require('mammoth');
const TWN = require('../public/js/twn-fields');

const MODEL = 'claude-opus-5-5';
const DIRECT_MAX_ROWS = 60;        // sheets up to this size are read directly
const MAX_TEXT_CHARS = 150000;
const SAMPLE_ROWS = 25;

const FIELD_KEYS = TWN.FIELDS.filter(f => !f.settingOnly).map(f => f.key);

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) throw Object.assign(new Error('ANTHROPIC_API_KEY is not set'), { userMessage: 'File reading is not configured on the server.' });
  if (!client) client = new Anthropic();
  return client;
}

function fieldGuide() {
  const lines = TWN.FIELDS.filter(f => !f.settingOnly).map(f => {
    let s = `- ${f.key}: ${f.label} [${f.type}${f.fmt ? ', ' + f.fmt : ''}]`;
    if (f.hint) s += ` — ${f.hint}`;
    return s;
  });
  const codes = (name, list) => `${name}: ${list.map(([c, d]) => `${c}=${d}`).join(', ')}`;
  return `Fields (key: column name [type]):\n${lines.join('\n')}

Code tables (code fields must hold the code, not the description):
${codes('status', TWN.STATUS)}
${codes('employee_type', TWN.EMP_TYPE)}
${codes('pay_frequency', TWN.PAY_FREQ)}
${codes('pay_rate_code', TWN.PAY_RATE)}
${codes('loc_status', TWN.LOC_STATUS)}`;
}

const RULES = `Value rules: dates as MM/DD/YYYY. Money and hours as plain numbers with no $ or commas (1234.56). SSN as 9 digits. State as the 2-letter code. Phone as 10 digits. YTD fields are year-to-date amounts; "current" fields and deductions are for this one check only. Deductions are positive numbers. Total Hours Worked Current Pay Period includes vacation, sick and holiday hours. Pay Frequency is how often the person is paid (a weekly paycheck = 7). Pay Rate Description Code describes the pay rate amount (an hourly rate = 09), which may differ from the pay frequency. Earnings the YTD lines don't name (per diem, reimbursements, misc) go in ytd_other.`;

const DIRECT_SYSTEM = `You pull payroll data out of documents for an Equifax "The Work Number" employment and income file for O Double G LLC, an event-staffing company. Documents may be paystubs, payroll registers, YTD earnings reports, new-hire forms, W-4s, I-9s, offer letters, termination notices, or spreadsheets.

Return one record per paycheck (one employee + one check date). A document listing several checks or several employees gives several records. A document with employee details but no paycheck (W-4, new-hire form) gives one record per person with no check_date.

Only include values the document actually shows. Never guess or invent values, and skip fields the document doesn't have. Don't copy the employer's own FEIN/address into employee address fields: the employer's FEIN goes in fein, and its address only in the loc_* fields when it is the employee's work location.

${RULES}

In notes, briefly list anything you could not read or were unsure of. Keep it short and never repeat SSNs or birth dates in the notes.

${fieldGuide()}`;

const DIRECT_SCHEMA = {
  type: 'object',
  properties: {
    records: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Which document/page/row this came from' },
          fields: {
            type: 'array',
            items: {
              type: 'object',
              properties: { key: { type: 'string', enum: FIELD_KEYS }, value: { type: 'string' } },
              required: ['key', 'value'],
              additionalProperties: false,
            },
          },
        },
        required: ['source', 'fields'],
        additionalProperties: false,
      },
    },
    notes: { type: 'string' },
  },
  required: ['records', 'notes'],
  additionalProperties: false,
};

const MAP_TARGETS = [...FIELD_KEYS, 'full_name_last_first', 'full_name_first_last', 'ignore'];

const MAP_SYSTEM = `You map the columns of a payroll spreadsheet onto an Equifax "The Work Number" file for O Double G LLC, an event-staffing company. You see the first rows of each sheet and, per column, a sample of its distinct values. The rows are converted by code using your mapping, so be exact.

For each sheet that holds employee or paycheck rows: give the 1-based row number of the header row and of the first data row, and map each useful column (by its letter) to a field. Use full_name_last_first for a single "Last, First" name column and full_name_first_last for "First Last". Leave out columns that match no field. Skip sheets that are summaries, notes or code lists.

For code fields (status, employee_type, pay_frequency, pay_rate_code, loc_status), add value_maps translating each distinct value seen in the column to an Equifax code (e.g. "Active" -> "A", "Bi-Weekly" -> "6", "Hourly" -> "09"). Use constants for a value that applies to every row of a sheet but has no column (for example the sheet title says every check is weekly).

${RULES}

In notes, briefly say what each sheet is and anything that could not be mapped.

${fieldGuide()}`;

const MAP_SCHEMA = {
  type: 'object',
  properties: {
    sheets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sheet: { type: 'string' },
          header_row: { type: 'integer' },
          first_data_row: { type: 'integer' },
          columns: {
            type: 'array',
            items: {
              type: 'object',
              properties: { column: { type: 'string', description: 'Column letter, e.g. "C"' }, field: { type: 'string', enum: MAP_TARGETS } },
              required: ['column', 'field'],
              additionalProperties: false,
            },
          },
          value_maps: {
            type: 'array',
            items: {
              type: 'object',
              properties: { field: { type: 'string', enum: FIELD_KEYS }, from: { type: 'string' }, to: { type: 'string' } },
              required: ['field', 'from', 'to'],
              additionalProperties: false,
            },
          },
          constants: {
            type: 'array',
            items: {
              type: 'object',
              properties: { field: { type: 'string', enum: FIELD_KEYS }, value: { type: 'string' } },
              required: ['field', 'value'],
              additionalProperties: false,
            },
          },
        },
        required: ['sheet', 'header_row', 'first_data_row', 'columns', 'value_maps', 'constants'],
        additionalProperties: false,
      },
    },
    notes: { type: 'string' },
  },
  required: ['sheets', 'notes'],
  additionalProperties: false,
};

async function ask({ system, content, schema, maxTokens }) {
  const stream = getClient().beta.messages.stream({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content }],
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  });
  const response = await stream.finalMessage();
  if (response.stop_reason === 'refusal') throw Object.assign(new Error('refusal'), { userMessage: 'Claude declined to read this file.' });
  if (response.stop_reason === 'max_tokens') throw Object.assign(new Error('max_tokens'), { userMessage: 'This file has more records than fit in one pass. Split it into smaller files and upload again.' });
  const text = response.content.find(b => b.type === 'text');
  if (!text) throw Object.assign(new Error('empty'), { userMessage: 'Claude returned nothing for this file. Try again.' });
  return JSON.parse(text.text);
}

// ---------- spreadsheets ----------
const colLetter = n => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const colNumber = s => String(s).toUpperCase().replace(/[^A-Z]/g, '').split('').reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);

function cellValue(v) {
  if (v == null) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map(t => t.text).join('');
    if ('result' in v) return cellValue(v.result);
    if (v.text != null) return cellValue(v.text);
    if (v.error) return '';
    return '';
  }
  return v;
}
const show = v => v instanceof Date ? TWN.normDate(v) : String(v);

function parseDelimited(text) {
  const first = text.split(/\r?\n/, 1)[0] || '';
  const counts = { ',': 0, '|': 0, '\t': 0, ';': 0 };
  for (const ch of first) if (ch in counts) counts[ch]++;
  const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ',';
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"' && cur === '') q = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// -> [{ name, rows: [[v, v, ...], ...] }]  (rows[0] is spreadsheet row 1)
async function readSheets(file) {
  const name = file.originalname.toLowerCase();
  if (/\.(csv|txt|tsv)$/.test(name) || file.mimetype === 'text/csv') {
    return [{ name: file.originalname, rows: parseDelimited(file.buffer.toString('utf8').replace(/^﻿/, '')) }];
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file.buffer);
  const sheets = [];
  wb.eachSheet(ws => {
    if (ws.state && ws.state !== 'visible') return;
    const rows = [];
    ws.eachRow({ includeEmpty: true }, (r, i) => {
      const arr = [];
      r.eachCell({ includeEmpty: true }, (c, col) => { arr[col - 1] = cellValue(c.value); });
      rows[i - 1] = Array.from(arr, v => v == null ? '' : v);
    });
    sheets.push({ name: ws.name, rows: Array.from(rows, r => r || []) });
  });
  return sheets;
}

const nonEmptyRows = sheet => sheet.rows.filter(r => r.some(v => String(v).trim() !== '')).length;

function sheetText(sheet, maxRows) {
  const lines = [];
  sheet.rows.slice(0, maxRows).forEach((r, i) => {
    const cells = r.map((v, c) => String(v).trim() === '' ? null : `${colLetter(c + 1)}=${show(v)}`).filter(Boolean);
    if (cells.length) lines.push(`Row ${i + 1}: ${cells.join(' | ')}`);
  });
  return lines.join('\n');
}

function columnSamples(sheet) {
  const width = Math.max(0, ...sheet.rows.map(r => r.length));
  const out = [];
  for (let c = 0; c < width; c++) {
    const seen = new Set();
    for (const r of sheet.rows) { const v = String(show(r[c] ?? '')).trim(); if (v) seen.add(v); if (seen.size >= 15) break; }
    if (seen.size) out.push(`${colLetter(c + 1)}: ${[...seen].join(' ; ').slice(0, 400)}`);
  }
  return out.join('\n');
}

function splitName(v, order) {
  const s = String(v || '').trim();
  if (!s) return {};
  if (order === 'last_first' || s.includes(',')) {
    const [last, rest = ''] = s.split(',');
    return { last_name: last.trim(), first_name: rest.trim().split(/\s+/)[0] || '' };
  }
  const parts = s.split(/\s+/);
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

function applyMapping(sheets, mapping) {
  const records = [];
  for (const m of mapping.sheets || []) {
    const sheet = sheets.find(s => s.name === m.sheet) || (sheets.length === 1 ? sheets[0] : null);
    if (!sheet) continue;
    const vmap = {};
    for (const v of m.value_maps || []) (vmap[v.field] ||= {})[String(v.from).trim().toLowerCase()] = v.to;
    const start = Math.max(1, m.first_data_row || (m.header_row || 0) + 1);
    for (let i = start - 1; i < sheet.rows.length; i++) {
      const row = sheet.rows[i];
      if (!row || !row.some(v => String(v).trim() !== '')) continue;
      const rec = {};
      for (const c of m.columns || []) {
        if (c.field === 'ignore') continue;
        const raw = row[colNumber(c.column) - 1];
        if (raw == null || String(raw).trim() === '') continue;
        if (c.field === 'full_name_last_first' || c.field === 'full_name_first_last') {
          Object.assign(rec, splitName(raw, c.field === 'full_name_last_first' ? 'last_first' : 'first_last'));
          continue;
        }
        const mapped = vmap[c.field] && vmap[c.field][String(show(raw)).trim().toLowerCase()];
        rec[c.field] = mapped != null ? mapped : raw;
      }
      for (const k of m.constants || []) if (rec[k.field] == null) rec[k.field] = k.value;
      const norm = TWN.normalizeRecord(rec);
      // skip totals/blank lines: a real row names a person
      if (!norm.ssn && !norm.first_name && !norm.last_name) continue;
      if (/^(grand\s+)?totals?\b/i.test(`${norm.first_name || ''} ${norm.last_name || ''}`.trim())) continue;
      norm._source = `${sheet.name} row ${i + 1}`;
      records.push(norm);
    }
  }
  return records;
}

// ---------- documents ----------
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

async function documentBlocks(file) {
  const label = { type: 'text', text: `File: ${file.originalname}` };
  const name = file.originalname.toLowerCase();
  if (file.mimetype === 'application/pdf' || name.endsWith('.pdf')) {
    return [label, { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.buffer.toString('base64') } }];
  }
  if (IMAGE_TYPES.includes(file.mimetype)) {
    return [label, { type: 'image', source: { type: 'base64', media_type: file.mimetype, data: file.buffer.toString('base64') } }];
  }
  if (name.endsWith('.docx')) {
    const text = (await mammoth.extractRawText({ buffer: file.buffer })).value;
    return [{ type: 'text', text: `File: ${file.originalname}\n\n${text.slice(0, MAX_TEXT_CHARS)}` }];
  }
  return [{ type: 'text', text: `File: ${file.originalname}\n\n${file.buffer.toString('utf8').slice(0, MAX_TEXT_CHARS)}` }];
}

function toRecords(out, fallbackSource) {
  return (out.records || []).map(r => {
    const rec = {};
    for (const { key, value } of r.fields || []) if (String(value).trim() !== '') rec[key] = value;
    const norm = TWN.normalizeRecord(rec);
    norm._source = r.source || fallbackSource;
    return norm;
  }).filter(r => Object.keys(r).length > 1);
}

const isSheet = f => /\.(xlsx|xlsm|csv|tsv)$/i.test(f.originalname) || f.mimetype === 'text/csv' || f.mimetype.includes('spreadsheetml');

// file: multer memory file -> { records, notes, method }
async function extractFile(file) {
  if (/\.xls$/i.test(file.originalname)) throw Object.assign(new Error('xls'), { userMessage: `${file.originalname}: old .xls format. Open it in Excel and save as .xlsx or .csv, then upload again.` });
  if (isSheet(file)) {
    const sheets = (await readSheets(file)).filter(s => nonEmptyRows(s) > 0);
    if (!sheets.length) return { records: [], notes: 'The spreadsheet is empty.', method: 'sheet' };
    const big = sheets.some(s => nonEmptyRows(s) > DIRECT_MAX_ROWS);
    if (big) {
      const content = sheets.map(s => ({
        type: 'text',
        text: `Sheet "${s.name}" (${s.rows.length} rows)\nFirst rows:\n${sheetText(s, SAMPLE_ROWS)}\n\nDistinct values per column:\n${columnSamples(s)}`,
      }));
      content.push({ type: 'text', text: `File: ${file.originalname}. Map the columns.` });
      const mapping = await ask({ system: MAP_SYSTEM, content, schema: MAP_SCHEMA, maxTokens: 16000 });
      return { records: applyMapping(sheets, mapping), notes: mapping.notes || '', method: 'mapped' };
    }
    const text = sheets.map(s => `Sheet "${s.name}"\n${sheetText(s, DIRECT_MAX_ROWS + 5)}`).join('\n\n');
    const out = await ask({ system: DIRECT_SYSTEM, content: [{ type: 'text', text: `File: ${file.originalname}\n\n${text}` }, { type: 'text', text: 'Extract the records.' }], schema: DIRECT_SCHEMA, maxTokens: 64000 });
    return { records: toRecords(out, file.originalname), notes: out.notes || '', method: 'read' };
  }
  const blocks = await documentBlocks(file);
  const out = await ask({ system: DIRECT_SYSTEM, content: [...blocks, { type: 'text', text: 'Extract the records.' }], schema: DIRECT_SCHEMA, maxTokens: 64000 });
  return { records: toRecords(out, file.originalname), notes: out.notes || '', method: 'read' };
}

module.exports = { extractFile, parseDelimited, applyMapping };
