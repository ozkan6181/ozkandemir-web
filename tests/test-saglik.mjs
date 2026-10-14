// ozkandemir.net — V3.14 NİS PDKS kurulum sağlık raporu testleri (/pdks-api/api.php a:'saglik', panel, uyarılar)
// Çalıştır: node tests/test-saglik.mjs — satıcı anahtarı test için üretilir; e-posta (Resend) taklit edilir.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createD1, createR2, createAssets } from './helpers/cf-local.mjs';
import { buildSigningKey, buildAdminSetup } from '../scripts/setup-lib.mjs';
import * as S from '../src/panel/security.js';
import { evaluate, parseTs, runHealthAlerts } from '../src/panel/saglik.js';
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
const nowS = () => Math.floor(clock / 1000);

const mails = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url === 'https://api.resend.com/emails') { mails.push(JSON.parse(init.body)); return new Response('{"id":"m"}', { status: 200 }); }
  return realFetch(input, init);
};

const b64 = (u8) => Buffer.from(u8).toString('base64');
const enc = (s) => new TextEncoder().encode(s);
const vendor = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const vendorPub = b64(new Uint8Array(await crypto.subtle.exportKey('raw', vendor.publicKey)));
async function legacyLicense(fields = {}, signer = vendor.privateKey) {
  const payload = enc(JSON.stringify({ v: 1, id: 'NIS-TEST-1', customer: 'Kitapseç Test', issued: '2026-01-01', valid_until: null,
    updates_until: null, max_users: null, modules: ['*'], machine: null, ...fields }));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, signer, payload));
  return ['-----BEGIN NIS PDKS LICENSE-----', b64(payload), b64(sig), '-----END NIS PDKS LICENSE-----'].join('\n') + '\n';
}

const schema = fs.readdirSync(path.join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => fs.readFileSync(path.join(ROOT, 'migrations', f), 'utf8')).join('\n');
const signing = await buildSigningKey();
const EMAIL = 'ozkan6181@hotmail.com', PASS = 'Cok-Guclu-Sifre-2026';
const setup = await buildAdminSetup({ email: EMAIL, password: PASS });
const env = {
  DB: createD1(schema), FILES: createR2(), ASSETS: createAssets(path.join(ROOT, 'public')),
  LICENSE_SIGNING_KEY: signing.secret, PDKS_VENDOR_PUBKEY: vendorPub, PANEL_ENC_KEY: setup.encKey, RESEND_API_KEY: 're_test',
};
await env.DB.exec(setup.sql);
const db = env.DB._db;
const SECRET = S.base32Decode(setup.secret);

async function call(body) {
  const res = await worker.fetch(new Request('https://ozkandemir.net/pdks-api/api.php', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.7' }, body: JSON.stringify(body),
  }), env);
  return { status: res.status, data: await res.json() };
}
// Türkiye saatiyle "YYYY-MM-DD HH:MM:SS"
const local = (sec) => new Date((sec + 3 * 3600) * 1000).toISOString().slice(0, 19).replace('T', ' ');
const healthy = (over = {}) => ({
  zaman: local(nowS()), surum: 'V1.46.0', veritabani: 'postgresql', sema: { mevcut: '0031', beklenen: '0031' }, arka_plan: true,
  isler: { queued: 0, dead: 0 },
  yedek: { db: { durum: 'ok', bitis: local(nowS() - 1800) }, secure: { durum: 'ok', bitis: local(nowS() - 3600) } },
  sifreli_yedek_acik: true, ikinci_yedek: { acik: true, durum: 'ok', bitis: local(nowS() - 7200) },
  disk: [{ surucu: 'C:\\', bos_gb: 40.5, seviye: 'ok' }, { surucu: 'D:\\', bos_gb: 182.4, seviye: 'ok' }],
  yol_kontrolu: { hata: 0, uyari: 0, zaman: local(nowS()) }, lisans: { durum: 'licensed', kalan_gun: 300 }, aktif_personel: 28, ...over,
});
const report = async (saglik, over = {}) => call({ a: 'saglik', machine: 'ABCD-1111', version: 'V1.46.0', host: 'KITAPSECRDP',
  license: await legacyLicense(), saglik, ...over });

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

