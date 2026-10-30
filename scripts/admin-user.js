// node scripts/admin-user.js <username> "<Name>" [password]
// Creates an admin login, or resets the password if it already exists. Prints the password.
const crypto = require('crypto');
const { db, hashPassword } = require('../server/db');

const [username, name, given] = process.argv.slice(2);
if (!username || !name) {
  console.error('usage: node scripts/admin-user.js <username> "<Name>" [password]');
  process.exit(1);
}
const password = given || crypto.randomBytes(9).toString('base64url');
db.prepare(`INSERT INTO users (username, name, password_hash) VALUES (?, ?, ?)
  ON CONFLICT(username) DO UPDATE SET name = excluded.name, password_hash = excluded.password_hash`)
  .run(username, name, hashPassword(password));
console.log(`${username} / ${password}`);
