// ozkandemir.net — Yayın yapılandırması testleri (GitHub → Cloudflare yayını reddedilmesin)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonc, patchWranglerConfig } from '../scripts/setup-lib.mjs';
import { createAssets } from './helpers/cf-local.mjs';
import worker from '../src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log('  ✓ ' + name); };

const text = fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8');
const cfg = parseJsonc(text);

await ok('wrangler.jsonc geçerli ve yer tutucu içermiyor', () => {
  assert.equal(cfg.name, 'ozkandemir-web');
  assert.ok(fs.existsSync(path.join(ROOT, cfg.main)), 'main dosyası var');
  assert.ok(fs.existsSync(path.join(ROOT, cfg.assets.directory)), 'assets klasörü var');
  assert.doesNotMatch(text.replace(/\/\/.*$/gm, ''), /BURAYA|YAPISTIR|TODO|XXXX/i, 'yayını bozacak yer tutucu kalmamalı');
  for (const d of cfg.d1_databases || []) assert.match(String(d.database_id), UUID, 'D1 kimliği gerçek bir UUID olmalı');
  for (const b of cfg.r2_buckets || []) assert.match(b.bucket_name, /^[a-z0-9][a-z0-9-]{2,62}$/);
  for (const p of ['/api/*', '/panel', '/panel/*', '/indir/*', '/lisans/*']) assert.ok(cfg.assets.run_worker_first.includes(p), p);
  assert.match(cfg.compatibility_date, /^\d{4}-\d{2}-\d{2}$/);
});

await ok('panel:altyapi yaması geçerli JSONC üretir ve tekrar çalıştırılabilir', () => {
  const id = '1b2c3d4e-0000-4000-8000-123456789abc';
  const once = patchWranglerConfig(text, id);
  const twice = patchWranglerConfig(once, id);
  assert.equal(once, twice);
  const c = parseJsonc(once);
  assert.deepEqual(c.d1_databases, [{ binding: 'DB', database_name: 'ozkandemir-panel', database_id: id, migrations_dir: 'migrations' }]);
  assert.deepEqual(c.r2_buckets, [{ binding: 'FILES', bucket_name: 'ozkandemir-programlar' }]);
  assert.deepEqual(c.vars, cfg.vars);
  assert.throws(() => patchWranglerConfig(text, 'BURAYA'));
});

await ok('Panel kaynakları yokken site yayınlanabilir ve çalışır', async () => {
  const env = { ASSETS: createAssets(path.join(ROOT, 'public')) };
  const get = (p, init) => worker.fetch(new Request('https://ozkandemir.net' + p, init), env);
  assert.equal((await get('/index.html')).status, 200);
  assert.equal((await get('/panel/')).status, 200);
  const login = await get('/panel/api/login', { method: 'POST', headers: { 'x-od-panel': '1', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(login.status, 503);
  assert.match((await login.json()).error, /kurulumu tamamlanmadı/);
  assert.equal((await get('/lisans/api/public-key')).status, 503);
  assert.ok([404, 503].includes((await get('/indir/' + 'a'.repeat(43))).status));
});

await ok('Migration dosyaları wrangler biçiminde ve sıralı', () => {
  const files = fs.readdirSync(path.join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  assert.deepEqual(files, ['0001_panel.sql', '0002_lisans.sql']);
});

console.log(`config tests: OK (${n} test)`);