await test('Kimliği doğrulanmayan rapor kaydedilmez; bozuk istek reddedilir', async () => {
  const other = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  let r = await report(healthy(), { license: await legacyLicense({}, other.privateKey) });
  assert.equal(r.status, 403);
  assert.equal(r.data.ok, false);
  r = await call({ a: 'saglik', machine: 'X', saglik: healthy() });
  assert.equal(r.status, 403);
  r = await report('yok');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Geçersiz istek/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pdks_health').get().n, 0);
});

await test('Rapor kaydedilir (kurulum başına son rapor); dakikada en fazla bir kayıt', async () => {
  let r = await report(healthy());
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ok, true);
  const row = db.prepare('SELECT * FROM pdks_health').get();
  assert.equal(row.customer, 'Kitapseç Test');
  assert.equal(row.host, 'KITAPSECRDP');
  assert.equal(row.machine, 'ABCD-1111');
  assert.equal(row.version, 'V1.46.0');
  tick(20);
  r = await report(healthy({ aktif_personel: 99 }));
  assert.equal(r.data.ok, true);
  assert.equal(JSON.parse(db.prepare('SELECT payload_json FROM pdks_health').get().payload_json).aktif_personel, 28, 'sık rapor yok sayılır');
  tick(61);
  r = await report(healthy({ aktif_personel: 30 }));
  assert.equal(JSON.parse(db.prepare('SELECT payload_json FROM pdks_health').get().payload_json).aktif_personel, 30);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pdks_health').get().n, 1);
});

await test('Değerlendirme: sağlıklı kurulumda sorun yok; kurallar tek tek', () => {
  const t = nowS();
  const row = (s, at = t) => ({ received_at: at, payload_json: JSON.stringify(s), license_state: 'active' });
  assert.equal(parseTs('2026-10-14 10:00:00'), Date.parse('2026-10-14T07:00:00Z') / 1000);
  let e = evaluate(row(healthy()), t);
  assert.deepEqual(e.issues, []);
  assert.equal(e.signal, 'green');
  assert.equal(e.minDisk.gb, 40.5);
  assert.equal(evaluate(row(healthy(), t - 3 * 3600), t).signal, 'yellow');
  e = evaluate(row(healthy(), t - 7 * 3600), t);
  assert.equal(e.signal, 'red');
  assert.ok(e.issues.some((i) => i.key === 'sinyal'));
  const keys = (s) => evaluate(row(s), t).issues.map((i) => i.key);
  assert.deepEqual(keys(healthy({ yedek: { db: { durum: 'ok', bitis: local(t - 3 * 3600) } } })), ['yedek_db']);
  assert.deepEqual(keys(healthy({ yedek: { db: { durum: 'hata', bitis: local(t) } } })), ['yedek_db']);
  assert.deepEqual(keys(healthy({ yedek: { db: { durum: 'ok', bitis: local(t) }, secure: { durum: 'ok', bitis: local(t - 27 * 3600) } } })), ['yedek_secure']);
  assert.deepEqual(keys(healthy({ sifreli_yedek_acik: false, yedek: { db: { durum: 'ok', bitis: local(t) }, secure: { durum: 'ok', bitis: local(t - 99 * 3600) } } })), [], 'şifreli yedek kapalıysa bakılmaz');
  assert.deepEqual(keys(healthy({ ikinci_yedek: { acik: true, durum: 'hata', bitis: local(t) } })), ['ikinci_yedek']);
  assert.deepEqual(keys(healthy({ ikinci_yedek: { acik: false, durum: 'hata' } })), []);
  assert.deepEqual(keys(healthy({ disk: [{ surucu: 'D:\\', bos_gb: 2.1, seviye: 'kritik' }] })), ['disk']);
  assert.deepEqual(keys(healthy({ yol_kontrolu: { hata: 2, uyari: 0 } })), ['yol']);
  assert.deepEqual(keys(healthy({ isler: { queued: 0, dead: 3 } })), ['isler']);
  assert.deepEqual(keys(healthy({ arka_plan: false })), ['arka_plan']);
  e = evaluate(row(healthy({ disk: [{ surucu: 'C:\\', bos_gb: 9, seviye: 'uyari' }], lisans: { kalan_gun: 12 } })), t);
  assert.deepEqual(e.issues, []);
  assert.equal(e.warnings.length, 2, 'uyarılar e-posta değil, yalnız gösterilir');
});

