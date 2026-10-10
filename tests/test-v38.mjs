// ozkandemir.net V3.8 — Güncelleme dağıtımı, bordro parametreleri, kaynak takibi, yenileme takibi, Cloudflare kurulumu
// Çalıştır: node tests/test-v38.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createD1, createR2, createAssets } from './helpers/cf-local.mjs';
import * as S from '../src/panel/security.js';
import { verifyToken } from '../src/panel/license.js';
import { compareVersions } from '../src/panel/guncelleme.js';
import { cleanBase, buildPayroll, baseFromPayroll } from '../src/panel/bordro.js';
import { findMatches, runWatch, trLower } from '../src/panel/watch.js';
import { clearPayrollCache } from '../src/panel/parametre.js';
import { clearAccessCache } from '../src/panel/cfsetup.js';
import { buildAdminSetup, buildSigningKey } from '../scripts/setup-lib.mjs';
import { DEFAULT_BASE } from '../scripts/pdks-parametreler.mjs';
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
  DB: createD1(schema), FILES: createR2({ minPartSize: 1 }), ASSETS: createAssets(path.join(ROOT, 'public')),
  PANEL_ENC_KEY: setup.encKey, LICENSE_SIGNING_KEY: signing.secret,
};
await env.DB.exec(setup.sql);
const SECRET = S.base32Decode(setup.secret);
const ORIGIN = 'https://ozkandemir.net';
const totp = async () => { tick(31); return S.hotp(SECRET, Math.floor(S.now() / 30)); };

function client(ip = '203.0.113.10', e = env) {
  const jar = {};
  return {
    async req(method, p, { body, headers = {}, panel = true, raw = false, useEnv } = {}) {
      const h = new Headers({ 'cf-connecting-ip': ip, 'user-agent': 'Test', ...headers });
      if (panel && method !== 'GET') { h.set('x-od-panel', '1'); h.set('origin', ORIGIN); }
      const ck = Object.entries(jar).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');
      if (ck) h.set('cookie', ck);
      let b;
      if (body instanceof Uint8Array) { b = body; h.set('content-type', 'application/octet-stream'); }
      else if (body !== undefined) { b = JSON.stringify(body); h.set('content-type', 'application/json'); }
      const res = await worker.fetch(new Request(ORIGIN + p, { method, headers: h, body: b }), useEnv || e);
      for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
      if (raw) return res;
      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data, headers: res.headers };
    },
  };
}
const adminRaw = client();
async function adminLogin() {
  const r1 = await adminRaw.req('POST', '/panel/api/login', { body: { email: EMAIL, password: PASS } });
  const r2 = await adminRaw.req('POST', '/panel/api/verify', { body: { challenge: r1.data.challenge, code: await totp() } });
  assert.equal(r2.status, 200, JSON.stringify(r2.data));
}
await adminLogin();
const admin = {
  async req(...a) {
    let r = await adminRaw.req(...a);
    if (r.status === 401 && r.data && r.data.restart) { await adminLogin(); r = await adminRaw.req(...a); }
    return r;
  },
};

async function upload(programId, version, bytes) {
  const s = await admin.req('POST', '/panel/api/uploads', { body: { programId, version, filename: `kurulum-${version}.zip`, size: bytes.length } });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  const p = await admin.req('PUT', `/panel/api/uploads/${s.data.versionId}/parts/1`, { body: bytes });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const c = await admin.req('POST', `/panel/api/uploads/${s.data.versionId}/complete`, { body: { parts: [p.data], sha256: sha } });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  return { id: s.data.versionId, sha };
}

// ================= Güncelleme dağıtımı =================
console.log('Güncelleme dağıtımı');
await test('Sürüm karşılaştırma sayısal yapılır (v2.10 > v2.9; beta < kararlı)', () => {
  assert.equal(compareVersions('v2.10.0', 'v2.9.9'), 1);
  assert.equal(compareVersions('2.0', 'v2.0.0'), 0);
  assert.equal(compareVersions('v1.2.8', 'v1.3'), -1);
  assert.equal(compareVersions('v2.0.0-beta', 'v2.0.0'), -1);
  assert.equal(compareVersions('', 'v1.0'), -1);
});

