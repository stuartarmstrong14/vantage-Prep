'use strict';
// Use this if the administrator forgets their password:
//   npm run reset-password -- <username> <new password>
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('../lib/passwords');

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.error('Usage: npm run reset-password -- <username> <new password>');
  process.exit(1);
}
if (password.length < 8) {
  console.error('The new password must be at least 8 characters.');
  process.exit(1);
}
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const db = new DatabaseSync(path.join(dataDir, 'prep.db'));
db.exec('PRAGMA busy_timeout = 5000;');

hashPassword(password).then((hash) => {
  const info = db.prepare('UPDATE users SET pass_hash = ?, ver = ver + 1, active = 1 WHERE username = ?').run(hash, username);
  if (!info.changes) {
    console.error('No user called "' + username + '" was found.');
    process.exit(1);
  }
  console.log('Password changed for ' + username + '. They are signed out everywhere and the account is active.');
});
