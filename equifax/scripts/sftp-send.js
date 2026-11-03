// node scripts/sftp-send.js [--from MM/DD/YYYY] [--to MM/DD/YYYY] [--xlsx] [--overwrite]
// Same as "Send file to Equifax" on the Export tab. Default range: this year.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { sendToEquifax } = require('../server/twn');

const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const y = new Date().getFullYear();
sendToEquifax({ from: arg('--from') || `01/01/${y}`, to: arg('--to') || `12/31/${y}`, format: process.argv.includes('--xlsx') ? 'xlsx' : 'csv', overwrite: process.argv.includes('--overwrite') })
  .then(r => { console.log(`Sent ${r.filename}: ${r.rows} records for ${r.people} people (${r.with_errors} with errors), ${r.bytes} bytes -> ${r.remote_path}`); process.exit(0); })
  .catch(e => { console.error(e.userMessage || e.message); process.exit(1); });
