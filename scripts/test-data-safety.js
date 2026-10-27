'use strict';
// Checks that 145 point checks survive everything an update can do:
//   node scripts/test-data-safety.js
// Starts the app on a throwaway data folder, uploads checks, then simulates overlapping saves,
// a lost link, a removal, a restart (as happens on every deploy) and recovery from a backup.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), '145-safety-'));
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = 'http://127.0.0.1:' + PORT;
let server, cookie = '', failures = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { DATA_DIR: DIR, PORT: String(PORT), HOST: '127.0.0.1' }), stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    server.stdout.on('data', (d) => { log += d; if (/running on/.test(log)) resolve(); });
    server.stderr.on('data', (d) => { log += d; });
    server.on('exit', (c) => reject(new Error('server exited ' + c + '\n' + log)));
  });
}
function stop() { return new Promise((r) => { server.removeAllListeners('exit'); server.on('exit', r); server.kill(); }); }
async function call(method, p, body, raw) {
  const headers = { Origin: BASE, Cookie: cookie };
  let data;
  if (raw) { headers['Content-Type'] = 'application/octet-stream'; headers['X-Filename'] = 'check.pdf'; data = raw; }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; data = JSON.stringify(body); }
  const r = await fetch(BASE + p, { method, headers, body: data, duplex: 'half' });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const type = r.headers.get('content-type') || '';
  return { status: r.status, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}
const pdf = (n) => Buffer.concat([Buffer.from('%PDF-1.4\n145 point check ' + n + '\n'), Buffer.alloc(3000, n)]);
const car = async (id) => (await call('GET', '/api/cars')).body.cars.find((c) => c.id === id);

(async () => {
  await start();
  await call('POST', '/api/setup', { username: 'admin', display: 'Admin Person', password: 'password123' });
  const id = (await call('POST', '/api/cars', { reg: 'YE23 VOU', make: 'Ford', model: 'Puma' })).body.id;
  await call('POST', '/api/cars/' + id + '/checks', null, pdf(1));
  ok((await car(id)).checks.length === 1, 'upload stores the check on the car');

  // 1. overlapping saves: a slow upload while someone ticks boxes on the same car
  const slow = new ReadableStream({ async start(ctl) { ctl.enqueue(pdf(2).subarray(0, 100)); await sleep(600); ctl.enqueue(pdf(2).subarray(100)); ctl.close(); } });
  const up = call('POST', '/api/cars/' + id + '/checks', null, slow);
  await sleep(150);
  await call('PATCH', '/api/cars/' + id, { done: { arrived_advert: true } });
  await up;
  await call('PATCH', '/api/cars/' + id, { notes: 'after upload' });
  let c = await car(id);
  ok(c.checks.length === 2, 'overlapping upload and tick keep both checks (' + c.checks.length + ')');
  ok(c.done.arrived_advert === true, 'overlapping upload does not undo the tick');

  // 2. a check that has come unattached from its car is found and put back
  const db = new DatabaseSync(path.join(DIR, 'prep.db'));
  const row = db.prepare('SELECT data FROM cars WHERE id = ?').get(id);
  const d = JSON.parse(row.data); d.checks = d.checks.slice(1); db.prepare('UPDATE cars SET data = ? WHERE id = ?').run(JSON.stringify(d), id);
  let h = (await call('GET', '/api/health')).body;
  ok(h.unattached.length === 1 && h.unattached[0].reg === 'YE23 VOU', 'health finds the unattached check');
  await call('POST', '/api/health/reattach', {});
  ok((await car(id)).checks.length === 2, 'reattach puts it back on the car');

  // 3. removing a check keeps it in the recycle bin, and it can be restored
  const fid = (await car(id)).checks[0].id;
  await call('DELETE', '/api/files/' + fid);
  h = (await call('GET', '/api/health')).body;
  ok((await car(id)).checks.length === 1 && h.bin.length === 1, 'removed check goes to the recycle bin');
  await call('POST', '/api/files/' + fid + '/restore', {});
  ok((await car(id)).checks.length === 2, 'restore brings it back');

  // 4. a backup taken now can put back a check that is lost completely
  const backup = (await call('GET', '/api/backup')).body;
  const lost = (await car(id)).checks[1].id;
  const d2 = JSON.parse(db.prepare('SELECT data FROM cars WHERE id = ?').get(id).data);
  d2.checks = d2.checks.filter((x) => x.id !== lost); db.prepare('UPDATE cars SET data = ? WHERE id = ?').run(JSON.stringify(d2), id);
  db.prepare('DELETE FROM files WHERE id = ?').run(lost);
  ok((await car(id)).checks.length === 1, 'simulated total loss of one check');
  const rec = (await call('POST', '/api/health/recover', null, backup)).body;
  ok(rec.recovered.length === 1 && (await car(id)).checks.length === 2, 'recover from backup puts the lost check back');
  const again = (await call('POST', '/api/health/recover', null, backup)).body;
  ok(again.recovered.length === 0 && (await car(id)).checks.length === 2, 'recovering twice adds nothing twice');
  db.close();

  // 5. a restart (every deploy restarts the app) keeps everything and takes a backup first
  await stop(); await start();
  cookie = ''; await call('POST', '/api/login', { username: 'admin', password: 'password123' });
  c = await car(id);
  ok(c.checks.length === 2, 'checks are still there after a restart');
  const file = await call('GET', '/api/files/' + c.checks[0].id);
  ok(file.status === 200 && file.body.subarray(0, 5).toString() === '%PDF-', 'check file opens after a restart');
  h = (await call('GET', '/api/health')).body;
  ok(h.backups.some((b) => /startup/.test(b.name)), 'an automatic backup was taken at start-up');
  ok(h.unattached.length === 0, 'nothing unattached at the end');

  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(failures ? failures + ' check(s) FAILED' : 'All data safety checks passed.');
  process.exit(failures ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await stop(); } catch (er) { /* ignore */ } process.exit(1); });
