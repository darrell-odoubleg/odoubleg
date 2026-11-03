// The Work Number (Equifax) DTS Prime ONE payroll file: field list, code
// tables and checks, taken from "O Double G - DTS Prime ONE Spec - MASTER
// TEMPLATE.xlsx" (tabs Data Specs, TWN (Single File) Sample, Status Code
// Table, Pay Frequency Table, Pay Rate Description Table).
// Shared by public/index.html and server/twn.js (browser global TWN / CommonJS).
//
// One record = one paycheck for one employee. `label` is the exact column
// header from the TWN (Single File) Sample tab; the export uses it as-is.
// `spec` is the field name on the Data Specs tab (for filling column E).
// `def: true` means Settings can hold a company-wide default that applies
// when the record leaves the field blank.

(function (root) {
  const STATUS = [
    ['A', 'Active'], ['5', 'Active - works as needed'], ['H', 'Blocked'], ['C', 'Casual'],
    ['U', 'Currently Employed'], ['Q', 'Deceased'], ['I', 'Inactive'], ['X', 'Intern'],
    ['O', 'Layoff'], ['M', 'Multiple Positions'], ['N', 'New Employee'], ['G', 'No Longer Employed'],
    ['B', 'On International Assignment'], ['L', 'On Leave'], ['D', 'On Long-term Disability'],
    ['K', 'On Sabbatical'], ['2', 'Part of Divested Population'], ['P', 'Part Time'], ['R', 'Retired'],
    ['Z', 'Seasonal'], ['S', 'Separated'], ['W', 'Severed with Pay'], ['E', 'Sick Leave'],
    ['F', 'Surviving Spouse'], ['V', 'Temporarily Inactive'], ['Y', 'Temporary'], ['J', 'Transferred'],
  ];
  // Statuses that mean the person is not working; the spec makes the
  // termination/inactivity date required for these.
  const INACTIVE_STATUS = ['H', 'Q', 'I', 'O', 'G', 'R', 'S', 'W', 'F', 'V', 'J', '2', 'D'];

  const EMP_TYPE = [['F', 'Full-time'], ['P', 'Part-time'], ['C', 'Casual (On-call)'], ['S', 'Seasonal'], ['T', 'Temporary']];
  const PAY_FREQ = [['1', 'Annually'], ['2', 'Semi-annually'], ['4', 'Monthly'], ['5', 'Semi-monthly'], ['6', 'Bi-Weekly'], ['7', 'Weekly'], ['8', 'Daily']];
  const PAY_RATE = [
    ['01', 'Annually'], ['02', 'Semi-annually'], ['04', 'Monthly'], ['05', 'Semi-monthly'], ['06', 'Bi-weekly'],
    ['07', 'Weekly'], ['08', 'Daily'], ['09', 'Hourly'], ['10', '13 Times/Year'], ['11', 'Commission Only'],
    ['12', '10 Times/Year'], ['13', 'Guaranteed Income'], ['14', '11 Times/Year'], ['15', 'Owner Base Pay'],
    ['16', 'Hourly w/o Commission'], ['17', 'Hourly + Commission'], ['18', 'Quarterly'], ['19', 'Monthly Pension'],
    ['20', 'Monthly - 2X Jan, no pay Dec'], ['21', 'Hourly or Commission'], ['22', 'Per Trip'], ['23', 'Per Task'],
    ['24', 'Monthly - Academic 9 month'], ['25', 'Monthly - Academic 10 month'], ['26', 'Academic per semester'],
    ['27', 'Monthly - Academic 12 Month'], ['28', 'Annual - Academic 9 Month'], ['29', 'Annual - Academic 10 Month'],
    ['30', 'Annual - Academic 12 Month'], ['31', 'Annual - Academic 11 Month'], ['32', 'Monthly - Academic 11 Month'],
  ];
  const LOC_STATUS = [['O', 'Open'], ['F', 'Future'], ['C', 'Closed']];
  const STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR VI GU AS MP'.split(' ');

  // type: text | ssn | date | money | hours | int | code | state | digits | email | phone
  const F = (key, label, group, type, extra = {}) => ({ key, label, group, type, spec: label, ...extra });
  const money = (key, label, extra) => F(key, label, 'income', 'money', { fmt: 'Numeric 8.2', ...extra });
  const ded = (key, label) => F(key, label, 'deductions', 'money', { fmt: 'Numeric 8.2', hint: 'Enter 0 if no deduction. Negative only for a reversal.' });

  const FIELDS = [
    // ---- Sprint 1: Employment ----
    F('employer_code', 'Employer Company Code', 'employment', 'digits', { max: 10, settingOnly: true, required: true, hint: 'Company code assigned by Equifax (up to 10 digits).' }),
    F('ssn', 'SSN', 'employment', 'ssn', { required: true, sensitive: true, hint: "Employee's SSN (9 digits)." }),
    F('as_of_date', 'As of Date', 'employment', 'date', { hint: "Employee's most recent check date. Blank = uses Date Paid." }),
    F('first_name', 'Employee First Name', 'employment', 'text', { max: 32, required: true }),
    F('last_name', 'Employee Last Name', 'employment', 'text', { max: 32, required: true }),
    F('address1', 'Address Line 1', 'employment', 'text', { max: 30 }),
    F('address2', 'Address Line 2', 'employment', 'text', { max: 30 }),
    F('city', 'City', 'employment', 'text', { max: 20 }),
    F('state', 'State', 'employment', 'state'),
    F('zip', 'Zip', 'employment', 'digits', { max: 10 }),
    F('email', 'Employee Email Address', 'employment', 'email', { hint: 'Does not display on verifications (suggested).' }),
    F('home_phone', 'Employee Home Phone', 'employment', 'phone', { hint: 'Displays on SSV verifications only (suggested).' }),
    F('dob', 'Employee Date of Birth', 'employment', 'date', { sensitive: true }),
    F('job_title', 'Job Title', 'employment', 'text', { max: 31 }),
    F('original_hire_date', 'Original Hire Date', 'employment', 'date', { required: true }),
    F('adjusted_hire_date', 'Adjusted Hire Date', 'employment', 'date', { hint: 'Optional. For a break in service, to credit the earlier work period.' }),
    F('most_recent_hire_date', 'Most Recent Hire Date', 'employment', 'date', { hint: 'For a rehire. Blank = Equifax uses Original Hire Date.' }),
    F('user_id', 'User ID', 'employment', 'text', { max: 64, hint: 'Unique ID per employee. No PII (not SSN/name/DOB). Records with the same User ID or SSN fill each other’s blank details.' }),
    F('pin', 'PIN', 'employment', 'digits', { max: 8, def: true, hint: 'Default PIN, 8 digits.' }),
    F('status', 'Employee Status', 'employment', 'code', { options: STATUS, def: true, required: true }),
    F('employee_type', 'Employee Type', 'employment', 'code', { options: EMP_TYPE, def: true, required: true }),
    F('term_date', 'Date of Termination/Inactivity/Retirement', 'employment', 'date', { hint: 'Required when the status is an inactive one.' }),
    F('pay_frequency', 'Pay Frequency', 'employment', 'code', { options: PAY_FREQ, def: true, required: true, hint: 'How often the employee is paid.' }),
    F('division', 'Division', 'employment', 'text', { max: 12, def: true, hint: 'Optional. Sorts usage reports; prints on verifications.' }),

    // ---- Sprint 2: Income ----
    F('fein', 'FEIN', 'income', 'digits', { max: 15, def: true, hint: 'FEIN of the employer where the employee works.' }),
    F('avg_hours', 'Average Hours Worked', 'income', 'int', { max: 3, hint: 'Optional. Average hours per pay period.' }),
    F('pay_rate', "Employee's Current Pay Rate Amount", 'income', 'money', { fmt: 'Numeric 8.4', decimals: 4, hint: 'e.g. $500/week → 500.00 with description Weekly.' }),
    F('pay_rate_code', "Employee's Current Pay Rate Description Code", 'income', 'code', { options: PAY_RATE, def: true, hint: 'Must match the pay rate above (Hourly, Weekly…).' }),
    F('pp_begin', 'Pay Period Begin Date', 'income', 'date'),
    F('pp_end', 'Pay Period End Date', 'income', 'date'),
    F('check_date', 'Date Paid/Check Date', 'income', 'date', { required: true }),
    F('hours_current', 'Total Hours Worked Current Pay Period', 'income', 'hours', { fmt: 'Numeric 5.2', hint: 'All hours paid, including vacation, sick and holiday.' }),
    money('gross_current', 'Gross Total Wages Current Pay Period', { required: true }),
    money('net_current', 'Net Pay Current Pay Period'),
    money('ytd_regular', 'YTD Regular/Base Earnings', { ytd: true }),
    money('ytd_overtime', 'YTD Overtime Earnings', { ytd: true }),
    money('ytd_bonus', 'YTD Bonus Earnings', { ytd: true }),
    money('ytd_commission', 'YTD Commission Earnings', { ytd: true, spec: 'YTD Commissions Earnings' }),
    money('ytd_other', 'YTD Other Earnings', { ytd: true }),
    money('ytd_holiday', 'YTD Holiday Earnings', { ytd: true }),
    money('ytd_pension', 'YTD Pension Earnings', { ytd: true }),
    money('ytd_shift_diff', 'YTD Shift Differential Pay', { ytd: true }),
    money('ytd_severance', 'YTD Severance Pay', { ytd: true }),
    money('ytd_stock', 'YTD Stock Pay', { ytd: true }),
    money('ytd_sick', 'YTD Sick Pay', { ytd: true }),
    money('ytd_vacation', 'YTD Vacation Pay', { ytd: true }),
    money('ytd_tips', 'YTD Tips Pay', { ytd: true }),
    money('ytd_gross', 'YTD Gross Total', { fmt: 'Numeric 10.2', hint: 'Blank = sum of the YTD lines above.' }),

    // ---- Current pay period deductions ----
    ded('ded_cafeteria', 'Current Pay Period Cafeteria Plan Deduction'),
    ded('ded_401k', 'Current Pay Period Retirement/401K Deduction'),
    ded('ded_federal', 'Current Pay Period Federal Tax Deduction'),
    ded('ded_state', 'Current Pay Period State Tax Deduction'),
    ded('ded_local', 'Current Pay Period Local Tax Deduction'),
    ded('ded_fica', 'Current Pay Period Social Security Administration (FICA) Tax Deduction'),
    ded('ded_medicare', 'Current Pay Period Medicare Tax Deduction'),
    ded('ded_garnish', 'Current Pay Period Garnishments Deduction'),
    ded('ded_other', 'Current Pay Period Other Withholdings'),

    // ---- TCI (tax credit) columns: on the Data Specs tab, not the sample ----
    F('tci_company_code', 'TCI Employer Company Code', 'tci', 'digits', { max: 10, settingOnly: true, hint: 'Hard-coded value from Equifax.' }),
    F('tci_ytd_hours', 'TCI - YTD Hours Worked', 'tci', 'hours', { fmt: 'Numeric 4.2' }),
    F('tci_ytd_futa', 'TCI - YTD FUTA Wages', 'tci', 'money', { fmt: 'Numeric 11.2', hint: 'YTD wages subject to FUTA (no $7,000 cap).' }),
    F('loc_number', 'TCI - Location', 'tci', 'text', { max: 11, def: true, hint: 'Work location number.' }),
    F('loc_name', 'TCI - Location Legal Entity Name', 'tci', 'text', { max: 30, def: true }),
    F('loc_addr1', 'TCI - Location Street Address Line 1', 'tci', 'text', { max: 30, def: true }),
    F('loc_addr2', 'TCI - Location Street Address Line 2', 'tci', 'text', { max: 30, def: true }),
    F('loc_city', 'TCI - Location City', 'tci', 'text', { max: 20, def: true }),
    F('loc_state', 'TCI - Location State', 'tci', 'state', { def: true }),
    F('loc_zip', 'TCI - Location ZIP Code', 'tci', 'digits', { max: 5, def: true }),
    F('loc_phone', 'TCI - Location Phone Number', 'tci', 'phone', { def: true }),
    F('loc_fein', 'TCI - Location FEIN', 'tci', 'digits', { max: 15, def: true, hint: 'FEIN for the location the employee is paid out of.' }),
    F('loc_status', 'TCI - Location Status Code', 'tci', 'code', { options: LOC_STATUS, def: true }),
    F('loc_began', 'TCI - Location Date Facility Began Operation Date', 'tci', 'date', { def: true }),
    F('loc_ceased', 'TCI - Location Date Facility Ceased Operation Date', 'tci', 'date', { def: true }),
  ];

  const GROUPS = [
    { key: 'employment', label: 'Employment (Sprint 1)' },
    { key: 'income', label: 'Income (Sprint 2)' },
    { key: 'deductions', label: 'Current Pay Period Deductions (Sprint 2)' },
    { key: 'tci', label: 'TCI / Work Location (optional)' },
  ];

  const BY_KEY = Object.fromEntries(FIELDS.map(f => [f.key, f]));
  const PERSON_KEYS = FIELDS.filter(f => f.group === 'employment' && !f.settingOnly && f.key !== 'as_of_date').map(f => f.key);

  // ---- normalizing values (from typing, uploads or spreadsheets) ----
  const pad = n => String(n).padStart(2, '0');

  // -> 'MM/DD/YYYY' or '' (unparseable input is returned as-is so it shows up as an error)
  function normDate(v) {
    if (v == null || v === '') return '';
    if (v instanceof Date) return isNaN(v) ? '' : `${pad(v.getUTCMonth() + 1)}/${pad(v.getUTCDate())}/${v.getUTCFullYear()}`;
    if (typeof v === 'number' && v > 20000 && v < 80000) { // Excel serial date
      const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
      return normDate(d);
    }
    const s = String(v).trim();
    let m;
    if ((m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/))) return `${pad(m[2])}/${pad(m[3])}/${m[1]}`;
    if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/))) {
      let y = m[3]; if (y.length === 2) y = (Number(y) > 50 ? '19' : '20') + y;
      return `${pad(m[1])}/${pad(m[2])}/${y}`;
    }
    if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return `${m[2]}/${m[3]}/${m[1]}`;
    const t = Date.parse(s);
    if (!isNaN(t) && /[a-z]/i.test(s)) { const d = new Date(t); return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`; }
    return s;
  }
  // 'MM/DD/YYYY' <-> 'YYYY-MM-DD' for <input type=date>
  const toIso = s => { const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? `${m[3]}-${m[1]}-${m[2]}` : ''; };
  const fromIso = s => { const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${m[2]}/${m[3]}/${m[1]}` : ''; };
  const dateKey = s => toIso(s) || ''; // sortable

  function normNumber(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'number') return String(v);
    let s = String(v).trim();
    const neg = /^\(.*\)$/.test(s) || /-$/.test(s);
    s = s.replace(/[$,\s()]/g, '').replace(/-$/, '');
    if (s === '' || s === '-') return '';
    if (!/^-?\d*\.?\d+$/.test(s)) return String(v).trim();
    return String((neg ? -1 : 1) * Number(s));
  }

  function normCode(field, v) {
    if (v == null || v === '') return '';
    const s = String(v).trim();
    const opts = field.options;
    let hit = opts.find(([c]) => c.toLowerCase() === s.toLowerCase());
    if (!hit && field.key === 'pay_rate_code' && /^\d$/.test(s)) hit = opts.find(([c]) => c === '0' + s);
    if (!hit) hit = opts.find(([, d]) => d.toLowerCase() === s.toLowerCase());
    if (!hit) hit = opts.find(([, d]) => d.toLowerCase().replace(/[^a-z]/g, '') === s.toLowerCase().replace(/[^a-z]/g, ''));
    return hit ? hit[0] : s;
  }

  function normalize(key, v) {
    const f = BY_KEY[key];
    if (!f) return v;
    if (v == null) return '';
    switch (f.type) {
      case 'date': return normDate(v);
      case 'money': case 'hours': case 'int': return normNumber(v);
      case 'ssn': { const d = String(v).replace(/\D/g, ''); return d.length ? (d.length < 9 && d.length >= 7 ? d.padStart(9, '0') : d) : String(v).trim(); }
      case 'digits': { const s = String(v).trim(); const d = s.replace(/[\s-]/g, ''); return /^\d+$/.test(d) ? d : s; }
      case 'phone': { const d = String(v).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); return d || String(v).trim(); }
      case 'state': {
        const s = String(v).trim().toUpperCase();
        return STATE_NAMES[s] || s;
      }
      case 'code': return normCode(f, v);
      default: return String(v).trim();
    }
  }

  const STATE_NAMES = {
    ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA', COLORADO: 'CO', CONNECTICUT: 'CT', DELAWARE: 'DE',
    'DISTRICT OF COLUMBIA': 'DC', FLORIDA: 'FL', GEORGIA: 'GA', HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA',
    KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD', MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN',
    MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV', 'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ',
    'NEW MEXICO': 'NM', 'NEW YORK': 'NY', 'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH', OKLAHOMA: 'OK', OREGON: 'OR',
    PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT',
    VERMONT: 'VT', VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI', WYOMING: 'WY', 'PUERTO RICO': 'PR',
  };

  function normalizeRecord(rec) {
    const out = {};
    for (const [k, v] of Object.entries(rec || {})) if (BY_KEY[k] && !BY_KEY[k].settingOnly) out[k] = normalize(k, v);
    return out;
  }

  // ---- export values: record value, else company default, else computed ----
  function sumYtd(rec) {
    let any = false, total = 0;
    for (const f of FIELDS) if (f.ytd && rec[f.key] !== '' && rec[f.key] != null && !isNaN(Number(rec[f.key]))) { any = true; total += Number(rec[f.key]); }
    return any ? String(Math.round(total * 100) / 100) : '';
  }

  function effective(rec, settings) {
    const defs = (settings && settings.defaults) || {};
    const out = {};
    for (const f of FIELDS) {
      let v = f.settingOnly ? defs[f.key] : rec[f.key];
      if ((v === '' || v == null) && f.def) v = defs[f.key];
      out[f.key] = v == null ? '' : String(v);
    }
    if (!out.as_of_date) out.as_of_date = out.check_date;
    if (!out.ytd_gross) out.ytd_gross = sumYtd(out);
    // Spec: YTD earnings are "numeric result or zero fill" and deductions are
    // "0 if there was no deduction", for every paycheck row.
    if (out.check_date) for (const f of FIELDS) if ((f.ytd || f.key === 'ytd_gross' || f.group === 'deductions') && out[f.key] === '') out[f.key] = '0';
    return out;
  }

  // ---- checks ----
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function validate(rec, settings) {
    const e = effective(rec, settings);
    const errors = [], warnings = [];
    const L = k => BY_KEY[k].label;
    for (const f of FIELDS) {
      const v = e[f.key];
      if (f.group === 'tci' && !(settings && settings.include_tci)) continue;
      if (v === '') { if (f.required) errors.push(`${L(f.key)} is missing`); continue; }
      switch (f.type) {
        case 'date': if (!/^\d{2}\/\d{2}\/\d{4}$/.test(v) || isNaN(Date.parse(toIso(v)))) errors.push(`${f.label}: "${v}" is not a date`); break;
        case 'money': case 'hours': case 'int':
          if (isNaN(Number(v))) errors.push(`${f.label}: "${v}" is not a number`);
          else if (Number(v) < 0 && f.group !== 'deductions') errors.push(`${f.label} can't be negative (the file cannot contain negative hours or wages)`);
          else if (f.type === 'int' && !Number.isInteger(Number(v))) warnings.push(`${f.label} should be a whole number`);
          break;
        case 'ssn': if (!/^\d{9}$/.test(v)) errors.push('SSN must be 9 digits'); break;
        case 'digits': if (!/^\d+$/.test(v)) errors.push(`${f.label} must be numbers only`); break;
        case 'phone': if (!/^\d{10}$/.test(v)) warnings.push(`${f.label} should be 10 digits`); break;
        case 'email': if (!EMAIL_RE.test(v)) warnings.push(`${f.label} doesn't look like an email`); break;
        case 'state': if (!STATES.includes(v)) errors.push(`${f.label}: "${v}" is not a state code`); break;
        case 'code': if (!f.options.some(([c]) => c === v)) errors.push(`${f.label}: "${v}" is not an Equifax code`); break;
      }
      if (f.max && v.length > f.max) warnings.push(`${f.label} is longer than ${f.max} characters (will be cut off on verifications)`);
    }
    if (e.pin && !/^\d{8}$/.test(e.pin)) errors.push('PIN must be exactly 8 digits');
    if (INACTIVE_STATUS.includes(e.status) && !e.term_date) errors.push('Termination/Inactivity date is required for this status');
    if (e.user_id && e.ssn && e.user_id.replace(/\D/g, '') === e.ssn) errors.push('User ID cannot be the SSN');
    const iso = k => toIso(e[k]);
    if (iso('pp_begin') && iso('pp_end') && iso('pp_begin') > iso('pp_end')) errors.push('Pay period begins after it ends');
    if (iso('term_date') && iso('original_hire_date') && iso('term_date') < iso('original_hire_date')) warnings.push('Termination date is before the hire date');
    if (e.pay_rate && !e.pay_rate_code) warnings.push('Pay rate has no Pay Rate Description Code');
    if (e.gross_current && e.net_current && Number(e.net_current) > Number(e.gross_current)) warnings.push('Net pay is more than gross pay');
    return { errors, warnings };
  }

  function personKey(rec) {
    const ssn = String(rec.ssn || '').replace(/\D/g, '');
    if (ssn.length === 9) return 'ssn:' + ssn;
    const n = `${rec.first_name || ''} ${rec.last_name || ''}`.trim().toLowerCase().replace(/\s+/g, ' ');
    return n ? 'name:' + n : '';
  }
  const userIdKey = rec => String(rec.user_id || '').trim().toLowerCase();
  function samePerson(a, b) {
    const sa = String(a.ssn || '').replace(/\D/g, ''), sb = String(b.ssn || '').replace(/\D/g, '');
    if (sa.length === 9 && sb.length === 9) return sa === sb;
    const ua = userIdKey(a), ub = userIdKey(b);
    if (ua && ub) return ua === ub;
    const na = `${a.first_name || ''} ${a.last_name || ''}`.trim().toLowerCase(), nb = `${b.first_name || ''} ${b.last_name || ''}`.trim().toLowerCase();
    return !!na && na === nb;
  }

  // Export column order: the TWN (Single File) Sample tab, then the TCI columns.
  function exportFields(includeTci) {
    return FIELDS.filter(f => f.group !== 'tci' || includeTci);
  }

  function fileName(settings, ext, d = new Date()) {
    const code = String((settings.defaults || {}).employer_code || 'EmployerCode').replace(/\D/g, '') || 'EmployerCode';
    const ymd = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    return `${code}_${ymd}_${settings.file_type === 'prod' ? 'prodin' : 'tstin'}.${ext}`;
  }

  const api = {
    FIELDS, GROUPS, BY_KEY, PERSON_KEYS, STATUS, INACTIVE_STATUS, EMP_TYPE, PAY_FREQ, PAY_RATE, LOC_STATUS, STATES,
    normalize, normalizeRecord, normDate, toIso, fromIso, dateKey, effective, validate, sumYtd, personKey, samePerson, userIdKey, exportFields, fileName,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TWN = api;
})(typeof window !== 'undefined' ? window : globalThis);
