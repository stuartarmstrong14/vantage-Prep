'use strict';
// Makes a safe copy of the database while the app is running:
//   npm run backup
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const outDir = path.join(dataDir, 'backups');
fs.mkdirSync(outDir, { recursive: true });
const d = new Date();
const p = (n) => String(n).padStart(2, '0');
const name = 'prep-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.db';
const target = path.join(outDir, name);

const db = new DatabaseSync(path.join(dataDir, 'prep.db'));
db.exec('PRAGMA busy_timeout = 5000;');
db.exec("VACUUM INTO '" + target.replace(/'/g, "''") + "'");
console.log('Backup saved to ' + target);
