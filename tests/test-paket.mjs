// ozkandemir.net — V3.12 "NİS PDKS + Yıllık İzin" paketi testleri (panel lisans oluşturma / uzatma / askı / iptal)
// Çalıştır: node tests/test-paket.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createD1, createR2, createAssets } from './helpers/cf-local.mjs';
import { buildSigningKey, buildAdminSetup } from '../scripts/setup-lib.mjs';
import * as S from '../src/panel/security.js';
import { verifyToken, signingPublicKey } from '../src/panel/license.js';
import worker from '../src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + (e && e.stack || e)); process.exit(1); }
}
let clock = Date.now();
Date.now = () => clock;
const tick = (sec) => { clock += sec * 1000; };

const schema = fs.readdirSync(path.join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => fs.readFileSync(path.join(ROOT, 'migrations', f), 'utf8')).join('\n');
const EMAIL = 'ozkan6181@hotmail.com', PASS = 'Cok-Guclu-Sifre-2026';
const setup = await buildAdminSetup({ email: EMAIL, password: PASS });
const signing = await buildSigningKey();
const env = {
  DB: createD1(schema), FILES: createR2(), ASSETS: createAssets(path.join(ROOT, 'public')),
  PANEL_ENC_KEY: setup.encKey, LICENSE_SIGNING_KEY: signing.secret,
};
await env.DB.exec(setup.sql);
const db = env.DB._db;
const SECRET = S.base32Decode(setup.secret);

const jar = {};
async function panel(method, p, body) {
  const h = new Headers({ 'cf-connecting-ip': '203.0.113.10', 'user-agent': 'Test' });
  if (method !== 'GET') { h.set('x-od-panel', '1'); h.set('origin', 'https://ozkandemir.net'); }
  const ck = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  if (ck) h.set('cookie', ck);
  if (body !== undefined) h.set('content-type', 'application/json');
  const res = await worker.fetch(new Request('https://ozkandemir.net' + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined }), env);
  for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const code = async () => { tick(31); return S.hotp(SECRET, Math.floor(S.now() / 30)); };
async function lic(p, body) {
  const res = await worker.fetch(new Request('https://ozkandemir.net/lisans/api/' + p, {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.7' }, body: JSON.stringify(body),
  }), env);
  return { status: res.status, data: await res.json() };
}
const dev = (n) => n.toString(16).padStart(2, '0').repeat(32);

const r1 = await panel('POST', '/panel/api/login', { email: EMAIL, password: PASS });
const r2 = await panel('POST', '/panel/api/verify', { challenge: r1.data.challenge, code: await S.hotp(SECRET, Math.floor(S.now() / 30)) });
assert.equal(r2.status, 200, JSON.stringify(r2.data));
const prods = (await panel('GET', '/panel/api/license-products')).data.products;
const PDKS = prods.find((p) => p.slug === 'nis-pdks'), IZIN = prods.find((p) => p.slug === 'yillik-izin'), BNKX = prods.find((p) => p.slug === 'banka-xml-aktarim');
const base = (over = {}) => ({ programId: PDKS.programId, customer: 'Paket Gıda A.Ş.', email: 'ik@paketgida.com', phone: '0532 000 11 22',
  ends: '2027-10-10', maxDevices: 1, limits: { personel: 150, sube: 2 }, modules: ['mobil', 'push'], ...over });

let L;
await test('Paket: tek işlemde NPDK (izin entegrasyonu açık) + IZIN lisansı, aynı müşteri ve tarihler', async () => {
  const r = await panel('POST', '/panel/api/licenses', { ...base(), bundle: 'pdks-izin', code: await code() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  L = r.data;
  assert.match(L.key, /^NPDK(-[0-9A-Z]{4}){4}$/);
  assert.ok(L.modules.includes('izin_entegrasyon'), 'izin entegrasyonu otomatik eklenir');
  const o = L.bundle.partner;
  assert.equal(L.bundle.label, 'NİS PDKS + Yıllık İzin');
  assert.match(o.key, /^IZIN(-[0-9A-Z]{4}){4}$/);
  assert.equal(o.limits.personel, 150);
  assert.deepEqual(o.modules, ['pdks_entegrasyon']);
  const rows = db.prepare('SELECT l.id, l.customer, l.email, l.starts_at, l.ends_at, b.bundle_id FROM licenses l JOIN license_bundles b ON b.license_id = l.id ORDER BY l.id').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].bundle_id, L.id);
  assert.equal(rows[1].bundle_id, L.id);
  assert.equal(rows[0].customer, rows[1].customer);
  assert.equal(rows[0].ends_at, rows[1].ends_at);
  assert.equal(rows[0].starts_at, rows[1].starts_at);
});

