// node scripts/test-alert.js: sends one sample alert. Nothing is saved to the inbox.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { sendAlert } = require('../server/notify');

const sample = {
  event_name: 'TEST ALERT, not a real request', artist: 'Sample Artist', start_date: '2027-01-15', end_date: '2027-01-16',
  venue: 'Sample Venue', city_state: 'Billings, MT', delivery: 'Pick up', name: 'Rentals site test', company: '',
  email: process.env.NOTIFY_TO, phone: '555-010-0000', notes: '',
};
sendAlert('R-TEST00', sample, [{ gear: 'Drum kit', category: 'Drums', qty: 1, spec: 'DW' }, { gear: 'Vintage Rhodes', category: 'Custom request', qty: 1, spec: '73 key' }])
  .then((sent) => console.log(sent ? `Sent to ${process.env.NOTIFY_TO}` : 'Alerts are off (NOTIFY_TO or SMTP_HOST not set)'))
  .catch((e) => { console.error('Failed:', e.message); process.exitCode = 1; });
