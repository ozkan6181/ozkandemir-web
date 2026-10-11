// ozkandemir.net — 7 günlük deneme lisansı testleri (/lisans/api/trial)
// Çalıştır: node tests/test-deneme.mjs — e-posta (Resend) taklit edilir; gerçek gönderim yapılmaz.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createD1, createR2, createAssets } from './helpers/cf-local.mjs';
import { buildSigningKey, buildAdminSetup } from '../scripts/setup-lib.mjs';
import * as S from '../src/panel/security.js';
import { verifyToken, signingPublicKey, TRIAL_EXPIRED_MSG } from '../src/panel/license.js';
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

// ---------- e-posta taklidi (Resend) ----------
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
const keyIn = (m) => (m.text.match(/NPDK(-[0-9A-Z]{4}){4}/) || [])[0];

// ---------- ortam ----------
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

let ipN = 1;
async function lic(p, body, ip) {
  const res = await worker.fetch(new Request('https://ozkandemir.net/lisans/api/' + p, {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip || `198.51.100.${ipN}` },
    body: JSON.stringify(body),
  }), env);
  return { status: res.status, data: await res.json() };
}
const dev = (n) => n.toString(16).padStart(2, '0').repeat(32);
const req = (over = {}) => ({ product: 'NPDK', email: 'muhasebe@ornek.com.tr', company: 'Örnek Lojistik A.Ş.', phone: '0532 111 22 33',
  contact_name: 'Ali Veli', device_id: dev(1), device_name: 'ORNEKSRV', app_version: 'V1.34.0', ...over });
const activate = (key, d = dev(1)) => lic('activate', { key, device_id: d, device_name: 'ORNEKSRV', product: 'NPDK', app_version: 'V1.34.0' });

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
await test('E-posta gönderimi kurulu değilse deneme verilmez (503), lisans oluşmaz', async () => {
  const r = await lic('trial', req());
  assert.equal(r.status, 503);
  assert.equal(r.data.code, 'unavailable');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM licenses').get().n, 0);
  env.RESEND_API_KEY = 're_test';
});

await test('Girdi kontrolü: e-posta, şirket, cihaz kimliği, program', async () => {
  for (const [over, re] of [[{ email: 'yanlis' }, /e-posta/], [{ company: 'A' }, /Şirket/], [{ device_id: 'xyz' }, /Cihaz/], [{ product: 'BNKX' }, /deneme verilmiyor/]]) {
    const r = await lic('trial', req(over));
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.match(r.data.message, re);
  }
  assert.equal(mails.length, 0);
});

let KEY;
await test('Deneme: 7 gün, 1 cihaz, anahtar yalnız e-postada; sahibine bildirim; anahtarla etkinleştirme', async () => {
  const t0 = Math.floor(Date.now() / 1000);
  const r = await lic('trial', req());
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ok, true);
  assert.ok(!/NPDK(-[0-9A-Z]{4}){4}/.test(JSON.stringify(r.data)), 'yanıtta anahtar yok');
  assert.equal(mails.length, 2);
  const [toUser, toOwner] = mails;
  assert.deepEqual(toUser.to, ['muhasebe@ornek.com.tr']);
  KEY = keyIn(toUser);
  assert.ok(KEY, 'e-postada anahtar var');
  assert.match(toUser.subject, /7 günlük deneme/);
  assert.deepEqual(toOwner.to, ['info@ozkandemir.net']);
  assert.match(toOwner.subject, /Yeni deneme.*Örnek Lojistik/);
  assert.equal(toOwner.reply_to, 'muhasebe@ornek.com.tr');
  assert.ok(!keyIn(toOwner), 'bildirimde anahtar yok');
  const l = db.prepare('SELECT * FROM licenses').get();
  assert.equal(l.max_devices, 1);
  assert.equal(l.ends_at - l.starts_at, 7 * 86400);
  assert.ok(Math.abs(l.starts_at - t0) < 5);
  assert.equal(JSON.parse(l.limits_json).deneme, 1);
  assert.equal(JSON.parse(l.limits_json).personel, 100);
  const a = await activate(KEY);
  assert.equal(a.status, 200, JSON.stringify(a.data));
  const p = await verifyToken(await signingPublicKey(env), a.data.token);
  assert.equal(p.limits.deneme, 1);
  assert.equal(p.expires, l.ends_at);
  assert.equal((await activate(KEY, dev(9))).data.code, 'device_limit', 'ikinci sunucuda çalışmaz');
});

