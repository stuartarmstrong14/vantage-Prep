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
const { hashPassword, verifyPassword } = require('./lib/passwords');
const inbound = require('./lib/inbound');

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
  insertFile: db.prepare('INSERT INTO files (id, car_id, name, type, size, data, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  fileById: db.prepare('SELECT * FROM files WHERE id = ?'),
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
    }
    // any other key is ignored on purpose
  }
  // Completed means every box ticked, including the final quality check. readyAt is the day that happened.
  const finished = (d) => !!d && d.ready_qc === true && stageFromDone(d) === 'ready';
  if (finished(next.done)) { if (!finished(cur.done) || !cur.readyAt) next.readyAt = todayStr(); }
  else next.readyAt = '';
  stampHistory(cur, next, user);
  return next;
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
    const created = [], skipped = [];
    for (const f of found) {
      const key = inbound.normReg(f.reg);
      if (have.has(key)) { skipped.push(f.reg); continue; }
      have.add(key);
      const car = { reg: f.reg, make: f.make, model: f.model, tag: f.tag, prep: f.prep || [], mileage: f.mileage, mot: f.mot,
        notes: 'Added from email. Check the details are right.', stage: 'arrived', added: todayStr(), readyAt: '', done: {},
        history: [{ s: 'arrived', at: new Date().toISOString(), by: 'Email' }] };
      q.insertCar.run(crypto.randomBytes(6).toString('hex'), JSON.stringify(car), new Date().toISOString(), 'Email');
      created.push(f.reg);
    }
    if (created.length) bump();
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
    return sendJson(res, 200, { setup: q.countUsers.get().c === 0, user: u ? publicUser(u) : null, publicUrl: PUBLIC_URL || null });
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
    const filled = applyCarPatch(car, { reg: b.reg, make: b.make, model: b.model, tag: b.tag, prep: b.prep || [], mileage: b.mileage === undefined ? null : b.mileage }, u);
    if (!filled.reg || !filled.make || !filled.model) throw new HttpError(400, 'Registration, make and model are required.');
    filled.history = [{ s: 'arrived', at: new Date().toISOString(), by: u.display }];
    const id = crypto.randomBytes(6).toString('hex');
    const now = new Date().toISOString();
    q.insertCar.run(id, JSON.stringify(filled), now, u.display);
    bump();
    return sendJson(res, 201, carOut(q.carById.get(id)));
  }

  const upMatch = p.match(/^\/api\/cars\/([a-f0-9]{12})\/checks$/);
  if (upMatch && method === 'POST') {
    const u = requireStaff(req);
    const carId = upMatch[1];
    if (!q.carById.get(carId)) throw new HttpError(404, 'That car no longer exists.');
    const buf = await readRaw(req, MAX_UPLOAD);
    const type = sniffType(buf);
    if (!type) throw new HttpError(400, 'Upload a PDF or a photo (JPEG, PNG, WebP or HEIC).');
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
    cars: cars.length, checkFiles: live.length, checksOnCars: linked,
    unattached: orphanFiles(), tickedNoFile, bin, backups: listBackups(),
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
  const tmp = await saveUpload(req, 900 * 1024 * 1024);
  let old;
  try {
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
// Every start (which is every update) and every day: back up first, then empty the recycle bin of anything older than 30 days.
function dailyCare(reason) {
  autoBackup(reason);
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
