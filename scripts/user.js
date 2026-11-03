// node scripts/user.js <email> <name> [password]
// Creates a login, or resets the password of an existing one. Without a
// password, a random one is generated and printed.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const crypto = require('crypto');
const db = require('../server/db');
const { hashPassword } = require('../server/auth');

const [email, name, given] = process.argv.slice(2);
if (!email || !name) { console.error('Usage: node scripts/user.js <email> <name> [password]'); process.exit(1); }
const password = given || crypto.randomBytes(9).toString('base64url');
const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
if (existing) db.prepare('UPDATE users SET name = ?, password_hash = ? WHERE id = ?').run(name, hashPassword(password), existing.id);
else db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)').run(email, name, hashPassword(password));
console.log(`${existing ? 'Reset' : 'Created'} ${email}${given ? '' : `  password: ${password}`}`);
