// Testler ve yerel geliştirme için Cloudflare D1 / R2 / ASSETS taklitleri (Node 22+, node:sqlite)
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function createD1(schemaSql, file = ':memory:') {
  const db = new DatabaseSync(file);
  if (schemaSql) db.exec(schemaSql);
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async first(col) {
      const r = db.prepare(sql).get(...args);
      if (!r) return null;
      const o = { ...r };
      return col ? o[col] : o;
    },
    async all() {
      return { success: true, results: db.prepare(sql).all(...args).map((r) => ({ ...r })) };
    },
    async run() {
      const r = db.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (list) => { const out = []; for (const s of list) out.push(await s.run()); return out; },
    exec: async (sql) => db.exec(sql),
    _db: db,
  };
}

async function toBytes(body) {
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
  if (typeof body === 'string') return new TextEncoder().encode(body);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

export function createR2({ minPartSize = 5 * 1024 * 1024 } = {}) {
  const objects = new Map();
  const uploads = new Map();
  const view = (key, rec) => ({
    key, size: rec.data.length, httpMetadata: rec.http || {}, customMetadata: rec.custom || {}, uploaded: rec.at,
    get body() { return new Response(rec.data).body; },
    arrayBuffer: async () => rec.data.slice().buffer,
  });
  const r2 = {
    async put(key, body, opts = {}) {
      objects.set(key, { data: await toBytes(body), http: opts.httpMetadata, custom: opts.customMetadata, at: new Date() });
      return view(key, objects.get(key));
    },
    async get(key, opts = {}) {
      const r = objects.get(key);
      if (!r) return null;
      const hdr = opts.range && typeof opts.range.get === 'function' ? opts.range.get('range') : null;
      const m = hdr && hdr.match(/^bytes=(\d+)-(\d*)$/);
      if (!m) return view(key, r);
      const offset = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), r.data.length - 1) : r.data.length - 1;
      const part = r.data.slice(offset, end + 1);
      return { ...view(key, r), range: { offset, length: part.length }, get body() { return new Response(part).body; } };
    },
    async head(key) { const r = objects.get(key); return r ? { ...view(key, r), body: undefined } : null; },
    async delete(keys) { for (const k of [].concat(keys)) objects.delete(k); },
    async createMultipartUpload(key, opts = {}) {
      const id = crypto.randomUUID();
      uploads.set(id, { key, opts, parts: new Map() });
      return r2.resumeMultipartUpload(key, id);
    },
    resumeMultipartUpload(key, uploadId) {
      return {
        key, uploadId,
        async uploadPart(n, body) {
          const u = uploads.get(uploadId);
          if (!u || u.key !== key) throw new Error('NoSuchUpload');
          const d = await toBytes(body);
          const etag = `etag-${n}-${d.length}-${Math.random().toString(36).slice(2, 8)}`;
          u.parts.set(n, { d, etag });
          return { partNumber: n, etag };
        },
        async complete(parts) {
          const u = uploads.get(uploadId);
          if (!u || u.key !== key) throw new Error('NoSuchUpload');
          const chunks = parts.map((p, i) => {
            const x = u.parts.get(p.partNumber);
            if (!x || x.etag !== p.etag) throw new Error('InvalidPart');
            if (i < parts.length - 1 && x.d.length < minPartSize) throw new Error('EntityTooSmall');
            return x.d;
          });
          const total = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
          let off = 0;
          for (const c of chunks) { total.set(c, off); off += c.length; }
          uploads.delete(uploadId);
          objects.set(key, { data: total, http: u.opts.httpMetadata, custom: u.opts.customMetadata, at: new Date() });
          return view(key, objects.get(key));
        },
        async abort() { uploads.delete(uploadId); },
      };
    },
    _objects: objects,
    _uploads: uploads,
  };
  return r2;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' };

// Cloudflare static assets "auto-trailing-slash" davranışının sade bir taklidi
export function createAssets(publicDir) {
  const root = path.resolve(publicDir);
  const file = (p) => { const f = path.join(root, p); return f.startsWith(root) && fs.existsSync(f) && fs.statSync(f).isFile() ? f : null; };
  return {
    async fetch(req) {
      const url = new URL(req.url);
      let p = decodeURIComponent(url.pathname);
      if (p.endsWith('.html') && p !== '/index.html' && !p.endsWith('/index.html') && file(p)) {
        // ozkandemir.net mevcut bağlantıları .html ile kullanıyor; doğrudan sun
      }
      if (!p.endsWith('/') && !path.extname(p) && fs.existsSync(path.join(root, p)) && fs.statSync(path.join(root, p)).isDirectory()) {
        return new Response(null, { status: 307, headers: { location: p + '/' } });
      }
      const f = file(p.endsWith('/') ? p + 'index.html' : p) || file(p + '.html');
      if (!f) return new Response('Not found', { status: 404 });
      return new Response(fs.readFileSync(f), { headers: { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' } });
    },
  };
}