const products = (await admin.req('GET', '/panel/api/license-products')).data.products;
const pdks = products.find((p) => p.prefix === 'NPDK');
const v1 = await upload(pdks.programId, 'v1.2.8', new TextEncoder().encode('eski sürüm dosyası'));
const v2bytes = new TextEncoder().encode('YENİ SÜRÜM 2.0.0 — kurulum paketi içeriği');
const v2 = await upload(pdks.programId, 'v2.0.0', v2bytes);
const lic = await admin.req('POST', '/panel/api/licenses', { body: { programId: pdks.programId, customer: 'Örnek Şirket A.Ş.', phone: '0555 111 22 33', maxDevices: 1 } });
const KEY = lic.data.key;
const DEV = 'ab'.repeat(32);
const app = client('198.51.100.30');
const call = (p, body) => app.req('POST', '/lisans/api/' + p, { body, panel: false });
assert.equal((await call('activate', { key: KEY, device_id: DEV, device_name: 'SUNUCU', app_version: 'v1.2.8', product: 'NPDK' })).status, 200);
const pub = (await app.req('GET', '/lisans/api/public-key')).data.x;

await test('Yayında sürüm yoksa program "güncel" yanıtı alır', async () => {
  const r = await call('update-check', { key: KEY, device_id: DEV, app_version: 'v1.2.8', product: 'NPDK' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.update, false);
});

await test('Panelden yayınlanan sürüm imzalı bildirimle sunulur; dosya parmak izi doğru', async () => {
  const noCode = await admin.req('POST', `/panel/api/versions/${v2.id}/release`, { body: { notes: 'x' } });
  assert.equal(noCode.status, 401, 'kodsuz yayın reddedilmeli');
  const p = await admin.req('POST', `/panel/api/versions/${v2.id}/release`, { body: { notes: 'Yeni puantaj ekranı', mandatory: false, code: await totp() } });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  const r = await call('update-check', { key: KEY, device_id: DEV, app_version: 'v1.2.8', product: 'NPDK' });
  assert.equal(r.data.update, true);
  const m = await verifyToken(pub, r.data.manifest);
  assert.ok(m, 'imza açık anahtarla doğrulanmalı');
  assert.equal(m.typ, 'od-update');
  assert.equal(m.version, 'v2.0.0');
  assert.equal(m.sha256, v2.sha);
  assert.equal(m.notes, 'Yeni puantaj ekranı');
  assert.equal(m.device, DEV);
  const dl = await app.req('GET', m.download, { raw: true, panel: false });
  assert.equal(dl.status, 200);
  const got = new Uint8Array(await dl.arrayBuffer());
  assert.equal(crypto.createHash('sha256').update(got).digest('hex'), v2.sha);
  // Kaldığı yerden devam (Range)
  const part = await app.req('GET', m.download, { raw: true, panel: false, headers: { range: 'bytes=5-' } });
  assert.equal(part.status, 206);
  assert.match(part.headers.get('content-range'), new RegExp(`^bytes 5-${v2bytes.length - 1}/${v2bytes.length}$`));
});

await test('Güncel programa yeni sürüm önerilmez; eski sürüm yayına alınamaz', async () => {
  const r = await call('update-check', { key: KEY, device_id: DEV, app_version: 'v2.0.0', product: 'NPDK' });
  assert.equal(r.data.update, false);
  const old = await admin.req('POST', `/panel/api/versions/${v1.id}/release`, { body: { code: await totp() } });
  assert.equal(old.status, 400);
  assert.match(old.data.error, /daha yeni/);
});

await test('Kayıtsız cihaz, geçersiz anahtar ve askıdaki lisans güncelleme alamaz', async () => {
  assert.equal((await call('update-check', { key: KEY, device_id: 'cd'.repeat(32), app_version: 'v1.0' })).status, 403);
  assert.equal((await call('update-check', { key: 'NPDK-0000-0000-0000-0000', device_id: DEV, app_version: 'v1.0' })).status, 404);
  await admin.req('POST', `/panel/api/licenses/${lic.data.id}/suspend`, { body: {} });
  assert.equal((await call('update-check', { key: KEY, device_id: DEV, app_version: 'v1.0' })).status, 403);
  await admin.req('POST', `/panel/api/licenses/${lic.data.id}/resume`, { body: {} });
});

await test('İndirme izni 1 saat sonra ve yayından kaldırılınca geçersiz olur; sahte izin reddedilir', async () => {
  const r = await call('update-check', { key: KEY, device_id: DEV, app_version: 'v1.2.8' });
  const m = await verifyToken(pub, r.data.manifest);
  const i = m.download.indexOf('.') + 10; // imzalı içeriğin ortasından bir karakter
  const tampered = m.download.slice(0, i) + (m.download[i] === 'A' ? 'B' : 'A') + m.download.slice(i + 1);
  assert.equal((await app.req('GET', tampered, { panel: false })).status, 403);
  tick(3601);
  assert.equal((await app.req('GET', m.download, { panel: false })).status, 403);
  const r2 = await call('update-check', { key: KEY, device_id: DEV, app_version: 'v1.2.8' });
  const m2 = await verifyToken(pub, r2.data.manifest);
  await admin.req('DELETE', `/panel/api/versions/${v2.id}/release`);
  assert.equal((await app.req('GET', m2.download, { panel: false })).status, 404);
  assert.equal((await call('update-check', { key: KEY, device_id: DEV, app_version: 'v1.2.8' })).data.update, false);
  await admin.req('POST', `/panel/api/versions/${v2.id}/release`, { body: { mandatory: true, code: await totp() } });
});

await test('Programlar ekranında yayındaki sürüm ve güncel cihaz sayısı görünür', async () => {
  const o = await admin.req('GET', '/panel/api/overview');
  const p = o.data.programs.find((x) => x.id === pdks.programId);
  assert.equal(p.release.version, 'v2.0.0');
  assert.equal(p.release.mandatory, true);
  assert.equal(p.release.devices, 1);
  assert.equal(p.release.upToDate, 0);
  const vs = await admin.req('GET', `/panel/api/programs/${pdks.programId}/versions`);
  assert.ok(vs.data.versions.find((v) => v.version === 'v2.0.0').released);
});

// ================= Bordro parametreleri =================
console.log('Bordro parametreleri');
await test('Varsayılan değerler → parametre dosyası → temel değerler birebir geri döner', () => {
  const json = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/pdks/parametreler.json'), 'utf8'));
  assert.deepEqual(baseFromPayroll(json), DEFAULT_BASE);
  assert.deepEqual(buildPayroll(DEFAULT_BASE, { guncelleme_tarihi: '2026-10-10', surum_tarihi: '2026-10-02' }), json);
});

await test('Hatalı değer anlaşılır mesajla reddedilir', () => {
  assert.throws(() => cleanBase({ ...DEFAULT_BASE, asgari_brut: -5 }), /Brüt asgari ücret geçersiz/);
  assert.throws(() => cleanBase({ ...DEFAULT_BASE, ucret_dilimleri: [[200000, 0.15], [100000, 0.2], [null, 0.4]] }), /artan/);
  assert.throws(() => cleanBase({ ...DEFAULT_BASE, kidem: [{ baslangic: '2026-13-01', tutar: 1 }] }), /tarih/);
});

await test('Yayın yokken statik dosya sunulur; panel varsayılanları dosyadan okur', async () => {
  const r = await app.req('GET', '/pdks/parametreler.json', { panel: false });
  assert.equal(r.status, 200);
  assert.equal(r.data.asgari_ucret.aylik_brut, 33030);
  const g = await admin.req('GET', '/panel/api/payroll');
  assert.equal(g.status, 200);
  assert.equal(g.data.source, 'dosya');
  assert.equal(g.data.base.asgari_brut, 33030);
  assert.equal(g.data.derived.sgk_tavan, 297270);
});

await test('Önizleme değişen alanları gösterir; yayın iki adımlı kod ister', async () => {
  const base = { ...DEFAULT_BASE, yil: 2027, asgari_brut: 40000, dogrulama_tarihi: '2027-01-01' };
  const pv = await admin.req('POST', '/panel/api/payroll/preview', { body: { base } });
  assert.deepEqual(pv.data.changes, ['Yıl', 'Doğrulama tarihi', 'Brüt asgari ücret']);
  assert.equal(pv.data.derived.asgari_net, 34000);
  assert.equal(pv.data.derived.sgk_tavan, 360000);
  const bad = await admin.req('POST', '/panel/api/payroll', { body: { base, code: '000000' } });
  assert.equal(bad.status, 401);
  const ok = await admin.req('POST', '/panel/api/payroll', { body: { base, note: '2027 asgari ücret', code: await totp() } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
});

await test('Yayından sonra PDKS dosyası ve sitedeki hesaplama parametreleri yeni değerle gelir', async () => {
  clearPayrollCache();
  const r = await app.req('GET', '/pdks/parametreler.json', { panel: false });
  assert.equal(r.data.asgari_ucret.aylik_brut, 40000);
  assert.equal(r.data.yil, 2027);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  const js = await app.req('GET', '/params-2026.js', { panel: false });
  const ctx = {};
  new Function('globalThis', 'module', js.data)(ctx, undefined);
  assert.equal(ctx.PARAM2026.minGross, 40000);
  assert.equal(ctx.PARAM2026.minNet, 34000);
  assert.equal(ctx.PARAM2026.tax.wage.at(-1)[0], Infinity);
  assert.ok(Array.isArray(ctx.PARAM2026.deadlines) && ctx.PARAM2026.deadlines.length > 0, 'takvim korunmalı');
});

await test('Geçmişten geri alma yeni kayıt olarak yayınlanır', async () => {
  const base2 = { ...DEFAULT_BASE, yil: 2027, asgari_brut: 41000 };
  await admin.req('POST', '/panel/api/payroll', { body: { base: base2, code: await totp() } });
  const g = await admin.req('GET', '/panel/api/payroll');
  assert.equal(g.data.history.length, 2);
  const firstId = g.data.history[1].id;
  const rr = await admin.req('POST', `/panel/api/payroll/${firstId}/restore`, { body: { code: await totp() } });
  assert.equal(rr.status, 200, JSON.stringify(rr.data));
  clearPayrollCache();
  assert.equal((await app.req('GET', '/pdks/parametreler.json', { panel: false })).data.asgari_ucret.aylik_brut, 40000);
  const same = await admin.req('POST', '/panel/api/payroll', { body: { base: (await admin.req('GET', '/panel/api/payroll')).data.base, code: await totp() } });
  assert.equal(same.status, 400, 'değişiklik yoksa yayınlanmaz');
});

// ================= Kaynak takibi =================
console.log('Resmi kaynak takibi');
await test('Türkçe büyük harfli başlıklar anahtar kelimelerle yakalanır', () => {
  assert.equal(trLower('GELİR VERGİSİ GENEL TEBLİĞİ'), 'gelir vergisi genel tebliği');
  const html = '<ul><li><a href="/eskiler/2026/12/20261231M5-1.htm">GELİR VERGİSİ GENEL TEBLİĞİ (SERİ NO: 340)</a></li>'
    + '<li><a href="/x">Kültür ve Turizm Bakanlığı Yönetmeliği değişikliği</a></li>'
    + '<li><a href="https://www.sgk.gov.tr/a">2027 Yılı Asgari Ücret Tutarları Hakkında Duyuru</a></li></ul>';
  const m = findMatches(html, { key: 'Resmî Gazete', base: 'https://www.resmigazete.gov.tr/' });
  assert.equal(m.length, 2);
  assert.equal(m[0].url, 'https://www.resmigazete.gov.tr/eskiler/2026/12/20261231M5-1.htm');
  assert.equal(m[0].keyword, 'Gelir vergisi tebliği');
  assert.equal(m[1].keyword, 'Asgari ücret');
});

await test('İlk tarama eski başlıkları sessizce kaydeder; sonraki taramada yenileri uyarı olur', async () => {
  let page = '<a href="/a">Yemek Bedeline İlişkin 2026/12 Sayılı Genelge</a>';
  const fake = async (url) => { if (url.includes('gib')) throw new Error('503'); return page; };
  const r1 = await runWatch(env, fake);
  assert.equal(r1.firstRun, true);
  assert.equal(r1.found, 0);
  assert.deepEqual(r1.failed, ['GİB (503)']);
  page += '<a href="/b">Kıdem Tazminatı Tavanı 2027 Ocak Dönemi Hakkında</a>';
  const r2 = await runWatch(env, fake);
  assert.equal(r2.found, 2, 'SGK ve Resmî Gazete sayfalarında birer yeni başlık');
  const g = await admin.req('GET', '/panel/api/payroll');
  assert.equal(g.data.openAlerts, 2);
  assert.equal(g.data.watch.checked.length, 2);
  const id = g.data.alerts.find((a) => a.open).id;
  await admin.req('POST', `/panel/api/alerts/${id}/dismiss`, { body: {} });
  assert.equal((await admin.req('GET', '/panel/api/payroll')).data.openAlerts, 1);
});

// ================= Yenileme takibi =================
console.log('Lisans yenileme takibi');
await test('Süresi 60 gün içinde dolacak ve son 30 günde dolmuş lisanslar listelenir', async () => {
  const today = new Date(clock + 3 * 3600e3);
  const iso = (days) => new Date(today.getTime() + days * 86400e3).toISOString().slice(0, 10);
  const mk = async (name, starts, ends) => {
    const r = await admin.req('POST', '/panel/api/licenses', { body: { programId: pdks.programId, customer: name, starts, ends } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  };
  await mk('Yakında Biten Ltd.', iso(-300), iso(10));
  await mk('Ay Sonu A.Ş.', iso(-300), iso(45));
  await mk('Geçen Hafta Biten Ltd.', iso(-400), iso(-7));
  await mk('Uzak Tarih A.Ş.', iso(-10), iso(200));
  const r = await admin.req('GET', '/panel/api/renewals');
  assert.equal(r.status, 200);
  const names = r.data.list.map((l) => l.customer);
  assert.deepEqual(names, ['Geçen Hafta Biten Ltd.', 'Yakında Biten Ltd.', 'Ay Sonu A.Ş.']);
  assert.deepEqual(r.data.counts, { expired: 1, in30: 1, in60: 1 });
  assert.ok(r.data.months.length >= 2);
});

// ================= Cloudflare kurulumu =================
console.log('Cloudflare ile güvenlik kurulumu');
const realFetch = globalThis.fetch;
function fakeCloudflare({ zeroTrust = true } = {}) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input.url || input);
    if (!url.startsWith('https://api.cloudflare.com/')) return realFetch(input, init);
    const p = url.replace('https://api.cloudflare.com/client/v4', '');
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, p, body });
    const ok = (result) => new Response(JSON.stringify({ success: true, result }), { headers: { 'content-type': 'application/json' } });
    if (p === '/user/tokens/verify') return ok({ status: 'active' });
    if (p.startsWith('/accounts?')) return ok([{ id: 'acc1', name: 'Özkan Demir' }]);
    if (p === '/accounts/acc1/workers/scripts') return ok([{ id: 'ozkandemir-web' }]);
    if (p === '/accounts/acc1/workers/scripts/ozkandemir-web/secrets') return ok({});
    if (p === '/accounts/acc1/access/organizations') return zeroTrust ? ok({ auth_domain: 'ozkandemir.cloudflareaccess.com' }) : new Response(JSON.stringify({ success: false, errors: [{ message: 'not enabled' }] }), { status: 404 });
    if (p === '/accounts/acc1/access/identity_providers' && method === 'GET') return ok([]);
    if (p === '/accounts/acc1/access/identity_providers') return ok({ id: 'idp1', type: 'onetimepin' });
    if (p.startsWith('/accounts/acc1/access/apps?')) return ok([]);
    if (p === '/accounts/acc1/access/apps' && method === 'POST') return ok({ id: 'app1', aud: 'aud-123', domain: body.domain });
    if (p === '/accounts/acc1/access/apps/app1/policies' && method === 'GET') return ok([]);
    if (p === '/accounts/acc1/access/apps/app1/policies') return ok({ id: 'pol1' });
    return new Response(JSON.stringify({ success: false, errors: [{ message: 'beklenmeyen ' + p }] }), { status: 400 });
  };
  return calls;
}
const TOKEN = 'a'.repeat(40);

