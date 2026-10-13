// ozkandemir.net — V3.13 "7 gün ücretsiz demo iste" testleri (site formu + panel "Demo gönder")
// Çalıştır: node tests/test-demo.mjs — e-posta (Resend) taklit edilir; gerçek gönderim yapılmaz.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createD1, createR2, createAssets } from './helpers/cf-local.mjs';
import { buildSigningKey, buildAdminSetup } from '../scripts/setup-lib.mjs';
import * as S from '../src/panel/security.js';
import { verifyToken, signingPublicKey, pickInstaller, fileKind } from '../src/panel/license.js';
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

const mails = [];
let mailFail = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url === 'https://api.resend.com/emails') {
    if (mailFail) return new Response(JSON.stringify({ name: 'validation_error', message: 'Invalid to' }), { status: 422 });
    mails.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: 'm' + mails.length }), { status: 200 });
  }
  return realFetch(input, init);
};

const schema = fs.readdirSync(path.join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => fs.readFileSync(path.join(ROOT, 'migrations', f), 'utf8')).join('\n');
const EMAIL = 'ozkan6181@hotmail.com', PASS = 'Cok-Guclu-Sifre-2026';
const setup = await buildAdminSetup({ email: EMAIL, password: PASS });
const signing = await buildSigningKey();
const env = {
  DB: createD1(schema), FILES: createR2(), ASSETS: createAssets(path.join(ROOT, 'public')),
  PANEL_ENC_KEY: setup.encKey, LICENSE_SIGNING_KEY: signing.secret, RESEND_API_KEY: 're_test',
};
await env.DB.exec(setup.sql);
const db = env.DB._db;
const SECRET = S.base32Decode(setup.secret);

async function form(body, ip = '198.51.100.20') {
  const res = await worker.fetch(new Request('https://www.ozkandemir.net/lisans/api/demo-talep', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify(body),
  }), env);
  return { status: res.status, data: await res.json() };
}
const req = (over = {}) => ({ program: 'banka-xml-aktarim', company: 'Deneme Gıda Ltd.', contact_name: 'Ayşe Yılmaz',
  email: 'ayse@denemegida.com.tr', phone: '0532 111 22 33', note: 'Logo Go3 kullanıyoruz.', kvkk: true, website: '', ...over });

