// ozkandemir.net — NİS PDKS uzaktan erişim adresi testleri (tunnel_create / tunnel_delete + panel)
// Çalıştır: node tests/test-tunel.mjs   — Cloudflare API taklit edilir; gerçek hesaba istek gitmez.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createD1, createR2, createAssets } from './helpers/cf-local.mjs';
import { buildSigningKey, buildAdminSetup } from '../scripts/setup-lib.mjs';
import * as S from '../src/panel/security.js';
import { signPayload } from '../src/panel/license.js';
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

// ---------- Cloudflare API taklidi ----------
const ACC = 'acc123', ZONE = 'zone456', TOKEN = 'cf_' + 'A'.repeat(40);
const cfState = { tunnels: new Map(), dns: new Map(), calls: [], n: 0, fail: null };
cfState.dns.set('mx1', { id: 'mx1', type: 'MX', name: 'ozkandemir.net', content: 'mail.example.net' });
cfState.dns.set('www1', { id: 'www1', type: 'CNAME', name: 'mail-pdks.ozkandemir.net', content: 'baska.example.net' }); // tünel olmayan kayıt
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.startsWith('https://api.cloudflare.com/client/v4')) return realFetch(input, init);
  const method = (init.method || 'GET').toUpperCase();
  const u = new URL(url);
  const p = u.pathname.replace('/client/v4', '');
  const body = init.body ? JSON.parse(init.body) : undefined;
  cfState.calls.push({ method, p, body });
  const ok = (result) => new Response(JSON.stringify({ success: true, result }), { status: 200 });
  const err = (status, message) => new Response(JSON.stringify({ success: false, errors: [{ code: status, message }] }), { status });
  if (init.headers.authorization !== `Bearer ${TOKEN}`) return err(403, 'Authentication error');
  if (cfState.fail && cfState.fail(method, p)) return err(500, 'Internal error');
  let m;
  if (method === 'GET' && p === '/zones') return ok(u.searchParams.get('name') === 'ozkandemir.net' ? [{ id: ZONE, account: { id: ACC } }] : []);
  if (method === 'GET' && p === `/accounts/${ACC}/cfd_tunnel`) return ok([...cfState.tunnels.values()]);
  if (method === 'POST' && p === `/accounts/${ACC}/cfd_tunnel`) {
    const id = 'tun-' + (++cfState.n);
    cfState.tunnels.set(id, { id, name: body.name, config: null });
    return ok({ id, token: 'IGNORED' });
  }
  if ((m = p.match(new RegExp(`^/accounts/${ACC}/cfd_tunnel/([^/]+)(/.*)?$`)))) {
    const t = cfState.tunnels.get(m[1]);
    if (!t) return err(404, 'Tunnel not found');
    if (method === 'GET' && !m[2]) return ok(t);
    if (method === 'PUT' && m[2] === '/configurations') { t.config = body.config; return ok({}); }
    if (method === 'GET' && m[2] === '/token') return ok('TUNNEL-TOKEN-' + t.id);
    if (method === 'DELETE' && m[2] === '/connections') return ok({});
    if (method === 'DELETE' && !m[2]) { cfState.tunnels.delete(m[1]); return ok({ id: m[1] }); }
  }
  if (p === `/zones/${ZONE}/dns_records`) {
    if (method === 'GET') {
      const name = u.searchParams.get('name');
      return ok([...cfState.dns.values()].filter((r) => !name || r.name === name));
    }
    if (method === 'POST') {
      if ([...cfState.dns.values()].some((r) => r.name === body.name)) return err(400, 'Record already exists');
      const id = 'dns-' + (++cfState.n);
      cfState.dns.set(id, { id, ...body });
      return ok({ id });
    }
  }
  if ((m = p.match(new RegExp(`^/zones/${ZONE}/dns_records/([^/]+)$`)))) {
    if (!cfState.dns.has(m[1])) return err(404, 'Record not found');
    if (method === 'PUT') { cfState.dns.set(m[1], { id: m[1], ...body }); return ok({ id: m[1] }); }
    if (method === 'DELETE') { cfState.dns.delete(m[1]); return ok({ id: m[1] }); }
  }
  return err(404, `taklitte yok: ${method} ${p}`);
};
const dnsByName = (n) => [...cfState.dns.values()].find((r) => r.name === n);

// ---------- ortam ----------
const schema = fs.readdirSync(path.join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => fs.readFileSync(path.join(ROOT, 'migrations', f), 'utf8')).join('\n');
const EMAIL = 'ozkan6181@hotmail.com', PASS = 'Cok-Guclu-Sifre-2026';
const setup = await buildAdminSetup({ email: EMAIL, password: PASS });
const signing = await buildSigningKey();
const vendor = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const b64 = (u8) => Buffer.from(u8).toString('base64');
const env = {
  DB: createD1(schema), FILES: createR2(), ASSETS: createAssets(path.join(ROOT, 'public')),
  PANEL_ENC_KEY: setup.encKey, LICENSE_SIGNING_KEY: signing.secret,
  PDKS_VENDOR_PUBKEY: b64(new Uint8Array(await crypto.subtle.exportKey('raw', vendor.publicKey))),
};
await env.DB.exec(setup.sql);
const db = env.DB._db;
const SECRET = S.base32Decode(setup.secret);