await test('Zero Trust açık değilse anlaşılır yönlendirme verir, hiçbir şey kaydedilmez', async () => {
  fakeCloudflare({ zeroTrust: false });
  const r = await admin.req('POST', '/panel/api/security/cloudflare', { body: { token: TOKEN, access: true, code: await totp() } });
  globalThis.fetch = realFetch;
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Zero Trust/);
  assert.equal(env.DB._db.prepare("SELECT COUNT(*) n FROM settings WHERE name = 'access'").get().n, 0);
});

await test('Anahtarlar gizli değişkene yazılır, Access kurulur; API anahtarı saklanmaz', async () => {
  // Anahtarları veritabanında tutan kurulum (otomatik kurulumdaki gibi): aynı veritabanı, gizli değişken yok
  const db = env.DB;
  db._db.prepare("INSERT OR REPLACE INTO system_keys (name, value, created_at) VALUES ('panel_enc_key', ?, 0), ('license_signing_key', ?, 0)").run(env.PANEL_ENC_KEY, env.LICENSE_SIGNING_KEY);
  const dbEnv = { ...env, DB: { prepare: (q) => db.prepare(q), batch: (l) => db.batch(l), exec: (q) => db.exec(q), _db: db._db } };
  delete dbEnv.PANEL_ENC_KEY; delete dbEnv.LICENSE_SIGNING_KEY;
  const calls = fakeCloudflare();
  const r = await admin.req('POST', '/panel/api/security/cloudflare', { body: { token: TOKEN, keys: true, access: true, code: await totp() }, useEnv: dbEnv });
  globalThis.fetch = realFetch;
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.done, ['keys', 'access']);
  assert.equal(r.data.recovery.PANEL_ENC_KEY, env.PANEL_ENC_KEY, 'kurtarma yedeği bir kez verilir');
  const secrets = calls.filter((c) => c.p.endsWith('/secrets')).map((c) => c.body.name);
  assert.deepEqual(secrets, ['PANEL_ENC_KEY', 'LICENSE_SIGNING_KEY']);
  const app1 = calls.find((c) => c.p === '/accounts/acc1/access/apps' && c.method === 'POST').body;
  assert.deepEqual(app1.self_hosted_domains, ['ozkandemir.net/panel', 'www.ozkandemir.net/panel']);
  const pol = calls.find((c) => c.p.endsWith('/policies') && c.method === 'POST').body;
  assert.deepEqual(pol.include, [{ email: { email: EMAIL } }]);
  const dump = JSON.stringify(env.DB._db.prepare('SELECT * FROM settings').all()) + JSON.stringify(env.DB._db.prepare('SELECT * FROM audit').all());
  assert.ok(!dump.includes(TOKEN), 'API anahtarı veritabanına yazılmamalı');
});

