'use strict';
/* A small S3-compatible client (Cloudflare R2, Backblaze B2, AWS S3) for off-site backups: upload a file,
   list what is there, delete old ones. Requests are signed with AWS Signature Version 4. No dependencies. */

const crypto = require('node:crypto');
const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');

const sha256 = (d) => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
// S3 wants each path segment encoded, keeping the slashes.
const encKey = (k) => k.split('/').map((p) => encodeURIComponent(p).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');
const encQ = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function sign(o) {
  // o: { method, host, path (already encoded), query: {k:v}, headers: {lowercase: value}, payloadHash, keyId, secret, region, service, amzDate }
  const amzDate = o.amzDate || new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const headers = Object.assign({}, o.headers, { host: o.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': o.payloadHash });
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const canonHeaders = names.map((h) => h + ':' + String(headers[h]).trim().replace(/\s+/g, ' ') + '\n').join('');
  const signed = names.join(';');
  const query = Object.keys(o.query || {}).sort().map((k) => encQ(k) + '=' + encQ(o.query[k])).join('&');
  const canon = [o.method, o.path, query, canonHeaders, signed, o.payloadHash].join('\n');
  const scope = day + '/' + o.region + '/' + (o.service || 's3') + '/aws4_request';
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canon)].join('\n');
  let k = hmac('AWS4' + o.secret, day); k = hmac(k, o.region); k = hmac(k, o.service || 's3'); k = hmac(k, 'aws4_request');
  const signature = crypto.createHmac('sha256', k).update(toSign).digest('hex');
  headers.authorization = 'AWS4-HMAC-SHA256 Credential=' + o.keyId + '/' + scope + ', SignedHeaders=' + signed + ', Signature=' + signature;
  return { headers, query };
}

function client(cfg) {
  // cfg: { endpoint: 'https://<acct>.r2.cloudflarestorage.com', bucket, keyId, secret, region }
  const ep = new URL(cfg.endpoint);
  const region = cfg.region || 'auto';
  const mod = ep.protocol === 'http:' ? http : https;
  function call(method, key, query, extraHeaders, body) {
    const path = '/' + encodeURIComponent(cfg.bucket) + (key ? '/' + encKey(key) : '/');
    const isFile = body && body.file;
    const payloadHash = isFile ? 'UNSIGNED-PAYLOAD' : sha256(body || '');
    const s = sign({ method, host: ep.host, path, query, headers: extraHeaders || {}, payloadHash, keyId: cfg.keyId, secret: cfg.secret, region });
    return new Promise((resolve, reject) => {
      const req = mod.request({ method, hostname: ep.hostname, port: ep.port || undefined, path: path + (s.query ? '?' + s.query : ''), headers: s.headers, timeout: 120000 }, (res) => {
        const parts = []; res.on('data', (d) => parts.push(d));
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8');
          if (res.statusCode >= 300) {
            const code = (text.match(/<Code>([^<]+)<\/Code>/) || [])[1] || '';
            const msg = (text.match(/<Message>([^<]+)<\/Message>/) || [])[1] || '';
            const e = new Error('Storage answered ' + res.statusCode + (code ? ' ' + code : '') + (msg ? ': ' + msg : ''));
            e.status = res.statusCode; e.code = code; return reject(e);
          }
          resolve({ status: res.statusCode, text, headers: res.headers });
        });
      });
      req.on('timeout', () => req.destroy(new Error('The storage service did not answer in time.')));
      req.on('error', reject);
      if (isFile) fs.createReadStream(body.file).on('error', (e) => req.destroy(e)).pipe(req);
      else req.end(body || undefined);
    });
  }
  return {
    putFile: (key, file, type) => call('PUT', key, null, { 'content-type': type || 'application/octet-stream', 'content-length': fs.statSync(file).size }, { file }),
    async list(prefix) {
      const out = []; let token = null;
      for (let i = 0; i < 20; i++) {
        const qy = { 'list-type': '2', prefix: prefix || '' }; if (token) qy['continuation-token'] = token;
        const r = await call('GET', '', qy, {}, '');
        const items = r.text.split('<Contents>').slice(1).map((c) => ({
          key: (c.match(/<Key>([^<]+)<\/Key>/) || [])[1], size: Number((c.match(/<Size>(\d+)<\/Size>/) || [])[1] || 0),
          modified: (c.match(/<LastModified>([^<]+)<\/LastModified>/) || [])[1] }))
          .map((x) => Object.assign(x, { key: x.key && x.key.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'") }));
        out.push(...items);
        token = (r.text.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/) || [])[1];
        if (!token) break;
      }
      return out;
    },
    del: (key) => call('DELETE', key, null, {}, ''),
  };
}

module.exports = { client, sign };
