// Create a scholarship-page login, or reset its password.
//   node scripts/scholar-user.js <email> <name> <parent|student> [password]
// Without a password, a random one is generated and printed once.
require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
require('../routes/scholarships'); // creates the tables
const db = require('../db/init');

const [email, name, role, given] = process.argv.slice(2);
if (!email || !name || !['parent', 'student'].includes(role)) {
  console.error('Usage: node scripts/scholar-user.js <email> <name> <parent|student> [password]');
  process.exit(1);
}
const password = given || crypto.randomBytes(9).toString('base64url');
const hash = bcrypt.hashSync(password, 10);
const existing = db.prepare('SELECT id FROM scholar_users WHERE email = ?').get(email);
if (existing) {
  db.prepare('UPDATE scholar_users SET password_hash = ?, name = ?, role = ? WHERE id = ?').run(hash, name, role, existing.id);
  console.log(`Updated ${email} (${role}).`);
} else {
  db.prepare('INSERT INTO scholar_users (email, password_hash, name, role) VALUES (?, ?, ?, ?)').run(email, hash, name, role);
  console.log(`Created ${email} (${role}).`);
}
if (!given) console.log(`Password: ${password}`);
