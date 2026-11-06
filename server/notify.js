// Emails a new-request alert. Delivered straight to the recipient's mail server,
// with no mailbox login. Outbound port 25 only works over IPv6 from this server, and
// Microsoft requires SPF or DKIM there (450 4.7.26), so rentals.odoubleg.com needs an
// SPF TXT record listing the server's IPv6 address. Off unless NOTIFY_TO and SMTP_HOST
// are set. A failed alert never fails the request: it is already saved in the inbox.
const nodemailer = require('nodemailer');

function alertText(ref, v, items) {
  const lines = [
    `New backline request ${ref}`,
    '',
    `Event:   ${v.event_name}`,
    v.artist ? `Artist:  ${v.artist}` : null,
    `Dates:   ${v.start_date} to ${v.end_date}`,
    v.venue ? `Venue:   ${v.venue}` : null,
    `City:    ${v.city_state}`,
    `Gear:    ${v.delivery}`,
    '',
    `Contact: ${v.name}${v.company ? `, ${v.company}` : ''}`,
    `Email:   ${v.email}`,
    `Phone:   ${v.phone}`,
    '',
    'Requested:',
    ...items.map((i) => `  ${i.qty} x ${i.gear}${i.spec ? ` (${i.spec})` : ''}`),
    v.other_gear ? `\nAnything else:\n${v.other_gear}` : null,
    v.notes ? `\nNotes:\n${v.notes}` : null,
    '',
    'Open the inbox: https://rentals.odoubleg.com/admin',
  ];
  return lines.filter((l) => l !== null).join('\n');
}

async function sendAlert(ref, value, items) {
  const { NOTIFY_TO, NOTIFY_FROM, SMTP_HOST, SMTP_PORT } = process.env;
  if (!NOTIFY_TO || !SMTP_HOST) return false;
  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 25,
    secure: false,
    name: 'rentals.odoubleg.com',
    connectionTimeout: 20000,
  });
  await transport.sendMail({
    from: { name: 'O Double G Rentals', address: NOTIFY_FROM },
    to: NOTIFY_TO,
    replyTo: { name: value.name, address: value.email },
    subject: `Backline request ${ref}: ${value.event_name}`,
    text: alertText(ref, value, items),
  });
  return true;
}

module.exports = { sendAlert };
