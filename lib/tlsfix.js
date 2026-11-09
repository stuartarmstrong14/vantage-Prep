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
function request(url, opts, ca) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = opts.body == null ? null : Buffer.from(typeof opts.body === 'string' ? opts.body : String(opts.body));
    const headers = Object.assign({}, opts.headers || {}, body ? { 'Content-Length': body.length } : {});
    const req = https.request(u, { method: opts.method || 'GET', headers, ca, timeout: 15000 }, (res) => {
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

// fetch(), and if the only problem is a missing intermediate certificate, fix the chain and try again.
async function fetchWithChain(url, opts) {
  const u = new URL(url);
  const known = extraByHost.get(u.host);
  if (known) return request(url, opts, trustedRoots().concat(known));
  try { return await fetch(url, opts); } catch (e) {
    const code = e && e.cause && e.cause.code;
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
