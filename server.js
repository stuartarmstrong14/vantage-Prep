'use strict';
/*
 * Vantage prep tracker server.
 * No npm packages needed: uses only what ships with Node.js 22.13 or newer.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { execFile, execFileSync } = require('node:child_process');
const { hashPassword, verifyPassword } = require('./lib/passwords');
const inbound = require('./lib/inbound');
const { fetchWithChain } = require('./lib/tlsfix');
const digest = require('./lib/digest');
const s3 = require('./lib/s3');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const TZ_NAME = process.env.TZ_NAME || 'Europe/London';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const INBOUND_SECRET = String(process.env.INBOUND_SECRET || '');
const INBOUND_ALLOWED = String(process.env.INBOUND_ALLOWED || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const PUBLIC_URL = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
const SESSION_DAYS = 14;
const PUBLIC_DIR = path.join(__dirname, 'public');
const COOKIE_NAME = 'prep_session';

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- secret for signing session cookies ---------- */
function loadSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, 'session.secret');
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s.length >= 32) return s;
  } catch (e) { /* create below */ }
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}
const SECRET = loadSecret();

/* ---------- database ---------- */
const db = new DatabaseSync(path.join(DATA_DIR, 'prep.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
// Older databases allowed fewer roles. Rebuild the users table once so the CHECK lists every role.
(function migrateRoles() {
  const t = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  if (t && t.sql.indexOf("'valet'") < 0) {
    db.exec(`
      BEGIN;
      ALTER TABLE users RENAME TO users_old;
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display TEXT NOT NULL,
        initials TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin','staff','advisor','paint','alloy','dent','valet')),
        pass_hash TEXT NOT NULL,
        ver INTEGER NOT NULL DEFAULT 1,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      INSERT INTO users SELECT id, username, display, initials, role, pass_hash, ver, active, created_at FROM users_old;
      DROP TABLE users_old;
      COMMIT;
    `);
  }
})();
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display TEXT NOT NULL,
    initials TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','staff','advisor','paint','alloy','dent','valet')),
    pass_hash TEXT NOT NULL,
    ver INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cars (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mot_history (
    car_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    checked_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cost_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    hours REAL NOT NULL,
    cost REAL NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    car_id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    size INTEGER NOT NULL,
    data BLOB NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS files_car ON files (car_id);
`);

// Removed checks go to a recycle bin for 30 days instead of being deleted straight away.
(function migrateFiles() {
  const cols = db.prepare('PRAGMA table_info(files)').all().map((c) => c.name);
  if (!cols.includes('deleted_at')) db.exec('ALTER TABLE files ADD COLUMN deleted_at TEXT');
  if (!cols.includes('deleted_by')) db.exec('ALTER TABLE files ADD COLUMN deleted_by TEXT');
})();

// Cosmetic repair price list from the cosmetic matrix spreadsheet (Area of Repair, Time in hours, Internal cost).
// Version 2 (5 Nov 2026): adds Alloy Wheel; Dent now 1 hour.
// Version 3 (5 Nov 2026): Alloy Wheel and Dent are 0 hours (priced per item, no paint-shop time).
const COST_SEED = [
  ['Alloy Wheel', 0, 35], ['Bonnet', 4, 174], ['Bumper Corner', 2, 94], ['Dent', 0, 35], ['Diamond Cut Alloy', 1.5, 76.5], ['Door', 4, 174],
  ['Filler', 1.5, 76.5], ['Flat & Polish P/P', 0.5, 41.5], ['Front Wing', 2, 104], ['Full bumper', 4, 174], ['Full Car Flat & Polish', 5, 217],
  ['Half Bumper', 3, 129], ['Large Smart', 2, 112], ['Mirror Cover', 0.75, 50.25], ['New Panel', 3.5, 156.5], ['Painted Alloy', 1, 59],
  ['Panel Blend', 1, 59], ['Rear Quarter', 4, 174], ['Retexture', 1.5, 86.5], ['Roof', 6, 252], ['Sensors PK of 4', 1.5, 76.5], ['Sill', 2, 104],
  ['Small Smart', 1.5, 76.5], ['Spoiler', 2, 94], ['Tailgate', 4, 174], ['Touch-in', 0.5, 41.5], ['Tow Cover', 0.5, 41.5],
];
if (db.prepare('SELECT COUNT(*) AS c FROM cost_items').get().c === 0) {
  const ins = db.prepare('INSERT INTO cost_items (name, hours, cost, sort) VALUES (?, ?, ?, ?)');
  COST_SEED.forEach((r, i) => ins.run(r[0], r[1], r[2], i));
}
// Bring a list loaded from version 1 up to version 2 once: add Alloy Wheel, set Dent to 1 hour (only if nobody has changed it), sort as the sheet.
(function costListV2() {
  const has = (n) => db.prepare('SELECT id FROM cost_items WHERE name = ? AND active = 1').get(n);
  if (has('Alloy Wheel')) return;
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO cost_items (name, hours, cost, sort) VALUES (?, ?, ?, ?)').run('Alloy Wheel', 1, 35, 0);
    db.prepare("UPDATE cost_items SET hours = 1 WHERE name = 'Dent' AND hours = 0 AND cost = 35 AND active = 1").run();
    const order = COST_SEED.map((r) => r[0]);
    db.prepare('SELECT id, name, sort FROM cost_items WHERE active = 1').all().forEach((r) => {
      const i = order.indexOf(r.name);
      db.prepare('UPDATE cost_items SET sort = ? WHERE id = ?').run(i >= 0 ? i : 100 + r.sort, r.id);
    });
    db.exec('COMMIT');
    console.log('cosmetic price list updated to version 2 (Alloy Wheel added, Dent 1 hour)');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
})();

// Version 3, applied once: Alloy Wheel and Dent to 0 hours, unless someone has already changed them from the version 2 values.
db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
(function costListV3() {
  if (db.prepare("SELECT v FROM meta WHERE k = 'costs_v3'").get()) return;
  db.exec('BEGIN');
  try {
    const n = db.prepare("UPDATE cost_items SET hours = 0 WHERE name IN ('Alloy Wheel', 'Dent') AND hours = 1 AND cost = 35 AND active = 1").run().changes;
    db.prepare("INSERT INTO meta (k, v) VALUES ('costs_v3', ?)").run(new Date().toISOString());
    db.exec('COMMIT');
    if (n) console.log('cosmetic price list updated to version 3 (Alloy Wheel and Dent 0 hours)');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
})();

const q = {
  countUsers: db.prepare('SELECT COUNT(*) AS c FROM users'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  allUsers: db.prepare('SELECT id, username, display, initials, role, active, created_at FROM users ORDER BY display COLLATE NOCASE'),
  insertUser: db.prepare('INSERT INTO users (username, display, initials, role, pass_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  adminCountExcept: db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1 AND id <> ?"),
  allCars: db.prepare('SELECT id, data, updated_at, updated_by FROM cars ORDER BY rowid'),
  carById: db.prepare('SELECT id, data, updated_at, updated_by FROM cars WHERE id = ?'),
  insertCar: db.prepare('INSERT INTO cars (id, data, updated_at, updated_by) VALUES (?, ?, ?, ?)'),
  updateCar: db.prepare('UPDATE cars SET data = ?, updated_at = ?, updated_by = ? WHERE id = ?'),
  deleteCar: db.prepare('DELETE FROM cars WHERE id = ?'),
  motHistGet: db.prepare('SELECT data, checked_at FROM mot_history WHERE car_id = ?'),
  motHistPut: db.prepare('INSERT INTO mot_history (car_id, data, checked_at) VALUES (?, ?, ?) ON CONFLICT(car_id) DO UPDATE SET data = excluded.data, checked_at = excluded.checked_at'),
  motHistDel: db.prepare('DELETE FROM mot_history WHERE car_id = ?'),
  insertFile: db.prepare('INSERT INTO files (id, car_id, name, type, size, data, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  fileById: db.prepare('SELECT * FROM files WHERE id = ?'),
  costItems: db.prepare('SELECT id, name, hours, cost, sort FROM cost_items WHERE active = 1 ORDER BY sort, id'),
  costById: db.prepare('SELECT * FROM cost_items WHERE id = ? AND active = 1'),
  binFile: db.prepare('UPDATE files SET deleted_at = ?, deleted_by = ? WHERE id = ?'),
  binFilesForCar: db.prepare('UPDATE files SET deleted_at = ?, deleted_by = ? WHERE car_id = ? AND deleted_at IS NULL'),
  unbinFile: db.prepare('UPDATE files SET deleted_at = NULL, deleted_by = NULL WHERE id = ?'),
  purgeBin: db.prepare('DELETE FROM files WHERE deleted_at IS NOT NULL AND deleted_at < ?'),
  fileMeta: db.prepare('SELECT id, car_id, name, type, size, created_at, created_by, deleted_at, deleted_by FROM files'),
  fileIds: db.prepare('SELECT id FROM files'),
  deleteFile: db.prepare('DELETE FROM files WHERE id = ?'),
  deleteFilesForCar: db.prepare('DELETE FROM files WHERE car_id = ?'),
};

/* ---------- helpers ---------- */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

let rev = Date.now(); // bumps on every change so browsers can ask "anything new?"
const bump = () => { rev += 1; };

const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ_NAME, year: 'numeric', month: '2-digit', day: '2-digit' });
const todayStr = () => dateFmt.format(new Date());

function deriveInitials(display) {
  const words = display.trim().split(/\s+/).filter(Boolean);
  let s = words.length > 1 ? words.slice(0, 3).map(w => w[0]).join('') : (words[0] || '').slice(0, 2);
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'XX';
}
const cleanInitials = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);

const publicUser = (u) => ({ id: u.id, username: u.username, display: u.display, initials: u.initials, role: u.role });

/* ---------- sessions (signed cookie, no server-side store) ---------- */
function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
function makeToken(user) {
  const payload = Buffer.from(JSON.stringify({ u: user.id, v: user.ver, e: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
  return payload + '.' + sign(payload);
}
function readToken(token) {
  if (!token) return null;
  const i = token.indexOf('.');
  if (i < 1) return null;
  const payload = token.slice(0, i);
  const given = Buffer.from(token.slice(i + 1));
  const want = Buffer.from(sign(payload));
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.e > Date.now() ? data : null;
  } catch (e) { return null; }
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function isSecure(req) {
  return process.env.COOKIE_SECURE === '1' || !!req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
}
function setSession(req, res, user) {
  const parts = [COOKIE_NAME + '=' + makeToken(user), 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=' + SESSION_DAYS * 86400];
  if (isSecure(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearSession(req, res) {
  const parts = [COOKIE_NAME + '=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecure(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function currentUser(req) {
  const data = readToken(parseCookies(req)[COOKIE_NAME]);
  if (!data) return null;
  const u = q.userById.get(data.u);
  if (!u || !u.active || u.ver !== data.v) return null;
  return u;
}
function requireUser(req) {
  const u = currentUser(req);
  if (!u) throw new HttpError(401, 'Please sign in.');
  return u;
}
// Technician logins can only tick their own job (the alloy login can also set wheels to refine).
const ROLES = ['admin', 'staff', 'advisor', 'paint', 'alloy', 'dent', 'valet'];
const SPECIALIST = {
  paint: { done: ['body_paint'], fields: [], name: 'Paint' },
  alloy: { done: ['body_wheels'], fields: ['bodyWheels'], name: 'Alloys' },
  dent: { done: ['body_dent'], fields: [], name: 'Dents' },
  valet: { done: ['valet_done', 'photos_done'], fields: [], name: 'Valet and Photos' },
};
const DONE_BY_STAGE = [
  ['arrived', ['advert', 'lines', 'qr']], ['valet', ['done']], ['photos', ['done']],
  ['mech', ['pt145', 'service', 'motbook', 'qc']], ['body', ['cosmetic', 'dent', 'wheels', 'paint', 'qc']], ['ready', ['qc']],
];
function stageFromDone(done) {
  for (const [k, items] of DONE_BY_STAGE) if (!items.every((t) => done[k + '_' + t] === true)) return k;
  return 'ready';
}
function requireStaff(req) {
  const u = requireUser(req);
  if (u.role === 'advisor') throw new HttpError(403, 'Advisors can view progress but not change it.');
  if (SPECIALIST[u.role]) throw new HttpError(403, 'Your login can only update ' + SPECIALIST[u.role].name.toLowerCase() + '.');
  return u;
}
function requireAdmin(req) {
  const u = requireUser(req);
  if (u.role !== 'admin') throw new HttpError(403, 'Only an administrator can do that.');
  return u;
}

/* ---------- sign-in rate limit ---------- */
const failures = new Map();
const MAX_FAILS = 8;
const WINDOW_MS = 15 * 60 * 1000;
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress || 'unknown';
}
function limiterKey(req, username) { return clientIp(req) + '|' + String(username).toLowerCase(); }
function isLocked(key) {
  const f = failures.get(key);
  if (!f) return false;
  if (Date.now() - f.first > WINDOW_MS) { failures.delete(key); return false; }
  return f.count >= MAX_FAILS;
}
function recordFail(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > WINDOW_MS) failures.set(key, { count: 1, first: Date.now() });
  else f.count += 1;
}
setInterval(() => {
  for (const [k, f] of failures) if (Date.now() - f.first > WINDOW_MS) failures.delete(k);
}, 60 * 1000).unref();

const DUMMY_HASH = (() => {
  const salt = crypto.randomBytes(16);
  return 'scrypt1$' + salt.toString('hex') + '$' + crypto.scryptSync('dummy', salt, 64).toString('hex');
})();

/* ---------- request / response ---------- */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > 65536) { failed = true; reject(new HttpError(413, 'Request too large.')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (failed) return;
      if (!size) return resolve({});
      if (!String(req.headers['content-type'] || '').includes('application/json')) return reject(new HttpError(415, 'Invalid request.'));
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('shape');
        resolve(v);
      } catch (e) { reject(new HttpError(400, 'Invalid request.')); }
    });
    req.on('error', reject);
  });
}
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host;
  try { host = new URL(origin).host; } catch (e) { throw new HttpError(403, 'Blocked request.'); }
  if (host !== req.headers.host) throw new HttpError(403, 'Blocked request.');
}
function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
}

/* ---------- validation ---------- */
const PREP_ITEMS = ['TAC', 'SERVICE', 'MOT'];
const STAGE_KEYS = ['arrived', 'valet', 'photos', 'mech', 'body', 'ready'];
const SIGN = { bodyQcBy: ['bodyQcOn', 'bodyQcName'], finalQcBy: ['finalQcOn', 'finalQcName'] };
const TEXT_LIMITS = { reg: 10, make: 40, model: 40, colour: 30, tag: 12 };
const str = (v) => (typeof v === 'string' ? v : '');

function carOut(row) {
  return Object.assign({ id: row.id }, JSON.parse(row.data), { updatedAt: row.updated_at, updatedBy: row.updated_by });
}

// The cosmetic estimate decides whether the Dents and Alloy wheels jobs are needed:
// - a Dent line means dents need doing; no Dent line means the Dents box is ticked as "not needed"
// - alloy lines (Alloy Wheel, Diamond Cut Alloy, Painted Alloy) set the wheels to refine; none means "not needed"
// Every other line is cosmetic or paint work. A box the estimate marked "not needed" goes back to a normal job if
// the matching repair is added later, or if the estimate is cleared.
const DENT_ITEM = /^dents?$/i, ALLOY_ITEM = /alloy/i;
function estimateDrivesJobs(cur, next) {
  const est = next.estimate || [];
  const dents = est.filter((l) => DENT_ITEM.test(l.name)).reduce((n, l) => n + l.qty, 0);
  const wheels = est.filter((l) => ALLOY_ITEM.test(l.name)).reduce((n, l) => n + l.qty, 0);
  const done = Object.assign({}, next.done || cur.done || {});
  const nn = Object.assign({}, next.notNeeded || cur.notNeeded || {});
  const decide = (key, count) => {
    if (est.length && count === 0) { if (!done[key]) { done[key] = true; nn[key] = true; } }
    else if (nn[key]) { done[key] = false; delete nn[key]; }
  };
  decide('body_dent', dents);
  decide('body_wheels', wheels);
  if (wheels > 0 && !done.body_wheels) next.bodyWheels = Math.min(5, wheels);
  next.done = done; next.notNeeded = nn;
  next.stage = stageFromDone(done);
  if (next.stage !== cur.stage) next.readyAt = '';
}
function applyCarPatch(cur, body, user) {
  const next = Object.assign({}, cur);
  for (const key of Object.keys(body)) {
    const v = body[key];
    if (key in TEXT_LIMITS) {
      let s = str(v).trim().slice(0, TEXT_LIMITS[key]);
      if (key === 'reg') s = s.toUpperCase();
      next[key] = s;
    } else if (key === 'notes') {
      next.notes = str(v).slice(0, 5000);
    } else if (key === 'cosmeticNotes') {
      next.cosmeticNotes = str(v).slice(0, 1000);
    } else if (key === 'estimate') {
      // cosmetic estimate: lines of { id, qty } from the price list; the name is kept so an old line still reads if an item is removed
      if (!Array.isArray(v) || v.length > 40) throw new HttpError(400, 'Invalid estimate.');
      const prev = {}; (cur.estimate || []).forEach((l) => { prev[l.id] = l; });
      next.estimate = v.map((l) => {
        const id = Number(l && l.id), qty = Number(l && l.qty);
        if (!Number.isInteger(qty) || qty < 1 || qty > 20) throw new HttpError(400, 'Quantity must be a whole number from 1 to 20.');
        const item = q.costById.get(id);
        if (!item && !prev[id]) throw new HttpError(400, 'That repair is not on the price list.');
        return { id, name: item ? item.name : prev[id].name, qty };
      });
    } else if (key === 'mileage') {
      if (v === null || v === '') next.mileage = null;
      else if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 2000000) next.mileage = Math.round(v);
      else throw new HttpError(400, 'Mileage must be a number.');
    } else if (key === 'mot') {
      if (v === '' || v === null) next.mot = '';
      else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) next.mot = v;
      else throw new HttpError(400, 'MOT date is not valid.');
    } else if (key === 'stage') {
      if (!STAGE_KEYS.includes(v)) throw new HttpError(400, 'Unknown stage.');
      if (v !== cur.stage) next.stage = v;
    } else if (key === 'bodyWheels') {
      if (v === null || v === '') next.bodyWheels = null;
      else if (Number.isInteger(v) && v >= 0 && v <= 5) next.bodyWheels = v;
      else throw new HttpError(400, 'Wheels must be a whole number from 0 to 5.');
    } else if (key in SIGN) {
      const initials = cleanInitials(v);
      const [onKey, nameKey] = SIGN[key];
      if (initials !== (cur[key] || '')) {
        next[key] = initials;
        next[onKey] = initials ? todayStr() : '';
        next[nameKey] = initials ? user.display : '';
      }
    } else if (key === 'prep') {
      if (!Array.isArray(v) || v.some((x) => !PREP_ITEMS.includes(x))) throw new HttpError(400, 'Invalid request.');
      next.prep = PREP_ITEMS.filter((x) => v.includes(x));
    } else if (key === 'archived') {
      if (typeof v !== 'boolean') throw new HttpError(400, 'Invalid request.');
      next.archived = v;
    } else if (key === 'done') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'Invalid checklist.');
      const done = Object.assign({}, cur.done || {});
      for (const k of Object.keys(v)) {
        if (!/^[a-z]+_[a-z0-9]+$/.test(k) || typeof v[k] !== 'boolean') throw new HttpError(400, 'Invalid checklist.');
        done[k] = v[k];
      }
      if (Object.keys(done).length > 100) throw new HttpError(400, 'Invalid checklist.');
      next.done = done;
      // someone unticking a box the estimate marked as not needed takes it back to a normal job
      if (cur.notNeeded) { const nn = Object.assign({}, cur.notNeeded); Object.keys(v).forEach((k) => { if (v[k] === false) delete nn[k]; }); next.notNeeded = nn; }
    }
    // any other key is ignored on purpose
  }
  if ('estimate' in body) estimateDrivesJobs(cur, next);
  // Completed means every box ticked, including the final quality check. readyAt is the day that happened.
  // MOT due: put MOT on Prep requested, unless someone has taken it off for this MOT date.
  const tookOff = body.prep !== undefined && (cur.prep || []).includes('MOT') && !(next.prep || []).includes('MOT');
  if (tookOff && motSoon(next.mot)) next.motPrepOff = next.mot;
  else autoMotPrep(next);
  const finished = (d) => !!d && d.ready_qc === true && stageFromDone(d) === 'ready';
  if (finished(next.done)) { if (!finished(cur.done) || !cur.readyAt) next.readyAt = todayStr(); }
  else next.readyAt = '';
  stampHistory(cur, next, user);
  return next;
}

// MOT runs out within 6 months (or has expired): it needs doing as part of prep.
const MOT_DUE_MONTHS = 6;
function addMonths(iso, n) {
  let y = +iso.slice(0, 4), m = +iso.slice(5, 7) - 1 + n; const d = +iso.slice(8, 10);
  y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(Math.min(d, last)).padStart(2, '0');
}
function motSoon(mot) {
  return /^\d{4}-\d{2}-\d{2}$/.test(mot || '') && mot <= addMonths(todayStr(), MOT_DUE_MONTHS);
}
// Adds MOT to Prep requested when due. Skipped for finished or archived cars, once the MOT is ticked as passed,
// and when a person has removed it for this same MOT date. Returns true if it changed the car.
function autoMotPrep(c) {
  if (!motSoon(c.mot) || (c.prep || []).includes('MOT') || c.motPrepOff === c.mot || c.archived === true) return false;
  const d = c.done || {};
  if (d.mech_motbook === true || d.ready_qc === true) return false;
  c.prep = PREP_ITEMS.filter((x) => (c.prep || []).concat('MOT').includes(x));
  c.motPrepAuto = c.mot;
  return true;
}
function motPrepPass() {
  let n = 0;
  for (const r of q.allCars.all()) {
    const c = JSON.parse(r.data);
    if (autoMotPrep(c)) { q.updateCar.run(JSON.stringify(c), new Date().toISOString(), 'MOT due', r.id); n++; }
  }
  if (n) { bump(); console.log('MOT due: added MOT to Prep requested on ' + n + ' car(s)'); }
}

// Records when a car entered each stage, who ticked each box and how often it was sent back. Used for reports.
function stampHistory(cur, next, user) {
  const now = new Date().toISOString();
  if (next.stage !== cur.stage) {
    const hist = cur.history && cur.history.length ? cur.history.slice() : [{ s: cur.stage, at: null }];
    hist.push({ s: next.stage, at: now, by: user.display });
    next.history = hist.slice(-40);
    if (STAGE_KEYS.indexOf(next.stage) < STAGE_KEYS.indexOf(cur.stage)) next.sentBack = (cur.sentBack || 0) + 1;
  }
  if (next.done !== cur.done) {
    const log = Object.assign({}, cur.tickLog);
    const before = cur.done || {};
    for (const k of Object.keys(next.done || {})) {
      if (next.done[k] && !before[k]) log[k] = { at: now, by: user.display };
      else if (!next.done[k]) delete log[k];
    }
    next.tickLog = log;
  }
}

/* ---------- uploaded 145 point checks ---------- */
const MAX_UPLOAD = 15 * 1024 * 1024;
const MAX_FILES_PER_CAR = 10;
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > limit) { failed = true; reject(new HttpError(413, 'That file is over 15 MB. Use a smaller file or a lower photo quality.')); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}
// Decide the file type from its first bytes, never from what the browser says.
function sniffType(b) {
  if (b.length < 12) return null;
  if (b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|hevc|heim|mif1|msf1)/.test(b.subarray(8, 12).toString('latin1'))) return 'image/heic';
  return null;
}
function cleanFileName(raw, type) {
  let n = '';
  try { n = decodeURIComponent(String(raw || '')); } catch (e) { n = String(raw || ''); }
  n = n.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"<>:|?*]/g, '').trim().slice(0, 120);
  const ext = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic' }[type];
  return n || ('145-point-check' + ext);
}
const CHECK_KEY = 'mech_pt145';

function readInbound(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > 524288) { failed = true; reject(new HttpError(413, 'Request too large.')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (failed) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      const type = String(req.headers['content-type'] || '');
      try {
        if (type.includes('application/json')) return resolve(JSON.parse(raw) || {});
        if (type.includes('application/x-www-form-urlencoded')) return resolve(Object.fromEntries(new URLSearchParams(raw)));
        return resolve({ text: raw });
      } catch (e) { reject(new HttpError(400, 'Invalid request.')); }
    });
    req.on('error', reject);
  });
}
function inboundAuthorised(req, url) {
  let given = url.searchParams.get('key') || String(req.headers['x-inbound-key'] || '');
  const basic = String(req.headers.authorization || '').match(/^Basic\s+(.+)$/i);
  if (!given && basic) given = Buffer.from(basic[1], 'base64').toString('utf8').split(':').slice(1).join(':');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(INBOUND_SECRET).digest();
  return crypto.timingSafeEqual(a, b);
}

/* ---------- API ---------- */
async function handleApi(req, res, url) {
  const method = req.method;
  const p = url.pathname;
  if (method !== 'GET' && method !== 'HEAD') checkOrigin(req);

  // Email in: an inbound-email service posts the message here and the cars in it are added at Inbound.
  if (method === 'POST' && p === '/api/inbound') {
    if (!INBOUND_SECRET) throw new HttpError(404, 'Not found.');
    if (!inboundAuthorised(req, url)) throw new HttpError(401, 'Not allowed.');
    const b = await readInbound(req);
    const sender = inbound.emailSender(b);
    if (INBOUND_ALLOWED.length && !INBOUND_ALLOWED.includes(sender)) {
      console.log('inbound email ignored, sender not allowed:', sender || '(none)');
      return sendJson(res, 200, { created: [], skipped: [], ignored: 'sender not allowed' });
    }
    const found = inbound.parseCars(inbound.emailText(b)).slice(0, 100);
    const have = new Set(q.allCars.all().map((r) => inbound.normReg(JSON.parse(r.data).reg)));
    const created = [], skipped = [], createdIds = [];
    for (const f of found) {
      const key = inbound.normReg(f.reg);
      if (have.has(key)) { skipped.push(f.reg); continue; }
      have.add(key);
      const car = { reg: f.reg, make: f.make, model: f.model, tag: f.tag, prep: f.prep || [], mileage: f.mileage, mot: f.mot,
        notes: 'Added from email. Check the details are right.', stage: 'arrived', added: todayStr(), readyAt: '', done: {},
        history: [{ s: 'arrived', at: new Date().toISOString(), by: 'Email' }] };
      autoMotPrep(car);
      const newId = crypto.randomBytes(6).toString('hex');
      q.insertCar.run(newId, JSON.stringify(car), new Date().toISOString(), 'Email');
      created.push(f.reg); createdIds.push(newId);
    }
    if (created.length) bump();
    if (createdIds.length && lookupReady()) (async () => { for (const id of createdIds) { await refreshCar(id).catch(noteLookupError); await new Promise((ok) => setTimeout(ok, 400)); } })();
    console.log('inbound email from', sender || '(unknown)', '- added:', created.join(', ') || 'none', '- already in stock:', skipped.join(', ') || 'none');
    return sendJson(res, 200, { created, skipped });
  }

  // Administrators: download a full copy of the database (cars, logins, history and uploaded files).
  if (method === 'GET' && p === '/api/backup') {
    const u = requireAdmin(req);
    const d = new Date();
    const pad2 = (n) => String(n).padStart(2, '0');
    const stamp = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes());
    const tmp = path.join(os.tmpdir(), '145prepped-backup-' + crypto.randomBytes(6).toString('hex') + '.db');
    db.exec("VACUUM INTO '" + tmp.replace(/'/g, "''") + "'");
    const size = fs.statSync(tmp).size;
    console.log('backup downloaded by ' + u.display + ' (' + size + ' bytes)');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': size,
      'Content-Disposition': 'attachment; filename="145prepped-backup-' + stamp + '.db"',
      'Cache-Control': 'no-store',
    });
    const rs = fs.createReadStream(tmp);
    const done = () => fs.unlink(tmp, () => {});
    rs.on('close', done); rs.on('error', done);
    return rs.pipe(res);
  }

  if (method === 'GET' && p === '/api/session') {
    const u = currentUser(req);
    return sendJson(res, 200, { setup: q.countUsers.get().c === 0, user: u ? publicUser(u) : null, publicUrl: PUBLIC_URL || null, lookup: lookupReady() });
  }

  if (method === 'POST' && p === '/api/setup') {
    if (q.countUsers.get().c > 0) throw new HttpError(403, 'Setup is already complete.');
    const b = await readJson(req);
    const username = str(b.username).trim();
    const display = str(b.display).trim();
    const password = str(b.password);
    if (!/^[a-z0-9._-]{3,32}$/i.test(username)) throw new HttpError(400, 'Username must be 3 to 32 letters, numbers, dots, dashes or underscores.');
    if (!display || display.length > 60) throw new HttpError(400, 'Enter your full name.');
    if (password.length < 8 || password.length > 200) throw new HttpError(400, 'Password must be at least 8 characters.');
    const hash = await hashPassword(password);
    if (q.countUsers.get().c > 0) throw new HttpError(403, 'Setup is already complete.');
    const info = q.insertUser.run(username, display, deriveInitials(display), 'admin', hash, new Date().toISOString());
    const u = q.userById.get(Number(info.lastInsertRowid));
    setSession(req, res, u);
    return sendJson(res, 200, { user: publicUser(u) });
  }

  if (method === 'POST' && p === '/api/login') {
    const b = await readJson(req);
    const username = str(b.username).trim().slice(0, 64);
    const password = str(b.password).slice(0, 200);
    const key = limiterKey(req, username);
    if (isLocked(key)) throw new HttpError(429, 'Too many attempts. Wait 15 minutes and try again.');
    const row = username ? q.userByName.get(username) : null;
    const ok = row ? await verifyPassword(password, row.pass_hash) : (await verifyPassword(password, DUMMY_HASH), false);
    if (!ok || !row.active) {
      recordFail(key);
      throw new HttpError(401, 'Wrong username or password.');
    }
    failures.delete(key);
    setSession(req, res, row);
    return sendJson(res, 200, { user: publicUser(row) });
  }

  if (method === 'POST' && p === '/api/logout') {
    clearSession(req, res);
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && p === '/api/password') {
    const u = requireUser(req);
    const b = await readJson(req);
    const current = str(b.current).slice(0, 200);
    const next = str(b.next);
    if (next.length < 8 || next.length > 200) throw new HttpError(400, 'New password must be at least 8 characters.');
    if (!(await verifyPassword(current, u.pass_hash))) throw new HttpError(400, 'Your current password is not right.');
    const hash = await hashPassword(next);
    db.prepare('UPDATE users SET pass_hash = ?, ver = ver + 1 WHERE id = ?').run(hash, u.id);
    setSession(req, res, q.userById.get(u.id));
    return sendJson(res, 200, { ok: true });
  }

  /* ----- cars ----- */
  if (method === 'GET' && p === '/api/cars') {
    requireUser(req);
    if (url.searchParams.get('since') === String(rev)) return sendJson(res, 200, { rev, unchanged: true });
    return sendJson(res, 200, { rev, cars: q.allCars.all().map(carOut) });
  }

  if (method === 'POST' && p === '/api/cars') {
    const u = requireStaff(req);
    const b = await readJson(req);
    const car = { reg: '', make: '', model: '', tag: '', prep: [], mileage: null, mot: '', notes: '', stage: 'arrived', added: todayStr(), readyAt: '', done: {} };
    const filled = applyCarPatch(car, { reg: b.reg, make: b.make, model: b.model, tag: b.tag, colour: b.colour || '', mot: b.mot || '', prep: b.prep || [], mileage: b.mileage === undefined ? null : b.mileage }, u);
    if (!filled.reg || !filled.make || !filled.model) throw new HttpError(400, 'Registration, make and model are required.');
    filled.history = [{ s: 'arrived', at: new Date().toISOString(), by: u.display }];
    const id = crypto.randomBytes(6).toString('hex');
    const now = new Date().toISOString();
    q.insertCar.run(id, JSON.stringify(filled), now, u.display);
    bump();
    if (lookupReady()) refreshCar(id).catch(noteLookupError);
    return sendJson(res, 201, carOut(q.carById.get(id)));
  }

  const upMatch = p.match(/^\/api\/cars\/([a-f0-9]{12})\/checks$/);
  if (upMatch && method === 'POST') {
    const u = requireStaff(req);
    const carId = upMatch[1];
    if (!q.carById.get(carId)) throw new HttpError(404, 'That car no longer exists.');
    let buf = await readRaw(req, MAX_UPLOAD);
    const type = sniffType(buf);
    if (!type) throw new HttpError(400, 'Upload a PDF or a photo (JPEG, PNG, WebP or HEIC).');
    if (type === 'application/pdf') buf = await shrinkPdf(buf);
    // read the car only now, after the upload has arrived, so changes made meanwhile are not overwritten
    const row = q.carById.get(carId);
    if (!row) throw new HttpError(404, 'That car no longer exists.');
    const cur = JSON.parse(row.data);
    const list = cur.checks || [];
    if (list.length >= MAX_FILES_PER_CAR) throw new HttpError(400, 'This car already has ' + MAX_FILES_PER_CAR + ' files. Remove one first.');
    const fid = crypto.randomBytes(8).toString('hex');
    const now = new Date().toISOString();
    const name = cleanFileName(req.headers['x-filename'], type);
    const next = Object.assign({}, cur, {
      checks: list.concat([{ id: fid, name, type, size: buf.length, at: now, by: u.display }]),
      done: Object.assign({}, cur.done, { [CHECK_KEY]: true }),
    });
    stampHistory(cur, next, u);
    db.exec('BEGIN');
    try {
      q.insertFile.run(fid, carId, name, type, buf.length, buf, now, u.display);
      q.updateCar.run(JSON.stringify(next), now, u.display, carId);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    console.log('145 check uploaded for ' + (cur.reg || carId) + ' by ' + u.display + ' (' + name + ')');
    bump();
    return sendJson(res, 201, carOut(q.carById.get(carId)));
  }

  /* ---------- registration lookup (DVLA, and DVSA MOT history for the model) ---------- */
  if (method === 'GET' && p === '/api/lookup') {
    requireStaff(req);
    if (!lookupReady()) throw new HttpError(501, 'Registration lookup is not set up yet. An administrator needs to add the DVLA key in Render.');
    const reg = normRegKey(url.searchParams.get('reg'));
    if (reg.length < 2 || reg.length > 8) throw new HttpError(400, 'Enter a full registration.');
    const v = await lookupVehicle(reg);
    if (!v) throw new HttpError(404, 'No vehicle found for ' + reg + '. Check the registration.');
    return sendJson(res, 200, v);
  }

  // Check one car's MOT now (the button on the car), with the real reason if it fails.
  const lkMatch = p.match(/^\/api\/cars\/([a-f0-9]{12})\/lookup$/);
  if (lkMatch && method === 'POST') {
    requireStaff(req);
    if (!lookupReady()) {
      const want = ['MOT_CLIENT_ID', 'MOT_CLIENT_SECRET', 'MOT_API_KEY', 'MOT_TOKEN_URL'];
      const missing = want.filter((k) => !envGet(k));
      const near = Object.keys(process.env).filter((k) => /(^|[_\s-])(mot|dvla|dvsa)([_\s-]|$)/i.test(k) && !want.includes(k.trim().toUpperCase()) && k !== 'DVLA_API_KEY' && !/^(npm_|NODE_|PATH$)/i.test(k));
      throw new HttpError(501, 'The site cannot see the MOT keys. Missing in Render: ' + missing.join(', ') + '.'
        + (near.length ? ' Found these names instead, which may be spelled differently: ' + near.join(', ') + '.' : '')
        + ' (Or add DVLA_API_KEY if you have the single DVLA key.) Save in Render, then let it redeploy.');
    }
    const row = q.carById.get(lkMatch[1]);
    if (!row) throw new HttpError(404, 'That car no longer exists.');
    let r;
    try { r = await refreshCar(lkMatch[1]); } catch (e) { noteLookupError(e); throw new HttpError(502, String(e.message || e)); }
    if (r === 'missing') throw new HttpError(404, 'No MOT record found for ' + normRegKey(JSON.parse(row.data).reg) + '. Check the registration.');
    const h = q.motHistGet.get(lkMatch[1]);
    return sendJson(res, 200, { car: carOut(q.carById.get(lkMatch[1])), history: h ? Object.assign(JSON.parse(h.data), { checkedAt: h.checked_at }) : null });
  }
  // The car's full MOT history, as saved at the last check (read when the car is opened).
  const mhMatch = p.match(/^\/api\/cars\/([a-f0-9]{12})\/mot$/);
  if (mhMatch && method === 'GET') {
    requireUser(req);
    const h = q.motHistGet.get(mhMatch[1]);
    return sendJson(res, 200, { history: h ? Object.assign(JSON.parse(h.data), { checkedAt: h.checked_at }) : null });
  }

  /* ---------- daily prep snapshot email (administrators) ---------- */
  if (p === '/api/digest' && method === 'GET') {
    requireAdmin(req);
    const d = buildDigest();
    return sendJson(res, 200, { settings: digestSettings(), ready: mailReady(), from: MAIL.from || null,
      missing: ['POSTMARK_SERVER_TOKEN', 'MAIL_FROM'].filter((k) => !envGet(k)), lastSentDay: metaGet('digest_last'),
      status: digestStatus, subject: d.subject, counts: d.counts });
  }
  if (p === '/api/digest' && method === 'PUT') {
    requireAdmin(req);
    const b = await readJson(req) || {};
    const to = [...new Set(String(Array.isArray(b.to) ? b.to.join(',') : b.to || '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
    const bad = to.filter((x) => !EMAIL_RE.test(x) || x.length > 120);
    if (bad.length) throw new HttpError(400, 'Not a valid email address: ' + bad.join(', '));
    if (to.length > 30) throw new HttpError(400, 'Up to 30 people can get the email.');
    const time = String(b.time || '');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new HttpError(400, 'Choose a time such as 07:30.');
    const days = [...new Set((Array.isArray(b.days) ? b.days : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
    if (b.enabled && !days.length) throw new HttpError(400, 'Choose at least one day.');
    if (b.enabled && !to.length) throw new HttpError(400, 'Add at least one email address.');
    const st = { enabled: !!b.enabled, to, time, days };
    metaSet('digest', JSON.stringify(st));
    return sendJson(res, 200, { settings: st });
  }
  if (p === '/api/digest/test' && method === 'POST') {
    const u = requireAdmin(req);
    const b = await readJson(req) || {};
    const to = String(b.to || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean).slice(0, 30);
    if (!to.length || to.some((x) => !EMAIL_RE.test(x))) throw new HttpError(400, 'Enter the email address(es) to send the test to.');
    try { await sendMail(to, buildDigest()); } catch (e) {
      Object.assign(digestStatus, { lastError: String(e.message || e).slice(0, 300), lastErrorAt: new Date().toISOString() });
      throw new HttpError(502, String(e.message || e));
    }
    console.log('test prep snapshot sent by ' + u.display + ' to ' + to.length + ' address(es)');
    return sendJson(res, 200, { sent: to.length });
  }
  if (p === '/api/digest/preview' && method === 'GET') {
    requireAdmin(req);
    const html = buildDigest().html;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'" });
    return res.end(html);
  }

  /* ---------- cosmetic price list ---------- */
  // Staff and administrators see prices; technicians and advisors see the repairs and hours only.
  if (method === 'GET' && p === '/api/costs') {
    const u = requireUser(req);
    const showCost = u.role === 'admin' || u.role === 'staff';
    return sendJson(res, 200, { showCost, items: q.costItems.all().map((i) => (showCost ? i : { id: i.id, name: i.name, hours: i.hours, sort: i.sort })) });
  }
  if (method === 'PUT' && p === '/api/costs') {
    const u = requireAdmin(req);
    const b = await readJson(req);
    if (!b || !Array.isArray(b.items) || b.items.length > 200) throw new HttpError(400, 'Invalid price list.');
    const clean = b.items.map((i, n) => {
      const name = str(i && i.name).trim().slice(0, 60), hours = Number(i && i.hours), cost = Number(i && i.cost);
      if (!name) throw new HttpError(400, 'Every repair needs a name (line ' + (n + 1) + ').');
      if (!Number.isFinite(hours) || hours < 0 || hours > 100) throw new HttpError(400, 'Hours on line ' + (n + 1) + ' must be 0 to 100.');
      if (!Number.isFinite(cost) || cost < 0 || cost > 100000) throw new HttpError(400, 'Cost on line ' + (n + 1) + ' must be a number of pounds.');
      return { id: Number.isInteger(i.id) ? i.id : null, name, hours: Math.round(hours * 100) / 100, cost: Math.round(cost * 100) / 100, sort: n };
    });
    db.exec('BEGIN');
    try {
      const keep = new Set();
      for (const i of clean) {
        if (i.id && db.prepare('SELECT id FROM cost_items WHERE id = ?').get(i.id)) {
          db.prepare('UPDATE cost_items SET name = ?, hours = ?, cost = ?, sort = ?, active = 1 WHERE id = ?').run(i.name, i.hours, i.cost, i.sort, i.id);
          keep.add(i.id);
        } else {
          keep.add(Number(db.prepare('INSERT INTO cost_items (name, hours, cost, sort) VALUES (?, ?, ?, ?)').run(i.name, i.hours, i.cost, i.sort).lastInsertRowid));
        }
      }
      db.prepare('SELECT id FROM cost_items WHERE active = 1').all().forEach((r) => { if (!keep.has(r.id)) db.prepare('UPDATE cost_items SET active = 0 WHERE id = ?').run(r.id); });
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    console.log('cosmetic price list updated by ' + u.display + ' (' + clean.length + ' items)');
    bump();
    return sendJson(res, 200, { showCost: true, items: q.costItems.all() });
  }

  /* ---------- data health (administrators) ---------- */
  if (method === 'GET' && p === '/api/health') {
    requireAdmin(req);
    return sendJson(res, 200, healthReport());
  }
  if (method === 'POST' && p === '/api/health/reattach') {
    const u = requireAdmin(req);
    const n = reattachOrphans(u);
    if (n) bump();
    return sendJson(res, 200, { reattached: n, health: healthReport() });
  }
  const restoreMatch = p.match(/^\/api\/files\/([a-f0-9]{16})\/restore$/);
  if (restoreMatch && method === 'POST') {
    const u = requireAdmin(req);
    const f = q.fileById.get(restoreMatch[1]);
    if (!f) throw new HttpError(404, 'That file is no longer in the recycle bin.');
    if (!q.carById.get(f.car_id)) throw new HttpError(400, 'The car this check belonged to has been deleted, so it cannot be put back.');
    q.unbinFile.run(f.id);
    attachFile(f, u);
    console.log('145 check restored from recycle bin: ' + f.name + ' by ' + u.display);
    bump();
    return sendJson(res, 200, { ok: true, health: healthReport() });
  }
  if (method === 'POST' && p === '/api/health/cloud') {
    requireAdmin(req);
    try { await cloudBackup('manual'); } catch (e) { throw new HttpError(502, String(e.message || e)); }
    return sendJson(res, 200, { health: healthReport() });
  }
  if (method === 'POST' && p === '/api/health/recover') {
    const u = requireAdmin(req);
    const result = await recoverFromBackup(req, u);
    if (result.recovered.length) bump();
    return sendJson(res, 200, Object.assign(result, { health: healthReport() }));
  }

  const fileMatch = p.match(/^\/api\/files\/([a-f0-9]{16})$/);
  if (fileMatch && method === 'GET') {
    const viewer = requireUser(req);
    const f = q.fileById.get(fileMatch[1]);
    if (!f || (f.deleted_at && viewer.role !== 'admin')) throw new HttpError(404, 'That file no longer exists.');
    const ascii = f.name.replace(/[^A-Za-z0-9._ -]/g, '_');
    res.writeHead(200, {
      'Content-Type': f.type,
      'Content-Length': f.size,
      'Content-Disposition': (f.type === 'image/heic' ? 'attachment' : 'inline') + '; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(f.name),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
    });
    return res.end(Buffer.from(f.data));
  }
  if (fileMatch && method === 'DELETE') {
    const u = requireStaff(req);
    const f = q.fileById.get(fileMatch[1]);
    if (!f || f.deleted_at) throw new HttpError(404, 'That file no longer exists.');
    const row = q.carById.get(f.car_id);
    const now = new Date().toISOString();
    if (row) {
      const cur = JSON.parse(row.data);
      const left = (cur.checks || []).filter((x) => x.id !== f.id);
      const next = Object.assign({}, cur, { checks: left });
      if (!left.length) next.done = Object.assign({}, cur.done, { [CHECK_KEY]: false });
      stampHistory(cur, next, u);
      q.updateCar.run(JSON.stringify(next), now, u.display, row.id);
    }
    q.binFile.run(now, u.display, f.id);
    console.log('145 check removed (kept in recycle bin 30 days): ' + f.name + ' by ' + u.display);
    bump();
    return sendJson(res, 200, row ? carOut(q.carById.get(row.id)) : { ok: true });
  }

  const carMatch = p.match(/^\/api\/cars\/([a-f0-9]{12})$/);
  if (carMatch) {
    const id = carMatch[1];
    if (method === 'PATCH') {
      const u = requireUser(req);
      if (u.role === 'advisor') throw new HttpError(403, 'Advisors can view progress but not change it.');
      let b = await readJson(req);
      // read the car only after the change has arrived, so nothing saved meanwhile (like a 145 check) is overwritten
      const row = q.carById.get(id);
      if (!row) throw new HttpError(404, 'That car no longer exists.');
      const cur = JSON.parse(row.data);
      const sp = SPECIALIST[u.role];
      if (sp) {
        // keep only this login's own job; the stage is worked out here from the ticks
        const only = {};
        const d = b && b.done && typeof b.done === 'object' ? b.done : {};
        const doneKeys = Object.keys(d).filter((k) => sp.done.includes(k));
        const fieldKeys = Object.keys(b || {}).filter((k) => sp.fields.includes(k));
        if (!doneKeys.length && !fieldKeys.length) throw new HttpError(403, 'Your login can only update ' + sp.name.toLowerCase() + '.');
        if (doneKeys.length) {
          only.done = {}; doneKeys.forEach((k) => { only.done[k] = d[k]; });
          only.stage = stageFromDone(Object.assign({}, cur.done, only.done));
        }
        fieldKeys.forEach((k) => { only[k] = b[k]; });
        b = only;
      }
      const next = applyCarPatch(cur, b, u);
      q.updateCar.run(JSON.stringify(next), new Date().toISOString(), u.display, id);
      bump();
      return sendJson(res, 200, carOut(q.carById.get(id)));
    }
    if (method === 'DELETE') {
      const adm = requireAdmin(req);
      const gone = q.carById.get(id);
      q.binFilesForCar.run(new Date().toISOString(), adm.display, id);
      q.deleteCar.run(id);
      q.motHistDel.run(id);
      console.log('car deleted: ' + (gone ? JSON.parse(gone.data).reg : id) + ' by ' + adm.display + ' (its 145 checks are in the recycle bin for 30 days)');
      bump();
      return sendJson(res, 200, { ok: true });
    }
  }

  /* ----- users (administrators only) ----- */
  if (method === 'GET' && p === '/api/users') {
    requireAdmin(req);
    return sendJson(res, 200, { users: q.allUsers.all().map(r => Object.assign({}, r, { active: !!r.active })) });
  }

  if (method === 'POST' && p === '/api/users') {
    requireAdmin(req);
    const b = await readJson(req);
    const username = str(b.username).trim();
    const display = str(b.display).trim();
    const password = str(b.password);
    const role = ROLES.includes(b.role) ? b.role : 'staff';
    if (!/^[a-z0-9._-]{3,32}$/i.test(username)) throw new HttpError(400, 'Username must be 3 to 32 letters, numbers, dots, dashes or underscores.');
    if (!display || display.length > 60) throw new HttpError(400, 'Enter the person\'s full name.');
    if (password.length < 8 || password.length > 200) throw new HttpError(400, 'Password must be at least 8 characters.');
    if (q.userByName.get(username)) throw new HttpError(409, 'That username is already taken.');
    const initials = cleanInitials(b.initials) || deriveInitials(display);
    const hash = await hashPassword(password);
    try {
      q.insertUser.run(username, display, initials, role, hash, new Date().toISOString());
    } catch (e) {
      throw new HttpError(409, 'That username is already taken.');
    }
    return sendJson(res, 201, { ok: true });
  }

  const userMatch = p.match(/^\/api\/users\/(\d+)$/);
  if (userMatch && method === 'DELETE') {
    const admin = requireAdmin(req);
    const target = q.userById.get(Number(userMatch[1]));
    if (!target) throw new HttpError(404, 'User not found.');
    if (target.id === admin.id) throw new HttpError(400, 'You cannot delete your own login.');
    if (target.active) throw new HttpError(400, 'Deactivate this login first, then delete it.');
    db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
    return sendJson(res, 200, { ok: true });
  }
  if (userMatch && method === 'PATCH') {
    const admin = requireAdmin(req);
    const target = q.userById.get(Number(userMatch[1]));
    if (!target) throw new HttpError(404, 'User not found.');
    const b = await readJson(req);
    let role = target.role;
    let active = !!target.active;
    let display = target.display;
    let initials = target.initials;
    if ('role' in b) {
      if (!ROLES.includes(b.role)) throw new HttpError(400, 'Unknown role.');
      role = b.role;
    }
    if ('active' in b) active = !!b.active;
    if ('display' in b) {
      display = str(b.display).trim();
      if (!display || display.length > 60) throw new HttpError(400, 'Enter a full name.');
    }
    if ('initials' in b) {
      initials = cleanInitials(b.initials);
      if (!initials) throw new HttpError(400, 'Enter initials (letters or numbers, up to 4).');
    }
    if (target.id === admin.id && (!active || role !== 'admin')) {
      throw new HttpError(400, 'You cannot remove your own administrator access.');
    }
    if (target.role === 'admin' && (role !== 'admin' || !active) && q.adminCountExcept.get(target.id).c === 0) {
      throw new HttpError(400, 'There must be at least one active administrator.');
    }
    let hash = target.pass_hash;
    let ver = target.ver;
    if ('password' in b) {
      const pw = str(b.password);
      if (pw.length < 8 || pw.length > 200) throw new HttpError(400, 'Password must be at least 8 characters.');
      hash = await hashPassword(pw);
      ver += 1;
    }
    if (!active && target.active) ver += 1; // signs them out everywhere
    db.prepare('UPDATE users SET display = ?, initials = ?, role = ?, active = ?, pass_hash = ?, ver = ? WHERE id = ?')
      .run(display, initials, role, active ? 1 : 0, hash, ver, target.id);
    return sendJson(res, 200, { ok: true });
  }

  throw new HttpError(404, 'Not found.');
}




/* ---------- registration lookup ---------- */
// DVLA Vehicle Enquiry Service: make, colour, year, fuel and MOT expiry (no model). Tax is not used.
// DVSA MOT History API (optional): model, and the latest MOT result. Keys come from Render's Environment settings.
// Read a setting forgivingly: stray spaces or lower case in the name or value in Render are ignored.
const envGet = (name) => {
  if (process.env[name] != null && String(process.env[name]).trim()) return String(process.env[name]).trim();
  const k = Object.keys(process.env).find((x) => x.trim().toUpperCase().replace(/[\s-]+/g, '_') === name);
  return k ? String(process.env[k]).trim() : '';
};
const DVLA_KEY = envGet('DVLA_API_KEY');
const DVLA_URL = process.env.DVLA_API_URL || 'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles';
const MOT = {
  clientId: envGet('MOT_CLIENT_ID'), secret: envGet('MOT_CLIENT_SECRET'), apiKey: envGet('MOT_API_KEY'),
  tokenUrl: envGet('MOT_TOKEN_URL'), scope: envGet('MOT_SCOPE') || 'https://tapi.dvsa.gov.uk/.default',
  base: envGet('MOT_API_URL') || 'https://history.mot.api.gov.uk/v1/trade/vehicles/registration/',
};
const motReady = () => !!(MOT.clientId && MOT.secret && MOT.apiKey && MOT.tokenUrl);
const lookupReady = () => !!DVLA_KEY || motReady();
const lookupStats = { lastRun: null, checked: 0, updated: 0, failed: 0, lastError: '', lastErrorAt: null, lastOk: null };
const noteLookupError = (e) => { lookupStats.lastError = String((e && e.message) || e).slice(0, 300); lookupStats.lastErrorAt = new Date().toISOString(); };
let motToken = null;
// fetch() only says "fetch failed" when it cannot reach a site; say which address, and why, so the setting can be fixed.
async function reach(what, setting, url, opts) {
  let host = '';
  try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) throw new Error('x'); host = u.host; } catch (e) {
    throw new Error(setting + ' is not a web address. It should start with https:// (it starts "' + String(url).slice(0, 12) + '…").');
  }
  try { return await fetchWithChain(url, opts); } catch (e) {
    const c = (e && e.cause) || (e && e.code ? e : {}), code = c.code || c.name || (e && e.name) || '';
    const why = code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'the address ' + host + ' does not exist, so check ' + setting + ' for a typo'
      : code === 'ECONNREFUSED' ? host + ' refused the connection'
      : code === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT' ? host + ' did not answer in time. Try again in a minute'
      : /CERT|SSL|TLS|SELF_SIGNED|EXPIRED/i.test(code) ? 'a security problem with ' + host + ': ' + code + (c.message && c.message.startsWith('tried ') ? '. ' + c.message : '')
      : (c.message || code || (e && e.message) || 'unknown error');
    throw new Error(what + ' could not be reached (' + why + ').');
  }
}
async function getMotToken() {
  if (motToken && motToken.exp > Date.now() + 60000) return motToken.value;
  const r = await reach('The MOT sign-in address', 'MOT_TOKEN_URL', MOT.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: MOT.clientId, client_secret: MOT.secret, scope: MOT.scope }), signal: AbortSignal.timeout(15000) });
  if (!r.ok) {
    let why = '';
    try { const j = await r.json(); why = String(j.error_description || j.error || '').split(/\r?\n/)[0].slice(0, 200); } catch (e) { /* not JSON */ }
    throw new Error('MOT history sign-in failed (' + r.status + ')' + (why ? ': ' + why : '') + '. Check MOT_CLIENT_ID, MOT_CLIENT_SECRET, MOT_TOKEN_URL and MOT_SCOPE.');
  }
  const j = await r.json();
  motToken = { value: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return motToken.value;
}
const titleCase = (t) => String(t || '').toLowerCase().replace(/\b[a-z]/g, (m) => m.toUpperCase()).replace(/\bBmw\b/, 'BMW').replace(/\bMg\b/, 'MG');
async function lookupVehicle(reg) {
  const out = { reg, make: '', model: '', colour: '', mot: '', motStatus: '', year: null, fuel: '', lastMot: null, checkedAt: new Date().toISOString(), source: [] };
  let found = false;
  if (DVLA_KEY) {
    const r = await reach('The DVLA service', 'DVLA_API_URL', DVLA_URL, { method: 'POST', headers: { 'x-api-key': DVLA_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ registrationNumber: reg }), signal: AbortSignal.timeout(15000) });
    if (r.status === 200) {
      const v = await r.json(); found = true; out.source.push('DVLA');
      out.make = titleCase(v.make); out.colour = titleCase(v.colour); out.year = v.yearOfManufacture || null; out.fuel = titleCase(v.fuelType);
      out.motStatus = v.motStatus || ''; out.mot = /^\d{4}-\d{2}-\d{2}$/.test(v.motExpiryDate || '') ? v.motExpiryDate : '';
    } else if (r.status !== 404 && r.status !== 400) throw new Error('DVLA lookup failed (' + r.status + ')');
  }
  if (motReady()) {
    try {
      const r = await reach('The MOT history service', 'MOT_API_URL', MOT.base + encodeURIComponent(reg), { headers: { Authorization: 'Bearer ' + await getMotToken(), 'X-API-Key': MOT.apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (r.status === 200) {
        const v = await r.json(); found = true; out.source.push('DVSA');
        out.model = out.model || titleCase(v.model);
        out.make = out.make || titleCase(v.make);
        out.colour = out.colour || titleCase(v.primaryColour);
        const tests = Array.isArray(v.motTests) ? v.motTests.slice().sort((a, b) => String(b.completedDate).localeCompare(String(a.completedDate))) : [];
        out.history = {
          firstUsed: String(v.firstUsedDate || v.registrationDate || '').slice(0, 10), dueDate: String(v.motTestDueDate || '').slice(0, 10),
          tests: tests.slice(0, 40).map((x) => ({
            date: String(x.completedDate || '').slice(0, 10), result: String(x.testResult || ''), expiry: String(x.expiryDate || '').slice(0, 10),
            mileage: x.odometerValue && /^\d+$/.test(String(x.odometerValue)) ? Number(x.odometerValue) : null, unit: x.odometerUnit === 'MI' || x.odometerUnit === 'mi' ? 'mi' : (x.odometerUnit ? String(x.odometerUnit).toLowerCase() : 'mi'),
            number: String(x.motTestNumber || ''),
            defects: (Array.isArray(x.defects) ? x.defects : []).slice(0, 60).map((d) => ({ type: String(d.type || '').toUpperCase(), text: String(d.text || '').slice(0, 300), dangerous: d.dangerous === true })),
          })),
        };
        const t = tests[0];
        if (t) {
          out.lastMot = { date: String(t.completedDate || '').slice(0, 10), result: t.testResult || '', mileage: t.odometerValue ? Number(t.odometerValue) : null,
            advisories: (t.defects || []).filter((d) => /ADVISORY|MINOR/i.test(d.type || '')).length };
          const exp = String(t.expiryDate || '').slice(0, 10);
          if (/^\d{4}-\d{2}-\d{2}$/.test(exp) && exp > out.mot) out.mot = exp;
        } else if (/^\d{4}-\d{2}-\d{2}/.test(v.motTestDueDate || '') && !out.mot) out.mot = String(v.motTestDueDate).slice(0, 10);
      } else if (r.status !== 404) {
        let why = '';
        try { why = (await r.text()).replace(/\s+/g, ' ').slice(0, 160); } catch (e) { /* no body */ }
        if (r.status === 401 || r.status === 403) motToken = null;
        throw new Error('MOT history lookup failed (' + r.status + ')' + (why ? ': ' + why : '') + (r.status === 401 || r.status === 403 ? '. Check MOT_API_KEY (and that the keys are for the MOT history API).' : ''));
      }
    } catch (e) { noteLookupError(e); if (!out.source.length) throw e; }
  }
  if (found) lookupStats.lastOk = out.checkedAt;
  return found ? out : null;
}
// Re-check one car and save what changed: the MOT expiry always follows the official record; make, model and colour are only filled in when empty.
async function refreshCar(id) {
  const first = q.carById.get(id);
  if (!first) return false;
  const reg = normRegKey(JSON.parse(first.data).reg);
  if (reg.length < 2) return false;
  const v = await lookupVehicle(reg);
  const row = q.carById.get(id);              // read again after the lookup so nothing saved meanwhile is overwritten
  if (!row) return false;
  if (!v) return 'missing';
  const cur = JSON.parse(row.data);
  const next = Object.assign({}, cur, { dvla: { mot: v.mot, lastMot: v.lastMot, checkedAt: v.checkedAt, tests: v.history ? v.history.tests.length : ((cur.dvla || {}).tests || 0) } });
  if (v.history) q.motHistPut.run(id, JSON.stringify(v.history), v.checkedAt);
  let changed = false;
  if (v.mot && v.mot !== cur.mot) { next.mot = v.mot; changed = true; }
  if (autoMotPrep(next)) changed = true;
  if (!cur.make && v.make) { next.make = v.make; changed = true; }
  if (!cur.model && v.model) { next.model = v.model; changed = true; }
  if (!cur.colour && v.colour) { next.colour = v.colour; changed = true; }
  q.updateCar.run(JSON.stringify(next), new Date().toISOString(), changed ? 'DVLA check' : row.updated_by, id);
  bump();
  return changed;
}
// Every morning (and shortly after each start), check every car still in prep.
let lookupRunning = false;
async function dailyLookup() {
  if (!lookupReady() || lookupRunning) return;
  lookupRunning = true;
  const s = { checked: 0, updated: 0, failed: 0 };
  try {
    for (const r of q.allCars.all()) {
      const c = JSON.parse(r.data);
      const finished = (c.done || {}).ready_qc === true && c.stage === 'ready';
      if (finished || c.archived === true) continue;
      try { if ((await refreshCar(r.id)) === true) s.updated++; s.checked++; } catch (e) { s.failed++; noteLookupError(e); }
      await new Promise((ok) => setTimeout(ok, 400));
    }
  } finally {
    lookupRunning = false;
    Object.assign(lookupStats, s, { lastRun: new Date().toISOString() });
    console.log('daily DVLA/MOT check: ' + s.checked + ' cars checked, ' + s.updated + ' updated, ' + s.failed + ' failed');
  }
}
function scheduleLookup() {
  const now = new Date(), next = new Date(now);
  next.setUTCHours(6, 0, 0, 0);                // about 6 or 7am UK time
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  setTimeout(() => { dailyLookup(); setInterval(dailyLookup, 24 * 3600 * 1000).unref(); }, next - now).unref();
  setTimeout(dailyLookup, Number(process.env.LOOKUP_FIRST_RUN_MS) || 5 * 60 * 1000).unref();
}
scheduleLookup();

/* ---------- daily prep snapshot email ---------- */
// Sent through Postmark (the same account as the email feed). Needs POSTMARK_SERVER_TOKEN and MAIL_FROM (a sender
// address or domain confirmed in Postmark). Who gets it, what time and which days are set by an administrator.
const MAIL = { token: envGet('POSTMARK_SERVER_TOKEN'), from: envGet('MAIL_FROM') };
const mailReady = () => !!(MAIL.token && MAIL.from);
const DIGEST_DEFAULT = { enabled: false, to: [], time: '07:30', days: [1, 2, 3, 4, 5] };
const metaGet = (k) => { const r = db.prepare('SELECT v FROM meta WHERE k = ?').get(k); return r ? r.v : null; };
const metaSet = (k, v) => db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
function digestSettings() { try { return Object.assign({}, DIGEST_DEFAULT, JSON.parse(metaGet('digest') || '{}')); } catch (e) { return Object.assign({}, DIGEST_DEFAULT); } }
const digestStatus = { lastSent: null, lastTo: 0, lastError: '', lastErrorAt: null };
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
function buildDigest() {
  const cars = q.allCars.all().map((r) => JSON.parse(r.data));
  return digest.build(cars, todayStr(), { url: PUBLIC_URL || '', centre: envGet('CENTRE_NAME') });
}
async function sendMail(to, msg) {
  if (!mailReady()) throw new Error('Sending email is not set up. Add POSTMARK_SERVER_TOKEN and MAIL_FROM in Render.');
  const r = await reach('Postmark', 'POSTMARK_SERVER_TOKEN', envGet('POSTMARK_API_URL') || 'https://api.postmarkapp.com/email', {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': MAIL.token },
    body: JSON.stringify({ From: MAIL.from, To: to.join(', '), Subject: msg.subject, HtmlBody: msg.html, TextBody: msg.text, MessageStream: 'outbound', Tag: 'daily-snapshot' }),
    signal: AbortSignal.timeout(20000) });
  let j = {}; try { j = await r.json(); } catch (e) { /* no body */ }
  if (!r.ok || (j.ErrorCode && j.ErrorCode !== 0)) {
    const m = String(j.Message || ('Postmark answered ' + r.status));
    const hint = j.ErrorCode === 10 ? ' Check POSTMARK_SERVER_TOKEN (use the Server API token).'
      : j.ErrorCode === 400 || /sender signature/i.test(m) ? ' MAIL_FROM must be an address or domain confirmed under Sender Signatures in Postmark.'
      : j.ErrorCode === 412 ? ' Your Postmark account is still pending approval, so it can only send to addresses on your own domain.' : '';
    throw new Error('Postmark: ' + m + hint);
  }
}
function londonNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ_NAME, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday), time: parts.hour + ':' + parts.minute };
}
let digestBusy = false, digestTries = 0, digestTryDay = '';
async function digestTick() {
  const st = digestSettings();
  if (!st.enabled || !st.to.length || !mailReady() || digestBusy) return;
  const now = londonNow(), today = todayStr();
  if (!st.days.includes(now.day) || now.time < st.time || metaGet('digest_last') === today) return;
  // Don't send a late one: if the site was off at the set time, wait until tomorrow rather than send at teatime.
  const [h, m] = st.time.split(':').map(Number), [nh, nm] = now.time.split(':').map(Number);
  if ((nh * 60 + nm) - (h * 60 + m) > 180) return;
  if (digestTryDay !== today) { digestTryDay = today; digestTries = 0; }
  if (digestTries >= 3) return;
  digestBusy = true; digestTries++;
  try {
    await sendMail(st.to, buildDigest());
    metaSet('digest_last', today);
    Object.assign(digestStatus, { lastSent: new Date().toISOString(), lastTo: st.to.length });
    console.log('daily prep snapshot sent to ' + st.to.length + ' address(es)');
  } catch (e) {
    Object.assign(digestStatus, { lastError: String(e.message || e).slice(0, 300), lastErrorAt: new Date().toISOString() });
    console.log('daily prep snapshot failed: ' + digestStatus.lastError);
  } finally { digestBusy = false; }
}
setInterval(() => { digestTick().catch(() => {}); }, 60 * 1000).unref();

/* ---------- smaller PDFs ---------- */
// Scanned 145 checks are mostly big images. Ghostscript re-saves them at 150 dpi (still easy to read and print),
// which usually cuts the size by well over half. If Ghostscript is missing, fails, or the result is not smaller,
// the original file is kept exactly as uploaded.
const GS = process.env.GHOSTSCRIPT || 'gs';
let gsVersion = null;
try { gsVersion = String(execFileSync(GS, ['--version'], { timeout: 5000 })).trim(); } catch (e) { gsVersion = null; }
const pdfStats = { shrunk: 0, kept: 0, savedBytes: 0 };
function shrinkPdf(buf) {
  if (!gsVersion || buf.length < 150 * 1024) return Promise.resolve(buf);
  const base = path.join(os.tmpdir(), 'pdf-' + crypto.randomBytes(6).toString('hex'));
  const inp = base + '-in.pdf', out = base + '-out.pdf';
  const done = (b) => { fs.unlink(inp, () => {}); fs.unlink(out, () => {}); return b; };
  try { fs.writeFileSync(inp, buf); } catch (e) { return Promise.resolve(buf); }
  const args = ['-q', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.5', '-dPDFSETTINGS=/ebook',
    '-dDetectDuplicateImages=true', '-dCompressFonts=true', '-sOutputFile=' + out, inp];
  return new Promise((resolve) => {
    execFile(GS, args, { timeout: 60000 }, (err) => {
      let small = null;
      try { if (!err) small = fs.readFileSync(out); } catch (e) { small = null; }
      if (small && small.length >= 1024 && small.subarray(0, 5).toString('latin1') === '%PDF-' && small.length < buf.length * 0.9) {
        pdfStats.shrunk++; pdfStats.savedBytes += buf.length - small.length;
        console.log('PDF reduced from ' + Math.round(buf.length / 1024) + ' KB to ' + Math.round(small.length / 1024) + ' KB');
        resolve(done(small));
      } else {
        pdfStats.kept++;
        if (err) console.log('PDF kept at original size (could not shrink: ' + (err.killed ? 'took too long' : err.message.split('\n')[0]) + ')');
        resolve(done(buf));
      }
    });
  });
}
/* ---------- keeping 145 checks safe ---------- */
const normRegKey = (r) => String(r || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function allCarsParsed() { return q.allCars.all().map((r) => ({ id: r.id, data: JSON.parse(r.data) })); }
// Put a stored file back on its car's 145 check list (and tick the check).
function attachFile(f, u) {
  const row = q.carById.get(f.car_id);
  if (!row) return false;
  const cur = JSON.parse(row.data);
  const list = cur.checks || [];
  if (list.some((x) => x.id === f.id)) return false;
  const next = Object.assign({}, cur, {
    checks: list.concat([{ id: f.id, name: f.name, type: f.type, size: f.size, at: f.created_at, by: f.created_by }])
      .sort((a, b) => (a.at < b.at ? -1 : 1)),
    done: Object.assign({}, cur.done, { [CHECK_KEY]: true }),
  });
  stampHistory(cur, next, u);
  q.updateCar.run(JSON.stringify(next), new Date().toISOString(), u.display, f.car_id);
  return true;
}
function orphanFiles() {
  const cars = allCarsParsed();
  const linked = new Set();
  const regOf = {};
  cars.forEach((c) => { regOf[c.id] = c.data.reg; (c.data.checks || []).forEach((x) => linked.add(x.id)); });
  return q.fileMeta.all().filter((f) => !f.deleted_at && !linked.has(f.id))
    .map((f) => ({ id: f.id, name: f.name, size: f.size, at: f.created_at, by: f.created_by, reg: regOf[f.car_id] || null, carExists: !!regOf[f.car_id] }));
}
function reattachOrphans(u) {
  let n = 0;
  orphanFiles().forEach((o) => { if (o.carExists && attachFile(q.fileById.get(o.id), u)) n++; });
  if (n) console.log(n + ' unattached 145 check(s) reattached by ' + u.display);
  return n;
}
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR).filter((f) => /^auto-.*\.db$/.test(f))
      .map((f) => { const st = fs.statSync(path.join(BACKUP_DIR, f)); return { name: f, size: st.size, at: st.mtime.toISOString() }; })
      .sort((a, b) => (a.at < b.at ? 1 : -1));
  } catch (e) { return []; }
}
function diskSpace() {
  try { const st = fs.statfsSync(DATA_DIR); return { free: st.bavail * st.bsize, total: st.blocks * st.bsize }; } catch (e) { return null; }
}
// Copies the whole database into /data/backups. Keeps the newest 14, and fewer if the disk is getting full.
function autoBackup(reason) {
  try {
    if (!q.allCars.all().length) return null;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
    const name = 'auto-' + d.getUTCFullYear() + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()) + '-' + p2(d.getUTCHours()) + p2(d.getUTCMinutes()) + p2(d.getUTCSeconds()) + '-' + reason + '.db';
    db.exec("VACUUM INTO '" + path.join(BACKUP_DIR, name).replace(/'/g, "''") + "'");
    let list = listBackups();
    while (list.length > 14) { fs.unlinkSync(path.join(BACKUP_DIR, list.pop().name)); }
    let sp = diskSpace();
    while (sp && list.length > 2 && sp.free < sp.total * 0.25) { fs.unlinkSync(path.join(BACKUP_DIR, list.pop().name)); list = listBackups(); sp = diskSpace(); }
    console.log('automatic backup saved: ' + name);
    return name;
  } catch (e) { console.error('automatic backup failed:', e.message); return null; }
}
function onSeparateDisk() {
  try { return fs.statSync(DATA_DIR).dev !== fs.statSync('/').dev; } catch (e) { return null; }
}
function healthReport() {
  const cars = allCarsParsed();
  const files = q.fileMeta.all();
  const live = files.filter((f) => !f.deleted_at);
  const regOf = {}; cars.forEach((c) => { regOf[c.id] = c.data.reg; });
  const linked = cars.reduce((n, c) => n + (c.data.checks || []).length, 0);
  const tickedNoFile = cars.filter((c) => (c.data.done || {})[CHECK_KEY] === true && !(c.data.checks || []).length).map((c) => c.data.reg);
  const bin = files.filter((f) => f.deleted_at).map((f) => ({ id: f.id, name: f.name, reg: regOf[f.car_id] || null, carExists: !!regOf[f.car_id], at: f.created_at, deletedAt: f.deleted_at, deletedBy: f.deleted_by }))
    .sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : -1));
  return {
    dataDir: DATA_DIR, separateDisk: onSeparateDisk(), disk: diskSpace(),
    lookup: { dvla: !!DVLA_KEY, motHistory: motReady(), lastRun: lookupStats.lastRun, checked: lookupStats.checked, updated: lookupStats.updated, failed: lookupStats.failed, lastError: lookupStats.lastError, lastErrorAt: lookupStats.lastErrorAt, lastOk: lookupStats.lastOk,
      missing: motReady() || DVLA_KEY ? [] : ['MOT_CLIENT_ID', 'MOT_CLIENT_SECRET', 'MOT_API_KEY', 'MOT_TOKEN_URL'].filter((k) => !envGet(k)) },
    pdfShrink: { available: !!gsVersion, version: gsVersion, shrunk: pdfStats.shrunk, kept: pdfStats.kept, savedBytes: pdfStats.savedBytes },
    cars: cars.length, checkFiles: live.length, checksOnCars: linked,
    unattached: orphanFiles(), tickedNoFile, bin, backups: listBackups(), cloud: cloudReport(),
  };
}
// An administrator uploads a downloaded backup; any 145 check in it that is missing here is put back on the same car (matched by registration).
function saveUpload(req, limit) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), 'recover-' + crypto.randomBytes(6).toString('hex') + '.db');
    const out = fs.createWriteStream(tmp);
    let size = 0, failed = false;
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > limit) { failed = true; out.destroy(); fs.unlink(tmp, () => {}); reject(new HttpError(413, 'That file is too large to be a backup.')); return; }
      if (!out.write(c)) { req.pause(); out.once('drain', () => req.resume()); }
    });
    req.on('end', () => { if (!failed) out.end(() => resolve(tmp)); });
    req.on('error', (e) => { failed = true; out.destroy(); fs.unlink(tmp, () => {}); reject(e); });
  });
}
async function recoverFromBackup(req, u) {
  let tmp = await saveUpload(req, 900 * 1024 * 1024);
  let old;
  try {
    const magic = Buffer.alloc(2); { const fd = fs.openSync(tmp, 'r'); fs.readSync(fd, magic, 0, 2, 0); fs.closeSync(fd); }
    if (magic[0] === 0x1f && magic[1] === 0x8b) {           // a .db.gz from the cloud backup: unzip it first
      const plain = tmp + '.db';
      try { await pipeline(fs.createReadStream(tmp), zlib.createGunzip(), fs.createWriteStream(plain)); } catch (e) { fs.unlink(plain, () => {}); throw new HttpError(400, 'That compressed file could not be opened.'); }
      fs.unlink(tmp, () => {}); tmp = plain;
    }
    const head = Buffer.alloc(16); const fd = fs.openSync(tmp, 'r'); fs.readSync(fd, head, 0, 16, 0); fs.closeSync(fd);
    if (head.toString('latin1') !== 'SQLite format 3\u0000') throw new HttpError(400, 'That is not a 145 Prepped backup file.');
    old = new DatabaseSync(tmp, { readOnly: true });
    const hasFiles = old.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'files'").get();
    if (!old.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cars'").get()) throw new HttpError(400, 'That is not a 145 Prepped backup file.');
    if (!hasFiles) return { recovered: [], skipped: 0, message: 'That backup has no 145 checks in it.' };
    const oldCols = old.prepare('PRAGMA table_info(files)').all().map((c) => c.name);
    const oldCars = {};
    old.prepare('SELECT id, data FROM cars').all().forEach((r) => { const d = JSON.parse(r.data); oldCars[r.id] = d; });
    const nowCars = allCarsParsed();
    const byId = {}, byReg = {};
    nowCars.forEach((c) => { byId[c.id] = c; byReg[normRegKey(c.data.reg)] = c; });
    const have = new Set(q.fileIds.all().map((r) => r.id));
    const ids = old.prepare('SELECT id, car_id' + (oldCols.includes('deleted_at') ? ', deleted_at' : '') + ' FROM files').all();
    const getOld = old.prepare('SELECT * FROM files WHERE id = ?');
    const recovered = []; let skipped = 0;
    db.exec('BEGIN');
    try {
      for (const r of ids) {
        if (r.deleted_at) { skipped++; continue; }
        const oc = oldCars[r.car_id];
        const target = byId[r.car_id] || (oc && byReg[normRegKey(oc.reg)]);
        if (!target) { skipped++; continue; }
        if (!have.has(r.id)) {
          const f = getOld.get(r.id);
          q.insertFile.run(f.id, target.id, f.name, f.type, f.size, f.data, f.created_at, f.created_by);
          have.add(f.id);
          if (attachFile(q.fileById.get(f.id), u)) recovered.push({ reg: target.data.reg, name: f.name });
        } else {
          const f = q.fileById.get(r.id);
          if (f && !f.deleted_at && attachFile(f, u)) recovered.push({ reg: target.data.reg, name: f.name });
          else skipped++;
        }
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    console.log('recovered ' + recovered.length + ' 145 check(s) from a backup, by ' + u.display);
    return { recovered, skipped };
  } finally {
    try { if (old) old.close(); } catch (e) { /* ignore */ }
    fs.unlink(tmp, () => {});
  }
}
/* ---------- nightly off-site backup (Cloudflare R2 or any S3-compatible storage) ---------- */
// Every night the whole database, including every uploaded 145 check, is compressed and uploaded to a private
// bucket in the owner's own storage account. Copies older than BACKUP_KEEP_DAYS (30) are removed, always keeping the newest 7.
const CLOUD = (() => {
  let endpoint = envGet('R2_ENDPOINT'), bucket = envGet('R2_BUCKET');
  try {                                                     // the endpoint is sometimes copied with the bucket on the end
    const u = new URL(endpoint); const tail = u.pathname.replace(/^\/+|\/+$/g, '');
    if (tail) { if (!bucket) bucket = tail.split('/')[0]; endpoint = u.origin; }
  } catch (e) { /* reported as a problem below */ }
  return { endpoint, bucket, keyId: envGet('R2_ACCESS_KEY_ID'), secret: envGet('R2_SECRET_ACCESS_KEY'), region: envGet('R2_REGION') || 'auto',
    keep: Math.max(7, Number(envGet('BACKUP_KEEP_DAYS')) || 30), time: /^\d{2}:\d{2}$/.test(envGet('BACKUP_TIME')) ? envGet('BACKUP_TIME') : '02:30' };
})();
const cloudReady = () => !!(CLOUD.endpoint && CLOUD.bucket && CLOUD.keyId && CLOUD.secret);
const cloudStatus = { running: false, nightlyDay: '', lastOk: null, lastName: '', lastSize: 0, copies: null, lastError: '', lastErrorAt: null };
try { Object.assign(cloudStatus, JSON.parse(metaGetSafe('cloud_status') || '{}'), { running: false }); } catch (e) { /* first run */ }
function metaGetSafe(k) { try { const r = db.prepare('SELECT v FROM meta WHERE k = ?').get(k); return r ? r.v : null; } catch (e) { return null; } }
function cloudReport() {
  return Object.assign({ ready: cloudReady(), bucket: CLOUD.bucket || null, keepDays: CLOUD.keep, time: CLOUD.time,
    missing: ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'].filter((k) => !envGet(k) && !(k === 'R2_BUCKET' && CLOUD.bucket)) }, cloudStatus);
}
async function cloudBackup(reason) {
  if (!cloudReady()) throw new Error('Cloud backup is not set up. Add the R2 settings in Render.');
  if (cloudStatus.running) throw new Error('A cloud backup is already running.');
  cloudStatus.running = true;
  const stamp = new Date().toISOString().replace(/[:]/g, '-').replace(/\.\d{3}Z$/, 'Z');
  const raw = path.join(os.tmpdir(), 'cloud-' + crypto.randomBytes(5).toString('hex') + '.db'), gz = raw + '.gz';
  const name = 'backups/145prepped-' + stamp + '-' + reason + '.db.gz';
  try {
    db.exec("VACUUM INTO '" + raw.replace(/'/g, "''") + "'");
    await pipeline(fs.createReadStream(raw), zlib.createGzip({ level: 6 }), fs.createWriteStream(gz));
    const size = fs.statSync(gz).size;
    const c = s3.client(CLOUD);
    await c.putFile(name, gz, 'application/gzip');
    // Tidy up: keep BACKUP_KEEP_DAYS days, but never fewer than the newest 7 copies.
    let copies = null;
    try {
      const all = (await c.list('backups/')).filter((o) => /\.db\.gz$/.test(o.key)).sort((a, b) => (a.key < b.key ? 1 : -1));
      const cutoff = Date.now() - CLOUD.keep * 86400000;
      for (const o of all.slice(7)) if (o.modified && Date.parse(o.modified) < cutoff) { await c.del(o.key); }
      copies = (await c.list('backups/')).filter((o) => /\.db\.gz$/.test(o.key)).length;
    } catch (e) { console.log('cloud backup tidy-up skipped: ' + e.message); }
    if (reason === 'nightly') cloudStatus.nightlyDay = todayStr();
    Object.assign(cloudStatus, { lastOk: new Date().toISOString(), lastName: name, lastSize: size, copies: copies == null ? cloudStatus.copies : copies, lastError: '' });
    console.log('cloud backup uploaded: ' + name + ' (' + size + ' bytes)');
    return { name, size, copies };
  } catch (e) {
    const m = String(e.message || e);
    const hint = /SignatureDoesNotMatch|InvalidAccessKeyId|Unauthorized|AccessDenied|403|401/.test(m) ? ' Check R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, and that the token can write to this bucket.'
      : /NoSuchBucket|404/.test(m) ? ' Check R2_BUCKET matches the bucket name exactly.'
      : /ENOTFOUND|getaddrinfo/.test(m) ? ' Check R2_ENDPOINT (https://<account id>.r2.cloudflarestorage.com).' : '';
    Object.assign(cloudStatus, { lastError: (m + hint).slice(0, 300), lastErrorAt: new Date().toISOString() });
    console.log('cloud backup failed: ' + cloudStatus.lastError);
    throw new Error(cloudStatus.lastError);
  } finally {
    cloudStatus.running = false;
    fs.unlink(raw, () => {}); fs.unlink(gz, () => {});
    try { db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('cloud_status', JSON.stringify(Object.assign({}, cloudStatus, { running: false }))); } catch (e) { /* ignore */ }
  }
}
// Once a night at BACKUP_TIME (UK). If the site was off at that time, it runs as soon as it is back (same day only).
let cloudTriesDay = '', cloudTries = 0;
setInterval(() => {
  if (!cloudReady() || cloudStatus.running) return;
  const now = londonNow(), today = todayStr();
  if (now.time < CLOUD.time) return;
  if (cloudStatus.nightlyDay === today) return;
  if (cloudTriesDay !== today) { cloudTriesDay = today; cloudTries = 0; }
  if (cloudTries >= 3) return;
  cloudTries++;
  cloudBackup('nightly').catch(() => {});
}, 5 * 60 * 1000).unref();

// Every start (which is every update) and every day: back up first, then empty the recycle bin of anything older than 30 days.
function dailyCare(reason) {
  autoBackup(reason);
  try { motPrepPass(); } catch (e) { console.log('MOT due pass failed: ' + e.message); }
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  const r = q.purgeBin.run(cutoff);
  if (r.changes) console.log('recycle bin: ' + r.changes + ' check(s) older than 30 days removed for good');
}
dailyCare('startup');
setInterval(() => dailyCare('daily'), 24 * 3600 * 1000).unref();

/* ---------- static files ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
};
function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { throw new HttpError(400, 'Bad request.'); }
  if (rel === '/' || /^\/c\/[a-f0-9]{12}$/.test(rel)) rel = '/index.html';   // /c/<id> is the link inside each car's QR code
  if (rel === '/sticker') rel = '/sticker.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'Not found.');
  let stat;
  try { stat = fs.statSync(file); } catch (e) { throw new HttpError(404, 'Not found.'); }
  if (!stat.isFile()) throw new HttpError(404, 'Not found.');
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': ext === '.png' ? 'public, max-age=86400' : 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

/* ---------- user guide (signed-in people only) ---------- */
const GUIDE_DIR = path.join(__dirname, 'guide');
function serveGuide(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
  if (!currentUser(req)) {
    res.writeHead(302, { Location: '/?next=guide', 'Cache-Control': 'no-store' });
    return res.end();
  }
  const pdf = pathname === '/guide.pdf';
  const file = path.join(GUIDE_DIR, pdf ? 'guide.pdf' : 'guide.html');
  let stat;
  try { stat = fs.statSync(file); } catch (e) { throw new HttpError(404, 'The user guide is not available yet.'); }
  res.writeHead(200, {
    'Content-Type': pdf ? 'application/pdf' : 'text/html; charset=utf-8',
    'Content-Length': stat.size,
    'Cache-Control': 'private, no-cache',
    ...(pdf ? { 'Content-Disposition': 'attachment; filename="145-Prepped-User-Guide.pdf"' } : {}),
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname === '/guide' || url.pathname === '/guide.pdf') return serveGuide(req, res, url.pathname);
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) {
      if (req.url.startsWith('/api/')) return sendJson(res, e.status, { error: e.message });
      res.writeHead(e.status, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(e.message);
    }
    console.error(e);
    return sendJson(res, 500, { error: 'Something went wrong on the server.' });
  }
});

server.listen(PORT, HOST, () => {
  console.log('Prep tracker running on http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT);
  console.log('Data folder: ' + DATA_DIR);
});

function shutdown() {
  server.close(() => { try { db.close(); } catch (e) { /* ignore */ } process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