await test('Uyarı e-postası: sorun başına günde bir; düzelince sayaç sıfırlanır; zamanlanmış görev çalıştırır', async () => {
  tick(61);
  await report(healthy({ disk: [{ surucu: 'D:\\', bos_gb: 1.2, seviye: 'kritik' }] }));
  const n = mails.length;
  await worker.scheduled({ cron: '*/30 * * * *' }, env, { waitUntil: (p) => p });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mails.length, n + 1, 'zamanlanmış görev uyarı gönderir');
  const m = mails.at(-1);
  assert.deepEqual(m.to, ['info@ozkandemir.net']);
  assert.match(m.subject, /^\[PDKS uyarı\] Kitapseç Test — KITAPSECRDP: Disk alanı kritik/);
  tick(1800);
  assert.equal(await runHealthAlerts(env, nowS()), 0, 'aynı sorun aynı gün tekrar bildirilmez');
  tick(61);
  await report(healthy({ disk: [{ surucu: 'D:\\', bos_gb: 1.2, seviye: 'kritik' }], yol_kontrolu: { hata: 1, uyari: 0 } }));
  assert.equal(await runHealthAlerts(env, nowS()), 1, 'yeni sorun hemen bildirilir');
  assert.match(mails.at(-1).text, /daha önce bildirildi/);
  tick(61);
  await report(healthy());
  assert.equal(await runHealthAlerts(env, nowS()), 0);
  assert.equal(db.prepare('SELECT alerts_json FROM pdks_health').get().alerts_json, '{}', 'düzelen sorunların sayacı silinir');
  tick(7 * 3600);
  assert.equal(await runHealthAlerts(env, nowS()), 1, '6 saatten uzun sinyal yok');
  assert.match(mails.at(-1).text, /sinyal yok/);
});

await test('Panel: liste (oturum gerekir) ve izlemeden kaldırma', async () => {
  assert.equal((await panel('GET', '/panel/api/health')).status, 401);
  const r1 = await panel('POST', '/panel/api/login', { email: EMAIL, password: PASS });
  const r2 = await panel('POST', '/panel/api/verify', { challenge: r1.data.challenge, code: await S.hotp(SECRET, Math.floor(S.now() / 30)) });
  assert.equal(r2.status, 200, JSON.stringify(r2.data));
  const l = await panel('GET', '/panel/api/health');
  assert.equal(l.status, 200, JSON.stringify(l.data));
  assert.equal(l.data.list.length, 1);
  const x = l.data.list[0];
  assert.equal(x.signal, 'red');
  assert.equal(x.problems, undefined);
  assert.equal(l.data.problems, 1);
  assert.equal(x.staff, 28);
  assert.equal(x.minDisk.gb, 40.5);
  assert.equal((await panel('POST', '/panel/api/health/remove', { owner: x.owner, machine: x.machine })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pdks_health').get().n, 0);
  assert.equal((await panel('POST', '/panel/api/health/remove', { owner: x.owner, machine: x.machine })).status, 404);
});

console.log(`\n${passed} test geçti.`);
