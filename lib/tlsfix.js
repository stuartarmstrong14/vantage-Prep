'use strict';
/* Some servers send their security certificate without the "intermediate" certificate that links it to a
   trusted authority. Browsers quietly download the missing link (from the address written inside the
   certificate, called AIA); Node does not, and fails with a certificate error.

   This does what browsers do: it reads the server's certificate, downloads the missing intermediate(s),
   checks each one really signed the certificate below it, and then makes the request again with the
   normal trusted authorities plus those intermediates. The connection is still fully checked: it only
   succeeds if the chain ends at an authority Node already trusts. */

const tls = require('node:tls');
const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const { X509Certificate } = require('node:crypto');
const dns = require('node:dns').promises;

const CHAIN_CODES = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT']);
const extraByHost = new Map();

function trustedRoots() {
  const roots = tls.rootCertificates.slice();
  const extra = process.env.NODE_EXTRA_CA_CERTS;
  if (extra) { try { roots.push(fs.readFileSync(extra, 'utf8')); } catch (e) { /* ignore */ } }
  return roots;
}

function get(url, ms) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { timeout: ms }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('download ' + res.statusCode)); }
      const parts = []; let n = 0;
      res.on('data', (d) => { n += d.length; if (n > 64 * 1024) req.destroy(new Error('too big')); else parts.push(d); });
      res.on('end', () => resolve(Buffer.concat(parts)));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function peerCert(host, port) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: 15000 }, () => {
      const c = s.getPeerX509Certificate(); s.end(); c ? resolve(c) : reject(new Error('no certificate'));
    });
    s.on('timeout', () => s.destroy(new Error('timeout')));
    s.on('error', reject);
  });
}

const issuerUrls = (cert) => String(cert.infoAccess || '').split('\n')
  .map((l) => (l.match(/^CA Issuers - URI:(\S+)/) || [])[1]).filter((u) => u && /^https?:\/\//.test(u));

// Download the chain above the server's certificate. Each step must be signed correctly or it is thrown away.
async function fetchChain(host, port) {
  const pems = [];
  let cert = await peerCert(host, port);
  for (let depth = 0; depth < 4; depth++) {
    const urls = issuerUrls(cert);
    let next = null;
    for (const u of urls) {
      try {
        const buf = await get(u, 10000);
        const c = new X509Certificate(buf);
        if (c.subject === cert.issuer && c.ca && cert.verify(c.publicKey)) { next = c; break; }
      } catch (e) { /* try the next address */ }
    }
    if (!next) break;
    pems.push(next.toString());
    if (next.subject === next.issuer) break;                       // reached a root
    cert = next;
  }
  return pems;
}

// A small fetch-like request using our own list of authorities.
function request(url, opts, ca, tlsOpts) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = opts.body == null ? null : Buffer.from(typeof opts.body === 'string' ? opts.body : String(opts.body));
    const headers = Object.assign({}, opts.headers || {}, body ? { 'Content-Length': body.length } : {});
    const req = https.request(u, Object.assign({ method: opts.method || 'GET', headers, ca, timeout: 15000, agent: false }, tlsOpts || {}), (res) => {
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => {
        const body = Buffer.concat(parts).toString('utf8');
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, text: async () => body, json: async () => JSON.parse(body) });
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// If a server refuses the name we ask for (an "unrecognised name" alert), try the other ways a TLS
// connection can be made: IPv4 only, TLS 1.2 only, and the alternative addresses DNS gives. The certificate
// is always checked against the real host name. Whatever works is remembered for that host.
const workingByHost = new Map();
const NAME_CODES = new Set(['ERR_SSL_TLSV1_UNRECOGNIZED_NAME', 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE', 'ECONNRESET', 'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION']);
async function tryOtherWays(u, url, opts, firstCode) {
  const tries = [];
  const ca = trustedRoots().concat(extraByHost.get(u.host) || []);
  const ways = [
    ['IPv4', { family: 4 }],
    ['IPv4 and TLS 1.2', { family: 4, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' }],
    ['IPv6', { family: 6 }],
    ['TLS 1.3', { minVersion: 'TLSv1.3' }],
  ];
  for (const [name, o] of ways) {
    try {
      const r = await request(url, opts, ca, Object.assign({ servername: u.hostname }, o));
      workingByHost.set(u.host, o);
      console.log('connected to ' + u.host + ' using ' + name + ' after "' + firstCode + '"');
      return r;
    } catch (e) { tries.push(name + ': ' + (e.code || e.message)); }
  }
  let addrs = '';
  try { addrs = (await dns.lookup(u.hostname, { all: true })).map((a) => a.address).join(', '); } catch (e) { addrs = 'DNS ' + (e.code || e.message); }
  const err = new Error('tried ' + tries.join('; ') + '. ' + u.hostname + ' resolves to ' + addrs);
  err.code = firstCode;
  throw err;
}

// fetch(), and if the only problem is a missing intermediate certificate, fix the chain and try again.
async function fetchWithChain(url, opts) {
  const u = new URL(url);
  const known = extraByHost.get(u.host), way = workingByHost.get(u.host);
  if (known || way) return request(url, opts, trustedRoots().concat(known || []), Object.assign({ servername: u.hostname }, way || {}));
  try { return await fetch(url, opts); } catch (e) {
    const code = e && e.cause && e.cause.code;
    if (u.protocol === 'https:' && NAME_CODES.has(code)) {
      try { return await tryOtherWays(u, url, opts, code); } catch (e2) { e2.cause = { code, message: e2.message }; throw e2; }
    }
    if (u.protocol !== 'https:' || !CHAIN_CODES.has(code)) throw e;
    let pems = [];
    try { pems = await fetchChain(u.hostname, Number(u.port) || 443); } catch (e2) { /* fall through */ }
    if (!pems.length) throw e;
    const r = await request(url, opts, trustedRoots().concat(pems));   // throws if the chain still is not trusted
    extraByHost.set(u.host, pems);
    console.log('certificate chain for ' + u.host + ' completed with ' + pems.length + ' downloaded intermediate(s)');
    return r;
  }
}

module.exports = { fetchWithChain, CHAIN_CODES };