await test('Access kurulduktan sonra: geçerli girişle etkinleşir, sonra jetonsuz istek reddedilir', async () => {
  clearAccessCache();
  // Bekleme durumunda jetonsuz istek kilitlenmez
  assert.equal((await admin.req('GET', '/panel/api/me')).status, 200);
  // Access jetonu: test için yerel anahtarla imzalanmış JWT ve sahte JWKS
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const kid = 'k1';
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(clock / 1000);
  const head = b64({ alg: 'RS256', kid, typ: 'JWT' });
  const body = b64({ aud: ['aud-123'], email: EMAIL, iss: 'https://ozkandemir.cloudflareaccess.com', iat: now, exp: now + 3600, nbf: now - 5 });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
  const jwt = `${head}.${body}.${sig}`;
  globalThis.fetch = async (input, init) => {
    const url = String(input.url || input);
    if (url === 'https://ozkandemir.cloudflareaccess.com/cdn-cgi/access/certs') return new Response(JSON.stringify({ keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] }), { headers: { 'content-type': 'application/json' } });
    return realFetch(input, init);
  };
  const ok = await admin.req('GET', '/panel/api/me', { headers: { 'cf-access-jwt-assertion': jwt } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  clearAccessCache();
  const st = JSON.parse(env.DB._db.prepare("SELECT value FROM settings WHERE name = 'access'").get().value);
  assert.equal(st.state, 'active');
  assert.equal((await admin.req('GET', '/panel/api/me')).status, 403, 'artık Access zorunlu');
  assert.equal((await client('192.0.2.1').req('GET', '/panel/')).status, 403);
  // Lisans ve indirme adresleri Access dışında kalır
  assert.equal((await app.req('GET', '/lisans/api/public-key', { panel: false })).status, 200);
  // Acil durum anahtarı
  const envOff = { ...env, ACCESS_KAPAT: '1' };
  assert.equal((await client('192.0.2.2', envOff).req('GET', '/panel/')).status, 200);
  globalThis.fetch = realFetch;
});

await test('Gizli değişkenler devreye girince veritabanındaki anahtar kopyaları silinir', async () => {
  const db = createD1(schema);
  const e1 = { DB: db, ASSETS: env.ASSETS };
  await worker.fetch(new Request(ORIGIN + '/lisans/api/public-key'), e1);
  const keys = Object.fromEntries(db._db.prepare('SELECT name, value FROM system_keys').all().map((r) => [r.name, r.value]));
  const e2 = { DB: { prepare: (s) => db.prepare(s), batch: (l) => db.batch(l), exec: (s) => db.exec(s) }, ASSETS: env.ASSETS, PANEL_ENC_KEY: keys.panel_enc_key, LICENSE_SIGNING_KEY: keys.license_signing_key };
  const pk = await (await worker.fetch(new Request(ORIGIN + '/lisans/api/public-key'), e2)).json();
  assert.equal(pk.x, JSON.parse(keys.license_signing_key).x, 'aynı imza anahtarı');
  const left = db._db.prepare("SELECT name FROM system_keys WHERE name IN ('panel_enc_key', 'license_signing_key')").all();
  assert.equal(left.length, 0);
  // Gizli değişkenler sonradan kaybolursa sessizce yeni anahtar üretilmez
  const e3 = { DB: { prepare: (s) => db.prepare(s), batch: (l) => db.batch(l), exec: (s) => db.exec(s) }, ASSETS: env.ASSETS };
  const lost = await worker.fetch(new Request(ORIGIN + '/lisans/api/public-key'), e3);
  assert.equal(lost.status, 503);
  assert.equal(db._db.prepare("SELECT COUNT(*) n FROM system_keys WHERE name = 'license_signing_key'").get().n, 0, 'yeni anahtar üretilmemeli');
});

// ================= Python istemcisi: güncelleme =================
import { spawnSync, execFile } from 'node:child_process';
if (spawnSync('python3', ['--version']).status === 0) {
  console.log('Python istemcisi');
  env.ACCESS_KAPAT = '1'; // önceki testte açılan Access kapısını bu bölüm için devre dışı bırak
  clearAccessCache();
  const http = await import('node:http');
  const os = await import('node:os');
  const srv = http.createServer(async (q, res) => {
    const chunks = []; for await (const ch of q) chunks.push(ch);
    const h = new Headers(); for (const [k, v] of Object.entries(q.headers)) h.set(k, String(v)); h.set('cf-connecting-ip', '127.0.0.9');
    const r = await worker.fetch(new Request('https://ozkandemir.net' + q.url, { method: q.method, headers: h, body: chunks.length ? Buffer.concat(chunks) : undefined }), env);
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((ok) => srv.listen(0, ok));
  const port = srv.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'odu-'));
  const pyEnv = { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', HTTP_PROXY: '', http_proxy: '', HOME: tmp, USERPROFILE: tmp };
  const pyRun = (code) => new Promise((ok) => execFile('python3', ['-I', '-c', `import sys, json, os; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'lisans-istemcisi/python'))})\nimport odlisans\n` + code],
    { encoding: 'utf8', timeout: 120000, env: pyEnv }, (err, stdout, stderr) => {
      assert.ok(!err, stderr + stdout);
      ok(JSON.parse(stdout.trim().split('\n').pop()));
    }));
  const bnk = products.find((p) => p.prefix === 'BNKX');
  const bytes = new Uint8Array(300000).map((_, i) => (i * 7) % 251);
  const rel = await upload(bnk.programId, 'v3.0.0', bytes);
  await admin.req('POST', `/panel/api/versions/${rel.id}/release`, { body: { notes: 'Ziraat yeni ekstre biçimi', code: await totp() } });
  const L = (await admin.req('POST', '/panel/api/licenses', { body: { programId: bnk.programId, customer: 'Banka Müşterisi Ltd.' } })).data;
  const mk = `c = odlisans.LicenseClient("BNKX", ${JSON.stringify(pub)}, "v2.5.1", data_dir=${JSON.stringify(path.join(tmp, 'b'))}, server="http://127.0.0.1:${port}")\n`;

  await test('Python: yeni sürümü bulur, indirir ve parmak izini doğrular', async () => {
    const r = await pyRun(mk + `c.activate(${JSON.stringify(L.key)})\nu = c.check_update()\nf = c.download_update(u)\nimport hashlib\nprint(json.dumps({"v": u.version, "notes": u.notes, "sha": hashlib.sha256(open(f, "rb").read()).hexdigest(), "name": os.path.basename(f)}))`);
    assert.deepEqual(r, { v: 'v3.0.0', notes: 'Ziraat yeni ekstre biçimi', sha: rel.sha, name: 'kurulum-v3.0.0.zip' });
  });

  await test('Python: yarım kalan indirme kaldığı yerden tamamlanır; bozuk dosya silinir', async () => {
    const r = await pyRun(mk + `u = c.check_update()\nd = ${JSON.stringify(path.join(tmp, 'yarim'))}\nos.makedirs(d, exist_ok=True)\nopen(os.path.join(d, u.filename + ".part"), "wb").write(bytes(((i * 7) % 251) for i in range(1000)))\nf = c.download_update(u, d)\nok1 = os.path.exists(f)\nopen(os.path.join(d, u.filename + ".part"), "wb").write(b"bozuk")\nos.remove(f)\ntry:\n    c.download_update(u, d)\n    bad = "indi"\nexcept odlisans.LicenseError as e:\n    bad = e.code\nprint(json.dumps({"ok1": ok1, "bad": bad, "part": os.path.exists(os.path.join(d, u.filename + ".part"))}))`);
    assert.deepEqual(r, { ok1: true, bad: 'checksum', part: false });
  });

  await test('Python: güncel sürümde "güncel" yanıtı, sahte bildirim reddedilir', async () => {
    const r = await pyRun(`c = odlisans.LicenseClient("BNKX", ${JSON.stringify(pub)}, "v3.0.0", data_dir=${JSON.stringify(path.join(tmp, 'b'))}, server="http://127.0.0.1:${port}")\nnone = c.check_update() is None\nk = odlisans.LicenseClient("BNKX", "${'A'.repeat(43)}", "v2.0", data_dir=${JSON.stringify(path.join(tmp, 'b'))}, server="http://127.0.0.1:${port}")\ntry:\n    k.check_update(); x = "kabul"\nexcept odlisans.LicenseError as e:\n    x = e.code\nprint(json.dumps({"none": none, "fake": x}))`);
    assert.deepEqual(r, { none: true, fake: 'invalid' });
  });
  srv.close();
}

console.log(`v3.8 tests: OK (${passed} test)`);