await test('Tekrar: aynı e-posta / aynı sunucu ikinci deneme alamaz; kullanılmamış anahtar yeniden gönderilir', async () => {
  let r = await lic('trial', req());
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'trial_used');
  r = await lic('trial', req({ email: 'baska@ornek.com.tr' }));
  assert.equal(r.status, 409, 'aynı sunucu (anahtar kullanılmış)');
  assert.match(r.data.message, /sunucuda/);
  // yanlış yazılan e-posta: anahtar kullanılmadıysa aynı sunucunun düzeltilmiş adresine gider
  let m0 = mails.length;
  r = await lic('trial', req({ email: 'yanlis@ornke.com', device_id: dev(5), company: 'Düzeltme Ltd' }));
  assert.equal(r.status, 200);
  const kx = keyIn(mails[m0]);
  m0 = mails.length;
  r = await lic('trial', req({ email: 'dogru@ornek.com', device_id: dev(5), company: 'Düzeltme Ltd' }));
  assert.equal((r.status, r.data.resent), true);
  assert.deepEqual(mails[m0].to, ['dogru@ornek.com']);
  assert.equal(keyIn(mails[m0]), kx, 'aynı deneme anahtarı');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trials WHERE device_id = ?').get(dev(5)).n, 1);
  assert.equal(db.prepare('SELECT email FROM trials WHERE device_id = ?').get(dev(5)).email, 'dogru@ornek.com');
  r = await lic('trial', req({ email: 'yanlis@ornke.com', device_id: dev(6), company: 'Başka' }));
  assert.equal(r.status, 200, 'eski (yanlış) adres serbest kaldı');
  // kullanılmamış anahtar: yeniden gönderilir (en fazla 3 gönderim)
  const n = mails.length;
  r = await lic('trial', req({ email: 'yeni@firma.com', device_id: dev(2), company: 'Yeni Firma' }));
  assert.equal(r.status, 200);
  const k2 = keyIn(mails[n]);
  r = await lic('trial', req({ email: 'YENI@firma.com', device_id: dev(2), company: 'Yeni Firma' }));
  assert.equal(r.data.resent, true);
  assert.equal(keyIn(mails.at(-1)), k2, 'aynı anahtar');
  r = await lic('trial', req({ email: 'yeni@firma.com', device_id: dev(2) }));
  assert.equal(r.data.resent, true);
  r = await lic('trial', req({ email: 'yeni@firma.com', device_id: dev(2) }));
  assert.equal(r.status, 409, 'gönderim sınırı');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM trials WHERE email = 'yeni@firma.com'").get().n, 1);
});

await test('E-posta gönderilemezse deneme oluşmaz (adres hatası), sonra tekrar denenebilir', async () => {
  mailFail = true;
  const before = db.prepare('SELECT COUNT(*) AS n FROM licenses').get().n;
  let r = await lic('trial', req({ email: 'hatali@firma.com', device_id: dev(3) }));
  mailFail = false;
  assert.equal(r.status, 502);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM licenses').get().n, before);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM trials WHERE device_id = ?").get(dev(3)).n, 0);
  r = await lic('trial', req({ email: 'hatali@firma.com', device_id: dev(3) }));
  assert.equal(r.status, 200);
});

await test('Aynı bağlantıdan günde en fazla 5 deneme isteği', async () => {
  const ip = '192.0.2.77';
  for (let i = 0; i < 5; i++) assert.equal((await lic('trial', req({ email: `t${i}@x.com`, device_id: dev(20 + i) }), ip)).status, 200);
  const r = await lic('trial', req({ email: 't9@x.com', device_id: dev(40) }), ip);
  assert.equal(r.status, 429);
});

await test('Süre bitince program kilitlenir: deneme mesajı; satın alınca (süreyi uzat) deneme işareti kalkar', async () => {
  tick(8 * 86400);
  let r = await lic('check', { key: KEY, device_id: dev(1), device_name: 'ORNEKSRV', product: 'NPDK' });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'expired');
  assert.equal(r.data.message, TRIAL_EXPIRED_MSG);
  const p = await verifyToken(await signingPublicKey(env), r.data.token);
  assert.equal(p.status, 'expired');
  assert.equal(p.message, TRIAL_EXPIRED_MSG);
  // panel: giriş + listede "Deneme" + süreyi uzat
  const r1 = await panel('POST', '/panel/api/login', { email: EMAIL, password: PASS });
  const r2 = await panel('POST', '/panel/api/verify', { challenge: r1.data.challenge, code: await S.hotp(SECRET, Math.floor(S.now() / 30)) });
  assert.equal(r2.status, 200, JSON.stringify(r2.data));
  const list = await panel('GET', '/panel/api/licenses');
  const lidKey = db.prepare("SELECT license_id FROM trials WHERE email = 'muhasebe@ornek.com.tr'").get().license_id;
  const item = list.data.licenses.find((x) => x.id === lidKey);
  assert.equal(item.trial, true);
  // düzenleme deneme işaretini kaldırmaz
  const lid = item.id;
  const ed = await panel('POST', `/panel/api/licenses/${lid}/update`, { customer: 'Örnek Lojistik A.Ş.', note: 'arandı', code: await code() });
  assert.equal(ed.status, 200, JSON.stringify(ed.data));
  assert.equal(JSON.parse(db.prepare('SELECT limits_json FROM licenses WHERE id = ?').get(lid).limits_json).deneme, 1);
  const ends = new Date(clock + 365 * 86400 * 1000).toISOString().slice(0, 10);
  const ex = await panel('POST', `/panel/api/licenses/${lid}/extend`, { ends, code: await code() });
  assert.equal(ex.status, 200, JSON.stringify(ex.data));
  assert.equal(JSON.parse(db.prepare('SELECT limits_json FROM licenses WHERE id = ?').get(lid).limits_json).deneme, undefined);
  r = await lic('check', { key: KEY, device_id: dev(1), device_name: 'ORNEKSRV', product: 'NPDK' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const p2 = await verifyToken(await signingPublicKey(env), r.data.token);
  assert.equal(p2.status, 'active');
  assert.equal(p2.limits.deneme, undefined);
  const ev = db.prepare("SELECT type FROM license_events WHERE license_id = ? ORDER BY id").all(lid).map((x) => x.type);
  assert.ok(ev.includes('Satın alındı'));
  const list2 = await panel('GET', '/panel/api/licenses');
  assert.equal(list2.data.licenses.find((x) => x.id === lid).trial, false);
});

console.log(`\n${passed} test geçti.`);
