// ozkandemir.net V3.6 — Online lisans testleri
// Çalıştır: node tests/test-license.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createD1, createR2, createAssets } from './helpers/cf-local.mjs';
import * as S from '../src/panel/security.js';
import { normalizeKey, generateKey, verifyToken, LIC } from '../src/panel/license.js';
import { buildAdminSetup } from '../scripts/setup-lib.mjs';
import { buildSigningKey } from '../scripts/setup-lib.mjs';
import worker from '../src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); passed++; out.push('  ✓ ' + name); }
  catch (e) { out.push('  ✗ ' + name + '\n    ' + (e && e.stack || e)); console.log(out.join('\n')); process.exit(1); }
}

let clock = Date.now();
const realNow = Date.now;
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
const SECRET = S.base32Decode(setup.secret);
const ORIGIN = 'https://ozkandemir.net';

function client(ip = '203.0.113.10') {
  const jar = {};
  return {
    async req(method, p, { body, headers = {}, panel = true, raw = false } = {}) {
      const h = new Headers({ 'cf-connecting-ip': ip, 'user-agent': 'Test', ...headers });
      if (panel && method !== 'GET') { h.set('x-od-panel', '1'); h.set('origin', ORIGIN); }
      const ck = Object.entries(jar).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');
      if (ck) h.set('cookie', ck);
      if (body !== undefined) h.set('content-type', 'application/json');
      const res = await worker.fetch(new Request(ORIGIN + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
      for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
      if (raw) return res;
      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data };
    },
  };
}

const adminRaw = client();
async function adminLogin() {
  const r1 = await adminRaw.req('POST', '/panel/api/login', { body: { email: EMAIL, password: PASS } });
  tick(31); // her girişte yeni TOTP adımı (aynı kod iki kez kabul edilmez)
  const r2 = await adminRaw.req('POST', '/panel/api/verify', { body: { challenge: r1.data.challenge, code: await S.hotp(SECRET, Math.floor(S.now() / 30)) } });
  assert.equal(r2.status, 200, JSON.stringify(r2.data));
}
await adminLogin();
// Süre ileri sarıldığında panel oturumu (30 dk hareketsizlik) kapanır; yeniden giriş yap
const admin = {
  async req(...a) {
    let r = await adminRaw.req(...a);
    if (r.status === 401 && r.data && r.data.restart) { await adminLogin(); r = await adminRaw.req(...a); }
    return r;
  },
};
const program = (prefix) => (async () => (await admin.req('GET', '/panel/api/license-products')).data.products.find((p) => p.prefix === prefix))();
const app = (ip = '198.51.100.20') => client(ip);
const dev = (n) => (n.toString(16).padStart(2, '0')).repeat(32); // 64 hex
const api = (c, p, body) => c.req('POST', '/lisans/api/' + p, { body, panel: false });

// ================= Anahtar =================
await test('Anahtar biçimi: ön ek + 4×4 Crockford, okuma hatalarına toleranslı', () => {
  const k = generateKey('NPDK');
  assert.match(k, /^NPDK-[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
  assert.equal(normalizeKey(k.toLowerCase().replace(/-/g, '')), k);
  assert.equal(normalizeKey('npdk 7k2q m9xd 4tre h8wc'), 'NPDK-7K2Q-M9XD-4TRE-H8WC');
  assert.equal(normalizeKey('NPDK-7K2Q-M9XD-4TRE-H8WO'), 'NPDK-7K2Q-M9XD-4TRE-H8W0', 'O → 0');
  assert.equal(normalizeKey('XXXX-7K2Q-M9XD-4TRE-H8WC'), null, 'bilinmeyen ön ek');
  assert.equal(normalizeKey('NPDK-7K2Q'), null);
  const set = new Set(Array.from({ length: 2000 }, () => generateKey('C360')));
  assert.equal(set.size, 2000);
});

// ================= Panel =================
let lic1;
await test('6 lisanslanabilir program ve ön ekleri', async () => {
  const r = await admin.req('GET', '/panel/api/license-products');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.products.map((p) => p.prefix).sort(), ['BNKX', 'C360', 'CRMT', 'IZIN', 'NPDK', 'SATD']);
  assert.match(r.data.defaults.starts, /^\d{4}-\d{2}-\d{2}$/);
});

await test('Lisans oluşturma doğrulamaları', async () => {
  const p = await program('NPDK');
  const base = { programId: p.programId, customer: 'Örnek Şirket A.Ş.' };
  assert.equal((await admin.req('POST', '/panel/api/licenses', { body: { ...base, customer: 'x' } })).status, 400);
  assert.equal((await admin.req('POST', '/panel/api/licenses', { body: { ...base, email: 'bozuk' } })).status, 400);
  assert.equal((await admin.req('POST', '/panel/api/licenses', { body: { ...base, maxDevices: 0 } })).status, 400);
  assert.equal((await admin.req('POST', '/panel/api/licenses', { body: { ...base, starts: '2026-10-10', ends: '2026-10-01' } })).status, 400);
  assert.equal((await admin.req('POST', '/panel/api/licenses', { body: { ...base, ends: '2026-02-30' } })).status, 400);
  assert.equal((await admin.req('POST', '/panel/api/licenses', { body: { ...base, limits: { personel: -5 } } })).status, 400);
  const np = await admin.req('POST', '/panel/api/programs', { body: { name: 'Deneme Programı' } });
  assert.equal((await admin.req('POST', '/panel/api/licenses', { body: { ...base, programId: np.data.id } })).status, 400, 'tanımsız ürün');
  assert.equal((await client('203.0.113.99').req('POST', '/panel/api/licenses', { body: base })).status, 401, 'oturumsuz');
});

await test('NİS PDKS lisansı: 1 cihaz, 150 personel, 3 şube; anahtar veritabanında açık durmaz', async () => {
  const p = await program('NPDK');
  const r = await admin.req('POST', '/panel/api/licenses', { body: {
    programId: p.programId, customer: 'Örnek Şirket A.Ş.', email: 'yetkili@ornek.com.tr', phone: '0555 000 00 00',
    maxDevices: 1, limits: { personel: 150, sube: 3 }, modules: ['mobil', 'push', 'olmayan_modul'], withDownload: true,
  } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  lic1 = r.data;
  assert.match(lic1.key, /^NPDK-/);
  assert.deepEqual(lic1.modules, ['mobil', 'push']);
  assert.equal(lic1.download, null, 'yüklü sürüm yokken indirme linki üretilmez');
  const dump = JSON.stringify(env.DB._db.prepare('SELECT * FROM licenses').all());
  assert.ok(!dump.includes(lic1.key), 'tam anahtar düz metin saklanmamalı');
  assert.ok(!dump.includes(lic1.key.slice(10, 19)), 'anahtarın orta kısmı da görünmemeli');
  const d = await admin.req('GET', `/panel/api/licenses/${lic1.id}`);
  assert.equal(d.data.key, lic1.key, 'panelde anahtar yeniden gösterilebilir');
  assert.equal(d.data.state, 'waiting');
});

await test('Varsayılan süre tam bir yıl (08.10.2026 → 07.10.2027 gibi)', async () => {
  const p = await program('IZIN');
  const r = await admin.req('POST', '/panel/api/licenses', { body: { programId: p.programId, customer: 'Cari B Ltd.', starts: '2026-10-08' } });
  assert.equal(r.data.starts, '08.10.2026');
  assert.equal(r.data.ends, '07.10.2027');
});

// ================= Müşteri programı API'si =================
let token1;
await test('Açık anahtar uç noktası', async () => {
  const r = await app().req('GET', '/lisans/api/public-key', { panel: false });
  assert.equal(r.status, 200);
  assert.equal(r.data.x, signing.publicX);
  assert.equal(r.data.check_every_days, 7);
  assert.equal(r.data.offline_grace_days, 30);
});

await test('Etkinleştirme: geçersiz anahtar, yanlış program', async () => {
  const c = app();
  const bad = await api(c, 'activate', { key: 'NPDK-0000-0000-0000-0000', device_id: dev(1), product: 'NPDK' });
  assert.equal(bad.status, 404); assert.equal(bad.data.code, 'invalid_key');
  const wrong = await api(c, 'activate', { key: lic1.key, device_id: dev(1), product: 'BNKX' });
  assert.equal(wrong.status, 400); assert.equal(wrong.data.code, 'wrong_product');
  assert.equal((await api(c, 'activate', { key: lic1.key, device_id: 'kisa' })).status, 400);
});

await test('Etkinleştirme başarılı: imzalı lisans, cihaza bağlı, 7/30 gün kuralı', async () => {
  const r = await api(app(), 'activate', { key: lic1.key.toLowerCase(), device_id: dev(1), device_name: 'SRV-MERKEZ', os: 'Windows Server 2022', app_version: '2.0.0', product: 'NPDK', usage: { personel: 112 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  token1 = r.data.token;
  const p = await verifyToken(signing.publicX, token1);
  assert.ok(p, 'imza doğrulanmalı');
  assert.equal(p.device, dev(1));
  assert.equal(p.status, 'active');
  assert.equal(p.product, 'NPDK');
  assert.equal(p.customer, 'Örnek Şirket A.Ş.');
  assert.deepEqual(p.limits, { personel: 150, sube: 3 });
  assert.equal(p.check_after - p.iat, 7 * 86400);
  assert.equal(p.valid_until - p.iat, 30 * 86400);
  assert.equal(r.data.license.expires, lic1.ends);
});

await test('İmza sahteciliği: değiştirilmiş lisans veya başka anahtar reddedilir', async () => {
  const [tag, body, sig] = token1.split('.');
  const p = JSON.parse(new TextDecoder().decode(S.unb64url(body)));
  p.limits.personel = 99999; p.expires += 10 * 365 * 86400;
  const forged = `${tag}.${S.b64url(new TextEncoder().encode(JSON.stringify(p)))}.${sig}`;
  assert.equal(await verifyToken(signing.publicX, forged), null);
  const other = await buildSigningKey();
  assert.equal(await verifyToken(other.publicX, token1), null);
});

await test('Cihaz sınırı: 2. sunucu reddedilir ve geçmişe "Uyarı" düşer', async () => {
  const r = await api(app('198.51.100.30'), 'activate', { key: lic1.key, device_id: dev(2), device_name: 'SRV-YEDEK', product: 'NPDK' });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'device_limit');
  const again = await api(app(), 'activate', { key: lic1.key, device_id: dev(1), device_name: 'SRV-MERKEZ', product: 'NPDK' });
  assert.equal(again.status, 200, 'aynı cihaz yeniden etkinleştirebilir');
  const d = await admin.req('GET', `/panel/api/licenses/${lic1.id}`);
  assert.ok(d.data.events.some((e) => e.type === 'Uyarı' && e.detail.includes('SRV-YEDEK')));
});

await test('Haftalık doğrulama: kullanım bilgisi panele yansır; kayıtsız cihaz kilit alır', async () => {
  tick(7 * 86400);
  const r = await api(app(), 'check', { key: lic1.key, device_id: dev(1), device_name: 'SRV-MERKEZ', app_version: '2.0.1', product: 'NPDK', usage: { personel: 118 } });
  assert.equal(r.status, 200);
  const d = await admin.req('GET', `/panel/api/licenses/${lic1.id}`);
  assert.equal(d.data.devices[0].version, '2.0.1');
  assert.equal(d.data.devices[0].usage.personel, 118);
  assert.equal(d.data.state, 'active');
  const stranger = await api(app(), 'check', { key: lic1.key, device_id: dev(9), product: 'NPDK' });
  assert.equal(stranger.status, 403);
  assert.equal(stranger.data.code, 'device_removed');
  const lock = await verifyToken(signing.publicX, stranger.data.token);
  assert.equal(lock.status, 'device_removed');
  assert.equal(lock.valid_until, lock.iat, 'kilit belgesi hemen geçersiz');
});

await test('Cihazı kaldır: eski sunucu kilitlenir, yeni sunucu etkinleşir', async () => {
  const d = await admin.req('GET', `/panel/api/licenses/${lic1.id}`);
  const rm = await admin.req('POST', `/panel/api/licenses/${lic1.id}/devices/${d.data.devices[0].id}/remove`, { body: {} });
  assert.equal(rm.status, 200);
  const old = await api(app(), 'check', { key: lic1.key, device_id: dev(1), product: 'NPDK' });
  assert.equal(old.data.code, 'device_removed');
  const neu = await api(app(), 'activate', { key: lic1.key, device_id: dev(2), device_name: 'SRV-YENI', product: 'NPDK' });
  assert.equal(neu.status, 200);
});

await test('Askıya al → program kilitlenir; yeniden aç → çalışır', async () => {
  assert.equal((await admin.req('POST', `/panel/api/licenses/${lic1.id}/suspend`, { body: {} })).status, 200);
  const r = await api(app(), 'check', { key: lic1.key, device_id: dev(2), product: 'NPDK' });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'suspended');
  assert.equal((await verifyToken(signing.publicX, r.data.token)).status, 'suspended');
  const act = await api(app(), 'activate', { key: lic1.key, device_id: dev(3), product: 'NPDK' });
  assert.equal(act.data.code, 'suspended', 'askıdayken yeni etkinleştirme de olmaz');
  assert.equal((await admin.req('POST', `/panel/api/licenses/${lic1.id}/resume`, { body: {} })).status, 200);
  assert.equal((await api(app(), 'check', { key: lic1.key, device_id: dev(2), product: 'NPDK' })).status, 200);
});

await test('Süre uzatma: geri tarih reddedilir, yeni bitiş lisansa yansır', async () => {
  const d = await admin.req('GET', `/panel/api/licenses/${lic1.id}`);
  assert.equal((await admin.req('POST', `/panel/api/licenses/${lic1.id}/extend`, { body: { ends: d.data.startsIso } })).status, 400);
  const e = await admin.req('POST', `/panel/api/licenses/${lic1.id}/extend`, { body: { ends: d.data.nextYearIso } });
  assert.equal(e.status, 200);
  const r = await api(app(), 'check', { key: lic1.key, device_id: dev(2), product: 'NPDK' });
  const p = await verifyToken(signing.publicX, r.data.token);
  assert.equal(new Date((p.expires + 3 * 3600) * 1000).toISOString().slice(0, 10), d.data.nextYearIso);
});

await test('Koşulları düzenle: personel sınırı yeni lisansta görünür', async () => {
  const u = await admin.req('POST', `/panel/api/licenses/${lic1.id}/update`, { body: { limits: { personel: 200 }, maxDevices: 2 } });
  assert.equal(u.status, 200);
  const r = await api(app(), 'check', { key: lic1.key, device_id: dev(2), product: 'NPDK' });
  const p = await verifyToken(signing.publicX, r.data.token);
  assert.equal(p.limits.personel, 200);
  assert.equal(p.limits.sube, 3, 'değiştirilmeyen sınır korunur');
  assert.equal((await api(app(), 'activate', { key: lic1.key, device_id: dev(4), product: 'NPDK' })).status, 200, 'cihaz sınırı 2 oldu');
});

await test('Süresi biten lisans: kilit; geçerlilik hiçbir zaman bitişi aşmaz', async () => {
  const p = await program('SATD');
  const today = new Date((S.now() + 3 * 3600) * 1000).toISOString().slice(0, 10);
  const in10 = new Date((S.now() + 3 * 3600 + 10 * 86400) * 1000).toISOString().slice(0, 10);
  const l = await admin.req('POST', '/panel/api/licenses', { body: { programId: p.programId, customer: 'Örnek Lojistik', starts: today, ends: in10 } });
  const r = await api(app(), 'activate', { key: l.data.key, device_id: dev(5), product: 'SATD' });
  const tok = await verifyToken(signing.publicX, r.data.token);
  assert.ok(tok.valid_until <= tok.expires, '30 günlük tolerans bitiş tarihini aşmamalı');
  const list = await admin.req('GET', '/panel/api/licenses');
  assert.equal(list.data.licenses.find((x) => x.id === l.data.id).state, 'expiring');
  tick(11 * 86400);
  const exp = await api(app(), 'check', { key: l.data.key, device_id: dev(5), product: 'SATD' });
  assert.equal(exp.status, 403);
  assert.equal(exp.data.code, 'expired');
});

await test('İptal kalıcıdır', async () => {
  const p = await program('CRMT');
  const l = await admin.req('POST', '/panel/api/licenses', { body: { programId: p.programId, customer: 'Cari F Otomotiv' } });
  await api(app(), 'activate', { key: l.data.key, device_id: dev(6), product: 'CRMT' });
  assert.equal((await admin.req('POST', `/panel/api/licenses/${l.data.id}/revoke`, { body: {} })).status, 200);
  assert.equal((await api(app(), 'check', { key: l.data.key, device_id: dev(6), product: 'CRMT' })).data.code, 'revoked');
  assert.equal((await admin.req('POST', `/panel/api/licenses/${l.data.id}/resume`, { body: {} })).status, 400);
  assert.equal((await admin.req('POST', `/panel/api/licenses/${l.data.id}/extend`, { body: { ends: '2030-01-01' } })).status, 400);
});

let offlineLic;
await test('Çevrimdışı etkinleştirme: istek kodu → panelden imzalı lisans kodu (bitişe kadar geçerli)', async () => {
  const p = await program('BNKX');
  offlineLic = (await admin.req('POST', '/panel/api/licenses', { body: { programId: p.programId, customer: 'Cari D İnşaat', limits: { firma: 2, banka_hesap: 12 } } })).data;
  const reqCode = 'ODR1.' + S.b64url(new TextEncoder().encode(JSON.stringify({ k: offlineLic.key, d: dev(7), n: 'MUHASEBE-PC', o: 'Windows 11', v: '5.20.14', p: 'BNKX' })));
  const bad = await admin.req('POST', `/panel/api/licenses/${lic1.id}/offline`, { body: { request: reqCode } });
  assert.equal(bad.status, 400, 'başka lisansın istek kodu reddedilmeli');
  const r = await admin.req('POST', `/panel/api/licenses/${offlineLic.id}/offline`, { body: { request: reqCode } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const tok = await verifyToken(signing.publicX, r.data.token);
  assert.equal(tok.offline, true);
  assert.equal(tok.device, dev(7));
  assert.equal(tok.valid_until, tok.expires);
  assert.deepEqual(tok.limits, { firma: 2, banka_hesap: 12 });
});

await test('Lisans listesi: filtreler, durumlar ve özet', async () => {
  const all = await admin.req('GET', '/panel/api/licenses');
  assert.ok(all.data.total >= 5);
  const s = all.data.stats;
  assert.ok(s.active >= 3);
  assert.ok(s.checks24h >= 1);
  const np = await program('NPDK');
  const only = await admin.req('GET', `/panel/api/licenses?program=${np.programId}`);
  assert.ok(only.data.licenses.every((l) => l.prefix === 'NPDK'));
  const q = await admin.req('GET', '/panel/api/licenses?q=' + encodeURIComponent('örnek şirket'));
  assert.ok(q.data.licenses.length >= 1);
  const rev = await admin.req('GET', '/panel/api/licenses?status=revoked');
  assert.ok(rev.data.licenses.every((l) => l.state === 'revoked') && rev.data.licenses.length === 1);
  assert.ok(all.data.licenses.every((l) => /••••-••••/.test(l.key)), 'listede anahtar maskeli');
});


await test('Paralel saldırı: aynı anda 10 farklı cihazdan etkinleştirme cihaz sınırını aşamaz', async () => {
  const p = await program('SATD');
  const l = (await admin.req('POST', '/panel/api/licenses', { body: { programId: p.programId, customer: 'Paralel Test', maxDevices: 2 } })).data;
  const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => api(app('198.51.100.' + (150 + i)), 'activate', { key: l.key, device_id: dev(100 + i), product: 'SATD' })));
  assert.equal(rs.filter((r) => r.status === 200).length, 2);
  assert.equal(rs.filter((r) => r.status === 409).length, 8);
  const same = await Promise.all([1, 2, 3].map(() => api(app(), 'activate', { key: l.key, device_id: dev(100), product: 'SATD' })));
  assert.ok(same.every((r) => r.status === 200 || r.status === 409), 'aynı cihazın paralel isteği 500 vermemeli');
});

await test('Geçersiz başlangıç tarihi 400 döner (500 değil)', async () => {
  const p = await program('SATD');
  assert.equal((await admin.req('POST', '/panel/api/licenses', { body: { programId: p.programId, customer: 'Tarih Test', starts: 'x' } })).status, 400);
});

await test('Kaba kuvvet koruması: 20 geçersiz anahtardan sonra IP 1 saat kilitlenir', async () => {
  const c = app('192.0.2.200');
  let last;
  for (let i = 0; i < LIC.FAIL_MAX; i++) last = await api(c, 'check', { key: generateKey('NPDK'), device_id: dev(8), product: 'NPDK' });
  const blocked = await api(c, 'check', { key: lic1.key, device_id: dev(2), product: 'NPDK' });
  assert.equal(blocked.status, 429);
  assert.equal((await api(app('192.0.2.201'), 'check', { key: lic1.key, device_id: dev(2), product: 'NPDK' })).status, 200, 'başka IP etkilenmez');
  tick(LIC.FAIL_LOCK + 1);
  assert.equal((await api(c, 'check', { key: lic1.key, device_id: dev(2), product: 'NPDK' })).status, 200);
});

await test('Cloudflare Access açıkken lisans API dışarıdan erişilebilir kalır', async () => {
  env.ACCESS_TEAM_DOMAIN = 'x.cloudflareaccess.com'; env.ACCESS_AUD = 'AUD';
  try {
    assert.equal((await app().req('GET', '/lisans/api/public-key', { panel: false })).status, 200);
    assert.equal((await admin.req('GET', '/panel/api/licenses')).status, 403, 'panel API Access ister');
  } finally { delete env.ACCESS_TEAM_DOMAIN; delete env.ACCESS_AUD; }
});

await test('İmza anahtarı yoksa anlaşılır hata', async () => {
  const saved = env.LICENSE_SIGNING_KEY;
  delete env.LICENSE_SIGNING_KEY;
  try {
    const r = await api(app(), 'activate', { key: lic1.key, device_id: dev(2), product: 'NPDK' });
    assert.equal(r.status, 503);
  } finally { env.LICENSE_SIGNING_KEY = saved; }
});

// ================= Python istemcisi ile uçtan uca =================
const py = spawnSync('python3', ['--version']);
if (py.status === 0) {
  clock = realNow(); // Python gerçek saati kullanır
  const http = await import('node:http');
  const srv = http.createServer(async (q, res) => {
    const chunks = []; for await (const ch of q) chunks.push(ch);
    const h = new Headers(); for (const [k, v] of Object.entries(q.headers)) h.set(k, String(v)); h.set('cf-connecting-ip', '127.0.0.9');
    const r = await worker.fetch(new Request('https://ozkandemir.net' + q.url, { method: q.method, headers: h, body: chunks.length ? Buffer.concat(chunks) : undefined }), env);
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' }); res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((ok) => srv.listen(0, ok));
  const port = srv.address().port;
  const { execFile } = await import('node:child_process');
  const pyEnv = { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', HTTP_PROXY: '', http_proxy: '' };
  const pyExec = (args) => new Promise((ok) => execFile('python3', args, { encoding: 'utf8', timeout: 120000, env: pyEnv }, (err, stdout, stderr) => ok({ status: err ? (err.code ?? 1) : 0, stdout, stderr })));
  const pyRun = async (code) => {
    const res = await pyExec(['-I', '-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'lisans-istemcisi/python'))})\nimport odlisans\n` + code]);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    return JSON.parse(res.stdout.trim().split('\n').pop());
  };
  const tmp = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'odl-'));
  pyEnv.HOME = tmp; pyEnv.USERPROFILE = tmp; // ikinci kayıt yeri testte geçici klasöre yazılsın
  const mk = (dir, devHex) => `c = odlisans.LicenseClient("CRMT", ${JSON.stringify(signing.publicX)}, "3.1.0", data_dir=${JSON.stringify(path.join(tmp, dir))}, server="http://127.0.0.1:${port}", usage_provider=lambda: {"firma": 1})\n${devHex ? `c.device_id = "${devHex}"\n` : ''}`;
  const p = await program('CRMT');
  const L = (await admin.req('POST', '/panel/api/licenses', { body: { programId: p.programId, customer: 'Cari C Gıda', limits: { firma: 2 } } })).data;

  await test('Python: etkinleştir → lisans etkin, sınırlar ve modüller okunur', async () => {
    const r = await pyRun(mk('a') + `st = c.activate(${JSON.stringify(L.key.toLowerCase().replace(/-/g, ' '))})\nst2 = c.state()\nprint(json.dumps({"ok": st2.ok, "customer": st2.customer, "firma": st2.limit("firma"), "mod": st2.has_module("eposta"), "exp": st2.expires}))`);
    assert.deepEqual(r, { ok: true, customer: 'Cari C Gıda', firma: 2, mod: true, exp: L.ends });
  });
  await test('Python: yanlış ürün anahtarı ve geçersiz anahtar anlaşılır hata verir', async () => {
    const r = await pyRun(mk('b') + `out = {}\nfor k in [${JSON.stringify(lic1.key)}, "CRMT-0000-0000-0000-0000"]:\n    try:\n        c.activate(k)\n    except odlisans.LicenseError as e:\n        out[e.code] = e.message\nprint(json.dumps(out, ensure_ascii=False))`);
    assert.ok(r.wrong_product.includes('NİS PDKS'));
    assert.ok(r.invalid_key);
  });
  await test('Python: lisans dosyası kurcalanırsa veya başka bilgisayara kopyalanırsa kilitlenir', async () => {
    const r = await pyRun(mk('a') + `import os, shutil\nd = json.load(open(c.path, encoding="utf-8"))\nparts = d["token"].split(".")\npl = json.loads(odlisans._b64url_decode(parts[1]))\npl["limits"]["firma"] = 999\nd2 = dict(d, token=parts[0] + "." + odlisans._b64url_encode(json.dumps(pl).encode()) + "." + parts[2])\nos.makedirs(${JSON.stringify(path.join(tmp, 'kurcala'))}, exist_ok=True)\njson.dump(d2, open(${JSON.stringify(path.join(tmp, 'kurcala', 'lisans.json'))}, "w"))\nshutil.copytree(${JSON.stringify(path.join(tmp, 'a'))}, ${JSON.stringify(path.join(tmp, 'kopya'))})\nt = odlisans.LicenseClient("CRMT", ${JSON.stringify(signing.publicX)}, data_dir=${JSON.stringify(path.join(tmp, 'kurcala'))}, server="http://127.0.0.1:${port}")\nk = odlisans.LicenseClient("CRMT", ${JSON.stringify(signing.publicX)}, data_dir=${JSON.stringify(path.join(tmp, 'kopya'))}, server="http://127.0.0.1:${port}")\nk.device_id = "ab" * 32\nprint(json.dumps({"tamper": t.state(online=False).code, "copy": k.state(online=False).code}))`);
    assert.deepEqual(r, { tamper: 'invalid', copy: 'invalid' });
  });
  await test('Python: eski lisans dosyası geri yüklenirse kilitlenir', async () => {
    await pyRun(mk('a') + `import shutil\nshutil.copy(c.path, c.path + ".eski")\nprint(json.dumps({"ok": True}))`);
    tick(120);
    const r = await pyRun(mk('a') + `import shutil\nst = c.check_now()\nshutil.copy(c.path + ".eski", c.path)\nprint(json.dumps({"after": st.code, "restored": c.state(online=False).code}))`);
    assert.deepEqual(r, { after: 'active', restored: 'restored' });
    await pyRun(mk('a') + `st = c.check_now()\nprint(json.dumps({"code": st.code}))`); // güncel lisansı geri al
  });
  await test('Python: saat geri alınırsa kilitlenir', async () => {
    const r = await pyRun(mk('a') + `import time\nreal = time.time\ntime.time = lambda: real() - 3 * 86400\nprint(json.dumps({"code": c.state(online=False).code}))`);
    assert.equal(r.code, 'tampered');
  });
  await test('Python: 7 gün sonra çevrimiçi doğrular; askıya alınınca kilitlenir; açılınca çalışır', async () => {
    assert.equal((await admin.req('POST', `/panel/api/licenses/${L.id}/suspend`, { body: {} })).status, 200);
    const later = `import time\nreal = time.time\ntime.time = lambda: real() + 8 * 86400\n`;
    const r1 = await pyRun(mk('a') + later + `st = c.state()\nprint(json.dumps({"ok": st.ok, "code": st.code}))`);
    assert.deepEqual(r1, { ok: false, code: 'suspended' });
    assert.equal((await admin.req('POST', `/panel/api/licenses/${L.id}/resume`, { body: {} })).status, 200);
    const r2 = await pyRun(mk('a') + later + `st = c.check_now()\nprint(json.dumps({"ok": st.ok}))`);
    assert.deepEqual(r2, { ok: true });
    const d = await admin.req('GET', `/panel/api/licenses/${L.id}`);
    assert.equal(d.data.devices[0].version, '3.1.0');
    assert.equal(d.data.devices[0].usage.firma, 1);
  });
  await test('Python: internet yokken 30 gün çalışır, sonra kilitlenir', async () => {
    const r = await pyRun(mk('a') + `c.server = "http://127.0.0.1:1"\nimport time\nbase = odlisans.verify_token(c.public_key, json.load(open(c.path, encoding="utf-8"))["token"])["iat"]\nout = {}\nfor gun in (10, 29, 31):\n    time.time = lambda g=gun: base + g * 86400\n    c.CHECK_RETRY = 0\n    out[str(gun)] = c.state().code\nprint(json.dumps(out))`);
    assert.deepEqual(r, { 10: 'active', 29: 'active', 31: 'offline_too_long' });
  });
  await test('Python: çevrimdışı etkinleştirme (istek kodu → panel → lisans kodu)', async () => {
    const r1 = await pyRun(mk('off', 'cd'.repeat(32)) + `print(json.dumps({"req": c.offline_request_code(${JSON.stringify(L.key)})}))`);
    const resp = await admin.req('POST', `/panel/api/licenses/${L.id}/offline`, { body: { request: r1.req } });
    assert.equal(resp.status, 409, 'cihaz sınırı (1) dolu olduğundan reddedilmeli');
    await admin.req('POST', `/panel/api/licenses/${L.id}/update`, { body: { maxDevices: 2 } });
    const ok = await admin.req('POST', `/panel/api/licenses/${L.id}/offline`, { body: { request: r1.req } });
    assert.equal(ok.status, 200);
    const r2 = await pyRun(mk('off', 'cd'.repeat(32)) + `c.server = "http://127.0.0.1:1"\nst = c.install_offline_token(${JSON.stringify(ok.data.token)})\nimport time\nreal = time.time\ntime.time = lambda: real() + 60 * 86400\nc.CHECK_RETRY = 0\nst2 = c.state()\nprint(json.dumps({"ok": st.ok, "later": st2.ok}))`);
    assert.deepEqual(r2, { ok: true, later: true }, 'çevrimdışı lisans internetsiz bitişe kadar çalışır');
  });
  await test('Python: komut satırı aracı (destek için)', async () => {
    const base = ['-I', path.join(ROOT, 'lisans-istemcisi/python/odlisans.py'), '--product', 'CRMT', '--public-key', signing.publicX, '--server', `http://127.0.0.1:${port}`, '--data-dir', path.join(tmp, 'cli')];
    const none = await pyExec([...base, 'status']);
    assert.equal(none.status, 1);
    assert.equal(JSON.parse(none.stdout).code, 'no_license');
    const dv = await pyExec([...base, 'device']);
    assert.equal(dv.status, 0);
    assert.match(JSON.parse(dv.stdout).device_id, /^[a-f0-9]{64}$/);
  });
  srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

Date.now = realNow;
console.log(out.join('\n'));
console.log(`license tests: OK (${passed} test)`);
