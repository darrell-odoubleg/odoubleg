const fs = require('fs');
const path = require('path');

// Per-site service contracts, managed from the admin page. A device can only
// be put into vacation mode (closed for season) while its site has a
// contract covering today; once that lapses its devices are reopened.
// Keyed by Mist site id. Dates are inclusive YYYY-MM-DD strings.
const STATE_FILE = path.join(__dirname, '..', 'data', 'site-contracts.json');

// The server runs in UTC, but contract dates are days on the customer's
// calendar — Vision Net's sites are Mountain time.
const CONTRACT_TZ = process.env.CONTRACT_TZ || 'America/Denver';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function loadState() {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))));
  } catch {
    return new Map();
  }
}

const contracts = loadState();

function saveState() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(Object.fromEntries(contracts)));
}

// en-CA formats as YYYY-MM-DD, so dates compare correctly as strings.
function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CONTRACT_TZ }).format(new Date());
}

function getContract(siteId) {
  return contracts.get(siteId) || null;
}

function contractStatus(contract, day = today()) {
  if (!contract) return 'none';
  if (day < contract.start) return 'upcoming';
  if (day > contract.end) return 'expired';
  return 'active';
}

function hasActiveContract(siteId) {
  return contractStatus(getContract(siteId)) === 'active';
}

function validDate(s) {
  return typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(s));
}

function setContract(siteId, { start, end, notes, siteName, orgName }) {
  if (!validDate(start) || !validDate(end)) {
    return { ok: false, error: 'Start and end must be dates (YYYY-MM-DD)' };
  }
  if (end < start) return { ok: false, error: 'End date is before start date' };

  contracts.set(siteId, {
    start,
    end,
    notes: typeof notes === 'string' ? notes.trim().slice(0, 500) : '',
    siteName: siteName || null,
    orgName: orgName || null,
    updatedAt: new Date().toISOString(),
  });
  saveState();
  return { ok: true, contract: contracts.get(siteId) };
}

function deleteContract(siteId) {
  const existed = contracts.delete(siteId);
  if (existed) saveState();
  return existed;
}

module.exports = { today, getContract, contractStatus, hasActiveContract, setContract, deleteContract };