const jar = {};
async function panel(method, p, body) {
  const hd = new Headers({ 'cf-connecting-ip': '203.0.113.10', 'user-agent': 'Test' });
  if (method !== 'GET') { hd.set('x-od-panel', '1'); hd.set('origin', 'https://ozkandemir.net'); }
  const ck = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  if (ck) hd.set('cookie', ck);
  if (body !== undefined) hd.set('content-type', 'application/json');
  const res = await worker.fetch(new Request('https://ozkandemir.net' + p, { method, headers: hd, body: body !== undefined ? JSON.stringify(body) : undefined }), env);
  for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const code = async () => { tick(31); return S.hotp(SECRET, Math.floor(S.now() / 30)); };

await test('Form: alan kontrolleri ve KVKK onayı; bal tuzağı kayıt oluşturmaz', async () => {
  for (const [over, re] of [[{ program: 'yok' }, /yazılım/], [{ company: 'A' }, /Firma/], [{ contact_name: 'A' }, /soyad/],
    [{ email: 'x@y' }, /e-posta/], [{ phone: '123' }, /Telefon/], [{ kvkk: false }, /KVKK/]]) {
    const r = await form(req(over));
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.match(r.data.message, re);
  }
  const r = await form(req({ website: 'http://spam.example' }));
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM demo_requests').get().n, 0);
  assert.equal(mails.length, 0);
});

await test('Form: talep kaydedilir, info@ozkandemir.net bildirimi (yanıt adresi firma); firmaya otomatik e-posta gitmez', async () => {
  const r = await form(req());
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ok, true);
  assert.equal(mails.length, 1);
  assert.deepEqual(mails[0].to, ['info@ozkandemir.net']);
  assert.equal(mails[0].reply_to, 'ayse@denemegida.com.tr');
  assert.match(mails[0].subject, /^\[Demo talebi #\d+\] Deneme Gıda Ltd\. — Banka XML Aktarım/);
  assert.match(mails[0].text, /Logo Go3 kullanıyoruz/);
  const row = db.prepare('SELECT * FROM demo_requests').get();
  assert.equal(row.state, 'new');
  assert.equal(row.mail_state, 'sent');
  const again = await form(req());
  assert.equal(again.data.duplicate, true, 'aynı e-posta + yazılım tek kayıt');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM demo_requests').get().n, 1);
});

await test('Form: aynı bağlantıdan günde en fazla 5 talep', async () => {
  const ip = '192.0.2.50';
  for (let i = 0; i < 5; i++) assert.equal((await form(req({ email: `k${i}@firma.com` }), ip)).status, 200);
  assert.equal((await form(req({ email: 'k9@firma.com' }), ip)).status, 429);
});

let D;
await test('Panel: liste oturum ister; bekleyen talepler görünür', async () => {
  assert.equal((await panel('GET', '/panel/api/demo')).status, 401);
  const r1 = await panel('POST', '/panel/api/login', { email: EMAIL, password: PASS });
  const r2 = await panel('POST', '/panel/api/verify', { challenge: r1.data.challenge, code: await S.hotp(SECRET, Math.floor(S.now() / 30)) });
  assert.equal(r2.status, 200, JSON.stringify(r2.data));
  const l = await panel('GET', '/panel/api/demo');
  assert.equal(l.status, 200, JSON.stringify(l.data));
  assert.equal(l.data.open, 6);
  assert.equal(l.data.mailReady, true);
  D = l.data.list.find((x) => x.email === 'ayse@denemegida.com.tr');
  assert.equal(D.program, 'Banka XML Aktarım');
});

await test('Demo gönder: doğrulama kodu ister; 7 günlük deneme lisansı + firmaya e-posta; lisans etkinleşir', async () => {
  let r = await panel('POST', `/panel/api/demo/${D.id}/send`, {});
  assert.ok(r.status >= 400, 'kodsuz reddedilir');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM licenses').get().n, 0);
  const n = mails.length;
  r = await panel('POST', `/panel/api/demo/${D.id}/send`, { code: await code() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.mailed, true);
  assert.equal(r.data.download, false, 'yayında sürüm yok → bağlantısız');
  const m = mails[n];
  assert.deepEqual(m.to, ['ayse@denemegida.com.tr']);
  assert.equal(m.reply_to, 'info@ozkandemir.net');
  const key = (m.text.match(/BNKX(-[0-9A-Z]{4}){4}/) || [])[0];
  assert.ok(key, 'e-postada anahtar');
  const lic = db.prepare('SELECT * FROM licenses WHERE id = ?').get(r.data.licenseId);
  assert.equal(lic.ends_at - lic.starts_at, 7 * 86400);
  assert.equal(lic.max_devices, 1);
  assert.equal(JSON.parse(lic.limits_json).deneme, 1);
  assert.equal(lic.customer, 'Deneme Gıda Ltd.');
  const row = db.prepare('SELECT * FROM demo_requests WHERE id = ?').get(D.id);
  assert.equal(row.state, 'sent');
  assert.equal(row.license_id, lic.id);
  assert.equal((await panel('POST', `/panel/api/demo/${D.id}/send`, { code: await code() })).status, 400, 'ikinci kez gönderilmez');
  const res = await worker.fetch(new Request('https://ozkandemir.net/lisans/api/activate', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.9' },
    body: JSON.stringify({ key, device_id: 'ab'.repeat(32), device_name: 'DEMOPC', product: 'BNKX', app_version: '1.0.0' }),
  }), env);
  const a = await res.json();
  assert.equal(res.status, 200, JSON.stringify(a));
  const p = await verifyToken(await signingPublicKey(env), a.token);
  assert.equal(p.limits.deneme, 1);
});

await test('E-posta gitmezse demo yine oluşur, mesaj panelde gösterilir; kapat / yeniden aç', async () => {
  const l = (await panel('GET', '/panel/api/demo')).data.list;
  const x = l[0], y = l[1];
  mailFail = true;
  const r = await panel('POST', `/panel/api/demo/${x.id}/send`, { code: await code() });
  mailFail = false;
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.mailed, false);
  assert.match(r.data.text, /BNKX-/);
  assert.equal((await panel('POST', `/panel/api/demo/${y.id}/close`, {})).status, 200);
  assert.equal(db.prepare('SELECT state FROM demo_requests WHERE id = ?').get(y.id).state, 'closed');
  assert.equal((await panel('POST', `/panel/api/demo/${y.id}/close`, { reopen: true })).status, 200);
  assert.equal(db.prepare('SELECT state FROM demo_requests WHERE id = ?').get(y.id).state, 'new');
  assert.equal((await panel('POST', `/panel/api/demo/${x.id}/close`, {})).status, 400, 'gönderilmiş talep kapatılamaz');
});

await test('Site: yazılım sayfalarında demo düğmesi, demo sayfası ve form betiği', async () => {
  for (const [f, slug] of [['yazilim-personel', 'nis-pdks'], ['yazilim-banka-logo', 'banka-xml-aktarim'], ['yazilim-satinalma-denetim', 'satinalma-denetim'],
    ['yazilim-cari-mutabakat', 'cari-mutabakat'], ['yazilim-yillik-izin', 'yillik-izin'], ['yazilim-cari360', 'cari360']]) {
    const s = fs.readFileSync(path.join(ROOT, 'public', f + '.html'), 'utf8');
    assert.ok(s.includes(`/demo.html?urun=${slug}`), f);
  }
  const d = fs.readFileSync(path.join(ROOT, 'public', 'demo.html'), 'utf8');
  for (const v of ['nis-pdks', 'banka-xml-aktarim', 'satinalma-denetim', 'cari-mutabakat', 'yillik-izin', 'cari360']) assert.ok(d.includes(`value="${v}"`));
  assert.ok(d.includes('/demo.js'));
  assert.ok(fs.readFileSync(path.join(ROOT, 'public', 'yazilimlar.html'), 'utf8').includes('/demo.html'));
});

await test('İndirme bağlantısı her zaman kurulum dosyasını verir; güncelleme paketi asla', () => {
  const v = (id, version, filename, created_at = id) => ({ id, version, filename, created_at });
  assert.equal(fileKind('PDKS_V1.36.0_guncelleme.zip'), 'update');
  assert.equal(fileKind('NIS_PDKS_Setup.exe'), 'setup');
  assert.equal(fileKind('kurulum.zip'), 'file');
  // yeni güncelleme paketi daha yüksek sürümde olsa da kurulum dosyası seçilir
  assert.equal(pickInstaller([v(1, 'V1.34.0-kurulum', 'Setup.exe'), v(2, 'V1.36.0', 'PDKS_V1.36.0_guncelleme.zip', 99)]).id, 1);
  assert.equal(pickInstaller([v(1, 'V1.34.0-kurulum', 'Setup.exe'), v(3, 'V1.36.0-kurulum', 'Setup.exe')]).id, 3);
  // kurulum dosyası yoksa güncelleme paketi olmayan dosya; yalnız paket varsa bağlantı yok
  assert.equal(pickInstaller([v(1, 'v2.0', 'BankaXml.zip'), v(2, 'V1.36.0', 'PDKS_V1.36.0_guncelleme.zip')]).id, 1);
  assert.equal(pickInstaller([v(2, 'V1.36.0', 'PDKS_V1.36.0_guncelleme.zip')]), null);
});

console.log(`\n${passed} test geçti.`);
