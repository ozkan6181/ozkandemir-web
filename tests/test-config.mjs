// ozkandemir.net — Yayın yapılandırması ve otomatik kurulum testleri
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseJsonc, buildSigningKey } from '../scripts/setup-lib.mjs';
import { createAssets, createD1 } from './helpers/cf-local.mjs';
import { SCHEMA } from '../src/panel/schema.js';
import worker from '../src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log('  ✓ ' + name); };

const text = fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8');
const cfg = parseJsonc(text);

await ok('wrangler.jsonc geçerli; yayını bozacak yer tutucu yok', () => {
  assert.equal(cfg.name, 'ozkandemir-web');
  assert.ok(fs.existsSync(path.join(ROOT, cfg.main)));
  assert.ok(fs.existsSync(path.join(ROOT, cfg.assets.directory)));
  assert.doesNotMatch(text.replace(/\/\/.*$/gm, ''), /BURAYA|YAPISTIR|TODO|XXXX/i);
  for (const d of cfg.d1_databases || []) {
    assert.equal(d.binding, 'DB');
    if (d.database_id !== undefined) assert.match(String(d.database_id), UUID, 'D1 kimliği yazılmışsa gerçek bir UUID olmalı');
  }
  for (const b of cfg.r2_buckets || []) {
    assert.equal(b.binding, 'FILES');
    if (b.bucket_name !== undefined) assert.match(b.bucket_name, /^[a-z0-9][a-z0-9-]{2,62}$/);
  }
  for (const p of ['/api/*', '/panel', '/panel/*', '/indir/*', '/lisans/*']) assert.ok(cfg.assets.run_worker_first.includes(p), p);
  assert.match(cfg.vars.SETUP_CODE_HASH, /^[0-9a-f]{64}$/, 'kurulum kodunun özeti');
});

await ok('Gömülü şema (schema.js) migration dosyalarıyla birebir aynı', () => {
  const norm = (db) => db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all().map((r) => ({ ...r, sql: String(r.sql).replace(/\s+/g, ' ') }));
  const a = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(path.join(ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) a.exec(fs.readFileSync(path.join(ROOT, 'migrations', f), 'utf8'));
  const b = new DatabaseSync(':memory:');
  for (const s of SCHEMA) b.exec(s);
  assert.deepEqual(norm(b), norm(a));
});

await ok('Veritabanı yokken site ve panel ekranı çalışır, API anlaşılır uyarı verir', async () => {
  const env = { ASSETS: createAssets(path.join(ROOT, 'public')) };
  const get = (p, init) => worker.fetch(new Request('https://ozkandemir.net' + p, init), env);
  assert.equal((await get('/index.html')).status, 200);
  assert.equal((await get('/panel/')).status, 200);
  const r = await get('/panel/api/setup/status');
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /kurulumu tamamlanmadı/);
});

await ok('Boş veritabanı: ilk istekte tablolar ve anahtarlar otomatik kurulur, sonra aynı kalır', async () => {
  const db = createD1('');
  const env = { DB: db, ASSETS: createAssets(path.join(ROOT, 'public')), SETUP_CODE_HASH: cfg.vars.SETUP_CODE_HASH };
  const get = (p) => worker.fetch(new Request('https://ozkandemir.net' + p), env);
  const st = await get('/panel/api/setup/status');
  assert.equal(st.status, 200);
  assert.deepEqual(await st.json(), { needsSetup: true, setupEnabled: true });
  const tables = db._db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  for (const t of ['admin', 'sessions', 'programs', 'versions', 'links', 'licenses', 'activations', 'audit', 'system_keys', 'setup_pending']) assert.ok(tables.includes(t), t);
  assert.equal(db._db.prepare('SELECT COUNT(*) n FROM programs').get().n, 6);
  const pk1 = await (await get('/lisans/api/public-key')).json();
  assert.match(pk1.x, /^[A-Za-z0-9_-]{43}$/);
  const keys = db._db.prepare('SELECT name FROM system_keys ORDER BY name').all().map((r) => r.name);
  assert.deepEqual(keys, ['license_signing_key', 'panel_enc_key', 'schema_version']);
  // Yeni bir Worker örneği (önbellek yok) aynı anahtarı kullanmalı
  const env2 = { ...env, DB: { prepare: (s) => db.prepare(s), batch: (l) => db.batch(l) } };
  const pk2 = await (await worker.fetch(new Request('https://ozkandemir.net/lisans/api/public-key'), env2)).json();
  assert.equal(pk2.x, pk1.x, 'imza anahtarı her yayında değişmemeli');
});

await ok('Cloudflare secret tanımlıysa veritabanındaki anahtar yerine o kullanılır', async () => {
  const sk = await buildSigningKey();
  const env = { DB: createD1(''), ASSETS: createAssets(path.join(ROOT, 'public')), LICENSE_SIGNING_KEY: sk.secret, PANEL_ENC_KEY: Buffer.alloc(32, 7).toString('base64') };
  const pk = await (await worker.fetch(new Request('https://ozkandemir.net/lisans/api/public-key'), env)).json();
  assert.equal(pk.x, sk.publicX);
});

console.log(`config tests: OK (${n} test)`);