async function legacy(fields = {}) {
  const payload = new TextEncoder().encode(JSON.stringify({ v: 1, id: 'NIS-KITAPSEC', customer: 'Kitapseç', issued: '2026-01-01',
    valid_until: null, updates_until: null, max_users: null, modules: ['*'], machine: null, ...fields }));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, vendor.privateKey, payload));
  return ['-----BEGIN NIS PDKS LICENSE-----', b64(payload), b64(sig), '-----END NIS PDKS LICENSE-----'].join('\n') + '\n';
}
async function api(body) {
  const res = await worker.fetch(new Request('https://ozkandemir.net/pdks-api/api.php', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.7' }, body: JSON.stringify(body),
  }), env);
  return { status: res.status, data: await res.json() };
}
const KS = { machine: 'ABCD-1111-2222-3333', host: 'KITAPSECRDP', version: 'V1.32.2' };

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

// ---------- testler ----------
await test('Cloudflare anahtarı yokken adres istenirse anlaşılır hata (503), hiçbir Cloudflare çağrısı yok', async () => {
  const r = await api({ ...KS, a: 'tunnel_create', name: 'kitapsec', port: 8000, license: await legacy() });
  assert.equal(r.status, 503);
  assert.match(r.data.error, /henüz hazır değil/);
  assert.equal(cfState.calls.length, 0);
});