await test('Liste "Paket" işareti; detayda paketteki diğer lisans', async () => {
  const list = (await panel('GET', '/panel/api/licenses')).data.licenses;
  assert.equal(list.filter((x) => x.bundle).length, 2);
  const d = (await panel('GET', `/panel/api/licenses/${L.id}`)).data;
  assert.equal(d.bundle.partners.length, 1);
  assert.equal(d.bundle.partners[0].id, L.bundle.partner.id);
  assert.equal(d.bundle.partners[0].program, 'Yıllık İzin');
  const d2 = (await panel('GET', `/panel/api/licenses/${L.bundle.partner.id}`)).data;
  assert.equal(d2.bundle.partners[0].id, L.id);
});

await test('Etkinleştirme: NPDK belgesinde izin_entegrasyon modülü', async () => {
  const r = await lic('activate', { key: L.key, device_id: dev(3), device_name: 'PAKETSRV', product: 'NPDK', app_version: 'V1.36.0' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const p = await verifyToken(await signingPublicKey(env), r.data.token);
  assert.ok(p.modules.includes('izin_entegrasyon'));
});

await test('Süre uzatma pakete birlikte uygulanır (isteğe bağlı tek lisans)', async () => {
  const e = await panel('POST', `/panel/api/licenses/${L.id}/extend`, { ends: '2028-10-11', code: await code() });
  assert.equal(e.status, 200, JSON.stringify(e.data));
  assert.deepEqual(e.data.also, ['Yıllık İzin']);
  const ends = db.prepare('SELECT ends_at FROM licenses ORDER BY id').all().map((r) => r.ends_at);
  assert.equal(ends[0], ends[1]);
  const e2 = await panel('POST', `/panel/api/licenses/${L.id}/extend`, { ends: '2029-10-11', bundle: false, code: await code() });
  assert.deepEqual(e2.data.also, []);
  const ends2 = db.prepare('SELECT ends_at FROM licenses ORDER BY id').all().map((r) => r.ends_at);
  assert.ok(ends2[0] > ends2[1]);
  const ev = db.prepare("SELECT detail FROM license_events WHERE license_id = ? AND type = 'Süre uzatıldı'").all(L.bundle.partner.id);
  assert.equal(ev.length, 1);
  assert.match(ev[0].detail, /paketiyle birlikte/);
});

await test('Askıya alma / yeniden açma pakete birlikte; ?tek=1 yalnız o lisans', async () => {
  const st = () => db.prepare('SELECT status FROM licenses ORDER BY id').all().map((r) => r.status);
  let r = await panel('POST', `/panel/api/licenses/${L.bundle.partner.id}/suspend`, {});
  assert.equal(r.status, 200);
  assert.deepEqual(st(), ['suspended', 'suspended']);
  r = await panel('POST', `/panel/api/licenses/${L.id}/resume`, { code: await code() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(st(), ['active', 'active']);
  r = await panel('POST', `/panel/api/licenses/${L.id}/suspend?tek=1`, {});
  assert.deepEqual(st(), ['suspended', 'active']);
  r = await panel('POST', `/panel/api/licenses/${L.id}/resume?tek=1`, { code: await code() });
  assert.deepEqual(st(), ['active', 'active']);
});

await test('İptal pakete birlikte', async () => {
  const r = await panel('POST', `/panel/api/licenses/${L.id}/revoke`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(db.prepare('SELECT status FROM licenses ORDER BY id').all().map((x) => x.status), ['revoked', 'revoked']);
});

await test('Paket yalnız NİS PDKS ile; paketsiz lisans eskisi gibi', async () => {
  let r = await panel('POST', '/panel/api/licenses', { ...base({ programId: BNKX.programId, limits: undefined, modules: undefined }), bundle: 'pdks-izin', code: await code() });
  assert.equal(r.status, 400);
  assert.match(r.data.error || r.data.message, /NİS PDKS/);
  const n = db.prepare('SELECT COUNT(*) AS n FROM licenses').get().n;
  r = await panel('POST', '/panel/api/licenses', { ...base({ customer: 'Tek PDKS Ltd.' }), code: await code() });
  assert.equal(r.status, 200);
  assert.equal(r.data.bundle, null);
  assert.ok(!r.data.modules.includes('izin_entegrasyon'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM licenses').get().n, n + 1);
  const d = (await panel('GET', `/panel/api/licenses/${r.data.id}`)).data;
  assert.equal(d.bundle, null);
  const s = await panel('POST', `/panel/api/licenses/${r.data.id}/suspend`, {});
  assert.deepEqual(s.data.also, []);
  assert.ok(IZIN);
});

console.log(`\n${passed} test geçti.`);