await test('Panel: anahtar yalnız doğrulama koduyla ve Cloudflare\'de doğrulanınca şifreli kaydedilir', async () => {
  const r1 = await panel('POST', '/panel/api/login', { email: EMAIL, password: PASS });
  const r2 = await panel('POST', '/panel/api/verify', { challenge: r1.data.challenge, code: await S.hotp(SECRET, Math.floor(S.now() / 30)) });
  assert.equal(r2.status, 200, JSON.stringify(r2.data));
  assert.equal((await panel('POST', '/panel/api/tunnel-config', { token: TOKEN })).status, 401, 'kodsuz');
  let r = await panel('POST', '/panel/api/tunnel-config', { token: 'cf_' + 'B'.repeat(40), code: await code() });
  assert.equal(r.status, 400, 'Cloudflare reddetti');
  assert.match(r.data.error, /doğrulanamadı/);
  r = await panel('POST', '/panel/api/tunnel-config', { token: TOKEN, code: await code() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const row = db.prepare("SELECT value FROM settings WHERE name = 'cf_tunnel'").get();
  assert.ok(row && !row.value.includes(TOKEN), 'anahtar düz metin saklanmaz');
  const v = JSON.parse(row.value);
  assert.equal(v.account, ACC); assert.equal(v.zone, ZONE);
  const l = await panel('GET', '/panel/api/tunnels');
  assert.equal(l.data.ready, true);
  assert.ok(!JSON.stringify(l.data).includes(TOKEN));
});

let first;
await test('Eski lisans (Kitapseç): adres kurulur — tünel, localhost:<port> yönlendirmesi, DNS; token saklanmaz', async () => {
  const r = await api({ ...KS, a: 'tunnel_create', name: 'kitapsec', port: 8000, license: await legacy() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.hostname, 'kitapsec-pdks.ozkandemir.net');
  first = r.data.tunnel_id;
  assert.equal(r.data.token, 'TUNNEL-TOKEN-' + first);
  const t = cfState.tunnels.get(first);
  assert.deepEqual(t.config.ingress, [{ hostname: 'kitapsec-pdks.ozkandemir.net', service: 'http://localhost:8000', originRequest: {} }, { service: 'http_status:404' }]);
  const d = dnsByName('kitapsec-pdks.ozkandemir.net');
  assert.equal(d.type, 'CNAME'); assert.equal(d.content, `${first}.cfargotunnel.com`); assert.equal(d.proxied, true);
  const row = db.prepare('SELECT * FROM tunnels').get();
  assert.equal(row.owner, 'lic:NIS-KITAPSEC'); assert.equal(row.machine, 'ABCD-1111-2222-3333'); assert.equal(row.customer, 'Kitapseç');
  const dump = JSON.stringify(db.prepare('SELECT * FROM tunnels').all()) + JSON.stringify(db.prepare('SELECT * FROM tunnel_log').all());
  assert.ok(!dump.includes('TUNNEL-TOKEN'), 'tünel token\'ı veritabanında yok');
  assert.ok(dnsByName('ozkandemir.net'), 'alan adının MX kaydına dokunulmadı');
});

await test('Aynı sunucu yeniden isterse aynı tünel kullanılır; ad değişince eski DNS silinir', async () => {
  let r = await api({ ...KS, a: 'tunnel_create', name: 'kitapsec', port: 8000, license: await legacy() });
  assert.equal(r.data.tunnel_id, first);
  assert.equal(cfState.tunnels.size, 1);
  r = await api({ ...KS, a: 'tunnel_create', name: 'kitapsec2', port: 8100, license: await legacy() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.tunnel_id, first);
  assert.equal(dnsByName('kitapsec-pdks.ozkandemir.net'), undefined);
  assert.ok(dnsByName('kitapsec2-pdks.ozkandemir.net'));
  assert.equal(cfState.tunnels.get(first).config.ingress[0].service, 'http://localhost:8100');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tunnels').get().n, 1);
  r = await api({ ...KS, a: 'tunnel_create', name: 'kitapsec', port: 8000, license: await legacy() });
  assert.equal(r.status, 200);
});

await test('Ad kuralları: başka müşterinin adı 409, tünel olmayan DNS kaydı ezilmez, ayrılmış / geçersiz ad 400', async () => {
  const other = await legacy({ id: 'NIS-BASKA', customer: 'Başka A.Ş.' });
  let r = await api({ ...KS, machine: 'FFFF-0000-0000-0001', a: 'tunnel_create', name: 'kitapsec', port: 8000, license: other });
  assert.equal(r.status, 409); assert.match(r.data.error, /kullanımda/);
  r = await api({ ...KS, machine: 'FFFF-0000-0000-0001', a: 'tunnel_create', name: 'mail', port: 8000, license: other });
  assert.equal(r.status, 400, 'ayrılmış ad');
  const before = JSON.stringify(cfState.dns.get('www1'));
  db.exec("UPDATE tunnel_log SET at = 0");   // önceki denemeler günlük sınıra sayılmasın
  r = await api({ ...KS, machine: 'FFFF-0000-0000-0001', a: 'tunnel_create', name: 'mail2', port: 8000, license: other });
  assert.equal(r.status, 200, 'normal ad');
  // 'mail-pdks' adında tünel olmayan bir kayıt var: ezilmez (ad ayrılmış olmasa bile)
  db.prepare('DELETE FROM tunnels WHERE name = ?').run('mail2');
  cfState.dns.forEach((v, k) => { if (v.name === 'mail2-pdks.ozkandemir.net') cfState.dns.delete(k); });
  for (const bad of ['a', 'Kitap Seç', 'x--y', '-abc', 'çok-uzun-bir-ad-çok-uzun-bir-ad-x']) {
    assert.equal((await api({ ...KS, a: 'tunnel_create', name: bad, port: 8000, license: await legacy() })).status, 400, bad);
  }
  assert.equal(JSON.stringify(cfState.dns.get('www1')), before);
});

await test('Tünel olmayan mevcut DNS kaydının adı alınamaz', async () => {
  cfState.dns.set('own1', { id: 'own1', type: 'A', name: 'ofis-pdks.ozkandemir.net', content: '203.0.113.50' });
  const r = await api({ ...KS, machine: 'FFFF-0000-0000-0002', a: 'tunnel_create', name: 'ofis', port: 8000, license: await legacy({ id: 'NIS-UC', customer: 'Üç' }) });
  assert.equal(r.status, 409);
  assert.equal(cfState.dns.get('own1').content, '203.0.113.50');
});

await test('Lisans: süresi dolmuş eski lisans ve sahte lisans adres alamaz; günlük sınır', async () => {
  let r = await api({ ...KS, machine: 'EEEE-1', a: 'tunnel_create', name: 'eskimusteri', port: 8000, license: await legacy({ id: 'NIS-ESKI', customer: 'Eski', valid_until: '2020-01-01' }) });
  assert.equal(r.status, 403);
  const fake = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const p = new TextEncoder().encode(JSON.stringify({ v: 1, id: 'X', customer: 'X' }));
  const forged = ['-----BEGIN NIS PDKS LICENSE-----', b64(p), b64(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, fake.privateKey, p))), '-----END NIS PDKS LICENSE-----'].join('\n');
  assert.equal((await api({ ...KS, a: 'tunnel_create', name: 'sahte', port: 8000, license: forged })).status, 403);
  db.exec("DELETE FROM tunnel_log");
  const lic = await legacy({ id: 'NIS-SINIR', customer: 'Sınır' });
  for (let i = 0; i < 5; i++) assert.equal((await api({ ...KS, machine: 'SINIR-1', a: 'tunnel_create', name: 'sinir', port: 8000, license: lic })).status, 200);
  r = await api({ ...KS, machine: 'SINIR-1', a: 'tunnel_create', name: 'sinir', port: 8000, license: lic });
  assert.equal(r.status, 429);
});

await test('Kaldırma: yalnız kendi adresi; DNS ve tünel silinir', async () => {
  const lic = await legacy();
  let r = await api({ ...KS, a: 'tunnel_delete', hostname: 'baska-pdks.ozkandemir.net', tunnel_id: first, license: lic });
  assert.equal(r.status, 403);
  r = await api({ ...KS, machine: 'ZZZZ-9', a: 'tunnel_delete', hostname: 'kitapsec-pdks.ozkandemir.net', tunnel_id: first, license: lic });
  assert.equal(r.status, 200); assert.ok(cfState.tunnels.has(first), 'başka sunucu silemez');
  r = await api({ ...KS, a: 'tunnel_delete', hostname: 'kitapsec-pdks.ozkandemir.net', tunnel_id: first, license: lic });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(!cfState.tunnels.has(first));
  assert.equal(dnsByName('kitapsec-pdks.ozkandemir.net'), undefined);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tunnels WHERE owner = 'lic:NIS-KITAPSEC'").get().n, 0);
  assert.ok(dnsByName('ozkandemir.net') && cfState.dns.get('www1'), 'diğer DNS kayıtları yerinde');
});

await test('Panel lisansı: adres alınır; panelden kapatılır; lisans iptalinde adresler kapanır', async () => {
  const pid = db.prepare("SELECT id FROM programs WHERE slug = 'nis-pdks'").get().id;
  const T = Math.floor(Date.now() / 1000);
  db.prepare("INSERT INTO licenses (program_id, key_hash, key_enc, key_mask, customer, starts_at, ends_at, max_devices, status, created_at, updated_at) VALUES (?, 'h9', 'e9', 'NPDK-••', 'Panel Firma', ?, ?, 2, 'active', ?, ?)").run(pid, T - 10, T + 99 * 86400, T, T);
  const lid = db.prepare("SELECT id FROM licenses WHERE customer = 'Panel Firma'").get().id;
  const DEV = 'cd'.repeat(32);
  db.prepare('INSERT INTO activations (license_id, device_id, device_name, app_version, activated_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)').run(lid, DEV, 'SRV', 'V1.32.2', T, T);
  const odl = JSON.stringify({ token: await signPayload(env, { v: 1, typ: 'od-license', lid, product: 'NPDK', device: DEV, status: 'active', iat: T }) });
  let r = await api({ ...KS, a: 'tunnel_create', name: 'panelfirma', port: 8000, odl });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let l = await panel('GET', '/panel/api/tunnels');
  const t = l.data.list.find((x) => x.hostname === 'panelfirma-pdks.ozkandemir.net');
  assert.equal(t.license_id, lid); assert.equal(t.legacy, false);
  assert.equal((await panel('POST', `/panel/api/tunnels/${t.id}/close`, {})).status, 200);
  assert.ok(!dnsByName('panelfirma-pdks.ozkandemir.net'));
  r = await api({ ...KS, a: 'tunnel_create', name: 'panelfirma', port: 8000, odl });
  assert.equal(r.status, 200);
  const rev = await panel('POST', `/panel/api/licenses/${lid}/revoke`, {});
  assert.equal(rev.status, 200, JSON.stringify(rev.data));
  assert.ok(!dnsByName('panelfirma-pdks.ozkandemir.net'), 'iptalde adres kapandı');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tunnels WHERE license_id = ?').get(lid).n, 0);
  assert.equal((await api({ ...KS, a: 'tunnel_create', name: 'panelfirma', port: 8000, odl })).status, 403, 'iptal edilmiş lisans');
});

await test('Cloudflare geçici hatası programa anlaşılır mesajla döner; kayıt yarım kalmaz', async () => {
  cfState.fail = (m, p) => m === 'POST' && p.endsWith('/dns_records');
  const before = cfState.tunnels.size;
  const r = await api({ ...KS, machine: 'HATA-1', a: 'tunnel_create', name: 'hatadeneme', port: 8000, license: await legacy({ id: 'NIS-HATA', customer: 'Hata' }) });
  cfState.fail = null;
  assert.equal(r.status, 502); assert.equal(r.data.ok, false); assert.match(r.data.error, /Cloudflare/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tunnels WHERE name = 'hatadeneme'").get().n, 0);
  assert.equal(cfState.tunnels.size, before, 'yarım kalan tünel Cloudflare\'den silindi');
  const again = await api({ ...KS, machine: 'HATA-1', a: 'tunnel_create', name: 'hatadeneme', port: 8000, license: await legacy({ id: 'NIS-HATA', customer: 'Hata' }) });
  assert.equal(again.status, 200, 'tekrar denemede tamamlanır');
});

console.log(`\n${passed} test geçti.`);
