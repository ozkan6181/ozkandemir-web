// ozkandemir.net — NİS PDKS güncelleme ve destek kanalı testleri (/pdks-api/api.php)
// Çalıştır: node tests/test-pdks-updates.mjs
// Gerçek satıcı anahtarı KULLANILMAZ: test kendi Ed25519 anahtarını üretir (env.PDKS_VENDOR_PUBKEY).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createD1, createR2, createAssets } from './helpers/cf-local.mjs';
import { buildSigningKey, buildAdminSetup } from '../scripts/setup-lib.mjs';
import * as S from '../src/panel/security.js';
import { retrySupportMail, mailFor } from '../src/panel/destek.js';
import { signPayload } from '../src/panel/license.js';
import { readZipManifest, buildChain, vcmp, VENDOR_PUBKEY } from '../src/panel/pdks-updates.js';
import worker from '../src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); passed++; out.push('  ✓ ' + name); }
  catch (e) { out.push('  ✗ ' + name + '\n    ' + (e && e.stack || e)); console.log(out.join('\n')); process.exit(1); }
}

// ---------- yardımcılar ----------
const b64 = (u8) => Buffer.from(u8).toString('base64');
const enc = (s) => new TextEncoder().encode(s);
async function deflateRaw(u8) {
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
}
// En küçük ZIP yazıcı (deflate); [{name, data, store?}]
async function makeZip(entries) {
  const parts = [], central = [];
  let off = 0;
  for (const e of entries) {
    const name = enc(e.name), raw = typeof e.data === 'string' ? enc(e.data) : e.data;
    const data = e.store ? raw : await deflateRaw(raw);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(8, e.store ? 0 : 8, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, raw.length, true); lh.setUint16(26, name.length, true);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(10, e.store ? 0 : 8, true);
    ch.setUint32(20, data.length, true); ch.setUint32(24, raw.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
    parts.push(new Uint8Array(lh.buffer), name, data);
    central.push(new Uint8Array(ch.buffer), name);
    off += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((s, x) => s + x.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(8, entries.length, true); eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true); eocd.setUint32(16, off, true);
  return new Uint8Array(Buffer.concat([...parts, ...central, new Uint8Array(eocd.buffer)]));
}
const pkg = (from, to, opts = {}) => makeZip([
  { name: `PDKS_${to}_guncelleme/GUNCELLE_${to.replace(/\./g, '')}.py`, data: 'print("x")\n' },
  { name: `PDKS_${to}_guncelleme/manifest.imza.json`, data: '{"signature":"..."}' },
  { name: `PDKS_${to}_guncelleme/manifest.json`, data: JSON.stringify({ from_version: from, to_version: to, files: [] }), store: opts.store },
]);

// Test satıcı anahtarı ve eski .lic lisansı (programdaki biçimin aynısı)
const vendor = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const vendorPub = b64(new Uint8Array(await crypto.subtle.exportKey('raw', vendor.publicKey)));
async function legacyLicense(fields, signer = vendor.privateKey) {
  const payload = enc(JSON.stringify({ v: 1, id: 'NIS-TEST-1', customer: 'Kitapseç Test', issued: '2026-01-01', valid_until: null,
    updates_until: null, max_users: null, modules: ['*'], machine: null, ...fields }));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, signer, payload));
  return ['-----BEGIN NIS PDKS LICENSE-----', b64(payload), b64(sig), '-----END NIS PDKS LICENSE-----'].join('\n') + '\n';
}

// ---------- ortam ----------
const schema = fs.readdirSync(path.join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => fs.readFileSync(path.join(ROOT, 'migrations', f), 'utf8')).join('\n');
const signing = await buildSigningKey();
const EMAIL = 'ozkan6181@hotmail.com', PASS = 'Cok-Guclu-Sifre-2026';
const setup = await buildAdminSetup({ email: EMAIL, password: PASS });
const env = {
  DB: createD1(schema), FILES: createR2(), ASSETS: createAssets(path.join(ROOT, 'public')),
  LICENSE_SIGNING_KEY: signing.secret, PDKS_VENDOR_PUBKEY: vendorPub, PANEL_ENC_KEY: setup.encKey,
};
await env.DB.exec(setup.sql);
const db = env.DB._db;
const T = Math.floor(Date.now() / 1000);
const pid = db.prepare("SELECT id FROM programs WHERE slug = 'nis-pdks'").get();
assert.ok(pid, 'nis-pdks programı tohumlanmış olmalı');
const otherPid = db.prepare("SELECT id FROM programs WHERE slug = 'cari360'").get().id;
let vid = 0;
async function addVersion(label, filename, bytes, { status = 'ready', program = pid.id, at = T, sha = true, publish = true } = {}) {
  const key = `programs/${program}/${++vid}/${filename}`;
  await env.FILES.put(key, bytes);
  const sha256 = sha ? Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex') : null;
  db.prepare('INSERT INTO versions (program_id, version, filename, size, sha256, notes, r2_key, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(program, label, filename, bytes.length, sha256, `${label} notu`, key, status, at);
  const id = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  if (publish) db.prepare('INSERT INTO releases (version_id, program_id, mandatory, public_notes, published_at) VALUES (?, ?, 0, NULL, ?)').run(id, program, at);
  return { key, sha256, bytes };
}

const P = {};
P['1.31.0'] = await addVersion('V1.31.0', 'PDKS_V1.31.0_guncelleme.zip', await pkg('V1.30.2', 'V1.31.0'), { at: T - 3 * 86400 });
P['1.32.0'] = await addVersion('V1.32.0', 'PDKS_V1.32.0_guncelleme.zip', await pkg('V1.31.0', 'V1.32.0', { store: true }), { at: T - 2 * 86400 });
// Panelde sürüm etiketi farklı yazılmış olsa da zincir paketin içindeki manifest'ten kurulur
P['1.32.1'] = await addVersion('V1.32.1-guncelleme', 'PDKS_V1.32.1_guncelleme.zip', await pkg('V1.32.0', 'V1.32.1'), { at: T - 86400 });
await addVersion('V1.32.1', 'NIS_PDKS_Kurulum_V1.32.1.exe', enc('MZ setup'), { at: T - 86400 });               // Setup.exe: zincir dışı
await addVersion('V1.33.0', 'PDKS_V1.33.0_guncelleme.zip', await pkg('V1.32.1', 'V1.33.0'), { status: 'uploading' }); // yüklemesi bitmemiş
await addVersion('V9.0.0', 'PDKS_V9.0.0_guncelleme.zip', await pkg('V1.32.1', 'V9.0.0'), { program: otherPid });     // başka program
await addVersion('V1.31.5', 'PDKS_V1.31.5_guncelleme.zip', enc('bozuk zip'));                                      // okunamayan paket
await addVersion('V1.32.2', 'PDKS_V1.32.2_guncelleme.zip', await pkg('V1.32.1', 'V1.32.2'), { publish: false });    // yüklendi ama yayınlanmadı

async function call(body, { method = 'POST', raw = false } = {}) {
  const res = await worker.fetch(new Request('https://ozkandemir.net/pdks-api/api.php', {
    method, headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.7' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  }), env);
  if (raw) return res;
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const base = { machine: 'ABCD-1111-2222-3333', host: 'KITAPSECRDP' };

// ---------- testler ----------
await test('Sürüm karşılaştırma ve zincir kurma', () => {
  assert.ok(vcmp('V1.32.1', 'V1.32.0') > 0 && vcmp('V1.9.0', 'V1.10.0') < 0 && vcmp('1.30.2', 'V1.30.2') === 0);
  const rels = [{ id: 1, version: 'V1.31.0', from: 'V1.30.2', released: '2026-10-09' }, { id: 2, version: 'V1.32.0', from: 'V1.31.0', released: '2026-10-10' },
    { id: 3, version: 'V1.31.1', from: 'V1.30.2', released: '2026-10-10' }];
  assert.deepEqual(buildChain(rels, 'V1.30.2').chain.map((c) => c.version), ['V1.31.1'], 'aynı sürümden çıkan en yüksek hedef');
  assert.deepEqual(buildChain(rels, 'V1.31.0').chain.map((c) => c.version), ['V1.32.0']);
  const b = buildChain(rels.slice(0, 2), 'V1.30.2', '2026-10-09');
  assert.deepEqual([b.chain.map((c) => c.version), b.blocked.map((c) => c.version)], [['V1.31.0'], ['V1.32.0']]);
  assert.deepEqual(buildChain(rels, 'V1.29.0').chain, [], 'zincir dışı sürüm için paket yok');
  assert.match(VENDOR_PUBKEY, /^[A-Za-z0-9+/]{43}=$/);
});

await test('ZIP içinden manifest okunur (deflate ve sıkıştırmasız)', async () => {
  assert.equal((await readZipManifest(P['1.31.0'].bytes)).to_version, 'V1.31.0');
  assert.equal((await readZipManifest(P['1.32.0'].bytes)).from_version, 'V1.31.0');
  assert.equal(await readZipManifest(enc('zip değil')), null);
});

await test('GET: servis ayakta', async () => {
  const r = await call(null, { method: 'GET' });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
});

await test('Eski .lic lisansı (Kitapseç): V1.30.2 → 3 adımlı zincir, Setup.exe / yarım yükleme / başka program / bozuk / yayınlanmamış paket hariç', async () => {
  const license = await legacyLicense({});
  const r = await call({ ...base, a: 'check', version: 'V1.30.2', license });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ok, true);
  assert.deepEqual(r.data.chain.map((c) => [c.from, c.version]), [['V1.30.2', 'V1.31.0'], ['V1.31.0', 'V1.32.0'], ['V1.32.0', 'V1.32.1']]);
  assert.equal(r.data.latest, 'V1.32.1');
  assert.equal(r.data.chain[0].sha256, P['1.31.0'].sha256);
  assert.equal(r.data.chain[0].size, P['1.31.0'].bytes.length);
  assert.equal(r.data.chain[2].notes, 'V1.32.1-guncelleme notu');
  assert.equal(r.data.auto_stop, false);
  const r2 = await call({ ...base, a: 'check', version: 'V1.32.1', license });
  assert.deepEqual(r2.data.chain, []);
  assert.equal(r2.data.latest, 'V1.32.1');
});

await test('İndirme: zincirdeki paket aynen gelir; zincir dışı / bilinmeyen sürüm reddedilir', async () => {
  const license = await legacyLicense({});
  const res = await call({ ...base, a: 'download', version: 'V1.30.2', target: 'V1.32.0', license }, { raw: true });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  const got = new Uint8Array(await res.arrayBuffer());
  assert.equal(Buffer.from(got).toString('hex'), Buffer.from(P['1.32.0'].bytes).toString('hex'));
  assert.equal((await call({ ...base, a: 'download', version: 'V1.32.0', target: 'V1.31.0', license })).status, 403, 'geri sürüm');
  assert.equal((await call({ ...base, a: 'download', version: 'V1.30.2', target: 'V1.33.0', license })).status, 403, 'yarım yükleme');
  assert.equal((await call({ ...base, a: 'download', version: 'V1.30.2', target: 'V9.0.0', license })).status, 403, 'başka program');
  assert.equal((await call({ ...base, a: 'download', version: 'V1.32.1', target: 'V1.32.2', license })).status, 403, 'yayınlanmamış');
});

await test('Eski lisans: imza, makine ve güncelleme hakkı kontrolü', async () => {
  const other = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  let r = await call({ ...base, a: 'check', version: 'V1.30.2', license: await legacyLicense({}, other.privateKey) });
  assert.equal(r.status, 403, 'başka anahtarla imzalı');
  const good = await legacyLicense({});
  const lines = good.trim().split('\n');
  const p = JSON.parse(Buffer.from(lines[1], 'base64').toString()); p.updates_until = '2099-01-01';
  lines[1] = Buffer.from(JSON.stringify(p)).toString('base64');
  assert.equal((await call({ ...base, a: 'check', version: 'V1.30.2', license: lines.join('\n') })).status, 403, 'içeriği değiştirilmiş');
  r = await call({ ...base, a: 'check', version: 'V1.30.2', license: await legacyLicense({ machine: 'FFFF-0000-0000-0000' }) });
  assert.equal(r.status, 403, 'başka sunucunun lisansı');
  r = await call({ ...base, a: 'check', version: 'V1.30.2', license: await legacyLicense({ machine: 'abcd-1111-2222-3333' }) });
  assert.equal(r.status, 200, 'aynı makine (büyük/küçük harf)');
  // Güncelleme hakkı: yayın tarihi hak bitişinden sonra olan sürümler "blocked"
  const until = new Date((T - 2 * 86400 + 3 * 3600) * 1000).toISOString().slice(0, 10);
  r = await call({ ...base, a: 'check', version: 'V1.30.2', license: await legacyLicense({ updates_until: until }) });
  assert.deepEqual(r.data.chain.map((c) => c.version), ['V1.31.0', 'V1.32.0']);
  assert.deepEqual(r.data.blocked.map((c) => c.version), ['V1.32.1']);
  const d = await call({ ...base, a: 'download', version: 'V1.32.0', target: 'V1.32.1', license: await legacyLicense({ updates_until: until }) });
  assert.equal(d.status, 403, 'hak dışı sürüm indirilemez');
  assert.equal((await call({ ...base, a: 'check', version: 'V1.30.2' })).status, 403, 'kimliksiz');
  assert.equal((await call({ ...base, a: 'check', version: 'V1.30.2', license: 'çöp' })).status, 403);
});

// Panel lisansı (NPDK anahtarı) — programın data/lisans/lisans.json metni
db.prepare("INSERT INTO licenses (program_id, key_hash, key_enc, key_mask, customer, starts_at, ends_at, max_devices, status, created_at, updated_at) VALUES (?, 'h1', 'e1', 'NPDK-AAAA-••••-••••-BBBB', 'Panel Müşterisi', ?, ?, 1, 'active', ?, ?)")
  .run(pid.id, T - 86400, T + 300 * 86400, T, T);
const lid = db.prepare("SELECT id FROM licenses WHERE customer = 'Panel Müşterisi'").get().id;
const DEV = 'ab'.repeat(32);
db.prepare('INSERT INTO activations (license_id, device_id, device_name, app_version, activated_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)').run(lid, DEV, 'SRV', 'V1.31.0', T, T);
async function odl(over = {}) {
  const token = await signPayload(env, { v: 1, typ: 'od-license', lid, product: 'NPDK', device: DEV, status: 'active', iat: T, ...over });
  return JSON.stringify({ key: 'NPDK-AAAA-CCCC-DDDD-BBBB', token, last_check: T });
}

await test('Panel lisansı: zincir + programın sürümü panele işlenir', async () => {
  const r = await call({ ...base, a: 'check', version: 'V1.31.0', odl: await odl() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.chain.map((c) => c.version), ['V1.32.0', 'V1.32.1']);
  const res = await call({ ...base, a: 'download', version: 'V1.31.0', target: 'V1.32.0', odl: await odl() }, { raw: true });
  assert.equal(res.status, 200);
  await call({ ...base, a: 'check', version: 'V1.32.0', odl: await odl() });
  assert.equal(db.prepare('SELECT app_version FROM activations WHERE license_id = ?').get(lid).app_version, 'V1.32.0');
});

await test('Panel lisansı: sahte belge, başka ürün, askı, süre, kaldırılmış cihaz reddedilir', async () => {
  const fake = await buildSigningKey();
  const env2 = { ...env, LICENSE_SIGNING_KEY: fake.secret };
  const forged = JSON.stringify({ token: await signPayload(env2, { v: 1, typ: 'od-license', lid, product: 'NPDK', device: DEV }) });
  assert.equal((await call({ ...base, a: 'check', version: 'V1.31.0', odl: forged })).status, 403, 'başka anahtarla imzalı');
  assert.equal((await call({ ...base, a: 'check', version: 'V1.31.0', odl: await odl({ product: 'C360' }) })).status, 403);
  assert.equal((await call({ ...base, a: 'check', version: 'V1.31.0', odl: '{bozuk' })).status, 403);
  db.prepare("UPDATE licenses SET status = 'suspended' WHERE id = ?").run(lid);
  let r = await call({ ...base, a: 'check', version: 'V1.31.0', odl: await odl() });
  assert.equal(r.status, 403); assert.match(r.data.error, /askı/);
  db.prepare("UPDATE licenses SET status = 'active', ends_at = ? WHERE id = ?").run(T - 10, lid);
  r = await call({ ...base, a: 'check', version: 'V1.31.0', odl: await odl() });
  assert.equal(r.status, 403); assert.match(r.data.error, /süresi/);
  db.prepare('UPDATE licenses SET ends_at = ? WHERE id = ?').run(T + 300 * 86400, lid);
  db.prepare('UPDATE activations SET removed_at = ? WHERE license_id = ?').run(T, lid);
  r = await call({ ...base, a: 'check', version: 'V1.31.0', odl: await odl() });
  assert.equal(r.status, 403); assert.match(r.data.error, /kaldırılmış/);
  db.prepare('UPDATE activations SET removed_at = NULL WHERE license_id = ?').run(lid);
  assert.equal((await call({ ...base, a: 'check', version: 'V1.31.0', odl: await odl() })).status, 200);
});

await test('Acil durdurma ve henüz etkin olmayan işlemler', async () => {
  env.PDKS_AUTO_STOP = '1';
  const r = await call({ ...base, a: 'check', version: 'V1.30.2', license: await legacyLicense({}) });
  assert.equal(r.data.auto_stop, true);
  delete env.PDKS_AUTO_STOP;
  for (const a of ['tunnel_create', 'tunnel_delete', 'olmayan']) {
    const x = await call({ ...base, a, license: await legacyLicense({}) });
    assert.equal(x.status, 404); assert.equal(x.data.ok, false);
  }
});

// ================= Destek soruları (Yardım › Cevabımı bulamadım) =================
const sent = [];
const mailOk = { async send(m) { sent.push(m); return { messageId: 'm' + sent.length }; } };
let asked = 0;
const question = (over = {}) => ({ ...base, a: 'support_question', version: 'V1.32.1', app_version: 'V1.32.1', question: 'Fazla mesai raporunu nereden alırım?',
  contact: 'muhasebe@kitapsec.example', page: '/reports', user_type: 'yonetici', lang: 'tr', search: 'fazla mesai rapor',
  asked_at: `2026-10-11 09:${String(++asked).padStart(2, '0')}:00`, ...over });
const rows = () => db.prepare('SELECT * FROM support_questions ORDER BY id').all();

await test('Destek: eski lisansla gelen soru kaydedilir ve info@ozkandemir.net adresine e-posta gider', async () => {
  env.SUPPORT_MAIL = mailOk;
  const r = await call(question({ license: await legacyLicense({}) }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ok, true);
  const q = rows().at(-1);
  assert.equal(q.customer, 'Kitapseç Test');
  assert.equal(q.mail_state, 'sent');
  assert.equal(q.user_type, 'yonetici');
  assert.equal(sent.length, 1);
  const m = sent[0];
  assert.equal(m.to, 'info@ozkandemir.net');
  assert.equal(m.from.email, 'destek@ozkandemir.net');
  assert.equal(m.replyTo, 'muhasebe@kitapsec.example', 'yanıt doğrudan soran kişiye');
  assert.match(m.subject, /^\[NİS PDKS Destek #\d+\] Kitapseç Test — Fazla mesai/);
  assert.match(m.text, /Soru:\nFazla mesai raporunu nereden alırım\?/);
  assert.match(m.text, /Ekran: \/reports/);
});

await test('Destek: aynı sorunun yeniden gönderimi tek kayıt; telefonla iletişimde yanıt adresi yok', async () => {
  const lic = await legacyLicense({});
  const body = question({ license: lic, contact: '0532 000 00 00' });
  const a = await call(body), b = await call(body);
  assert.equal(a.data.id, b.data.id);
  assert.equal(b.data.duplicate, true);
  assert.equal(rows().filter((x) => x.contact === '0532 000 00 00').length, 1);
  assert.equal(sent.at(-1).replyTo, undefined);
});

await test('Destek: e-posta kurulmamışsa ya da gönderilemezse soru kaybolmaz, sonra yeniden denenir', async () => {
  delete env.SUPPORT_MAIL;
  const n = sent.length;
  let r = await call(question({ license: await legacyLicense({}) }));
  assert.equal(r.status, 200);
  let q = rows().at(-1);
  assert.equal(q.mail_state, 'pending');
  assert.match(q.mail_error, /SUPPORT_MAIL/);
  env.SUPPORT_MAIL = { async send() { const e = new Error('Sender not verified'); e.code = 'E_SENDER_NOT_VERIFIED'; throw e; } };
  r = await call(question({ license: await legacyLicense({}) }));
  assert.equal(r.status, 200, 'e-posta hatası programa hata olarak dönmez (aksi halde soru programda bekler)');
  q = rows().at(-1);
  assert.equal(q.mail_state, 'pending');
  assert.match(q.mail_error, /E_SENDER_NOT_VERIFIED/);
  env.SUPPORT_MAIL = mailOk;
  assert.equal(await retrySupportMail(env), 2);
  assert.equal(sent.length, n + 2);
  assert.equal(rows().filter((x) => x.mail_state !== 'sent').length, 0);
});

await test('Destek: panel lisansı; süresi dolmuş / askıdaki müşteri sorabilir, iptal / sahte / kısa soru reddedilir', async () => {
  let r = await call(question({ odl: await odl() }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(rows().at(-1).customer, 'Panel Müşterisi');
  db.prepare('UPDATE licenses SET ends_at = ? WHERE id = ?').run(T - 10, lid);
  r = await call(question({ odl: await odl() }));
  assert.equal(r.status, 200);
  assert.equal(rows().at(-1).license_state, 'expired');
  assert.match(sent.at(-1).text, /lisans: expired/);
  db.prepare("UPDATE licenses SET status = 'revoked', ends_at = ? WHERE id = ?").run(T + 300 * 86400, lid);
  assert.equal((await call(question({ odl: await odl() }))).status, 403, 'iptal');
  db.prepare("UPDATE licenses SET status = 'active' WHERE id = ?").run(lid);
  const other = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  assert.equal((await call(question({ license: await legacyLicense({}, other.privateKey) }))).status, 403, 'sahte lisans');
  assert.equal((await call(question({}))).status, 403, 'kimliksiz');
  assert.equal((await call(question({ license: await legacyLicense({}), question: 'kısa' }))).status, 400);
  assert.equal((await call(question({ license: await legacyLicense({}), question: 'x'.repeat(1501) }))).status, 400);
});

await test('Destek: e-posta metni güvenli (alıcı ve gönderen sabit, yanıt adresi yalnız geçerli e-postaysa)', () => {
  const m = mailFor({ id: 7, customer: 'A', program: 'NİS PDKS', question: 'Soru\nBcc: x@y.z', contact: 'a@b.c\nBcc: evil@x.y', received_at: T }, {});
  assert.equal(m.to, 'info@ozkandemir.net');
  assert.equal(m.replyTo, undefined, 'satır sonu içeren iletişim yanıt adresi olamaz');
  assert.ok(!/\n/.test(m.subject), 'konu tek satır');
});

await test('Destek: RESEND_API_KEY varsa e-posta Resend API ile gider; Resend hatası soruyu kaybettirmez', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  let fail = false;
  globalThis.fetch = async (url, init) => {
    if (String(url) !== 'https://api.resend.com/emails') return realFetch(url, init);
    calls.push({ url: String(url), init });
    if (fail) return new Response(JSON.stringify({ name: 'validation_error', message: 'The ozkandemir.net domain is not verified.' }), { status: 403, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ id: 're_' + calls.length }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const savedMail = env.SUPPORT_MAIL;
  delete env.SUPPORT_MAIL;
  env.RESEND_API_KEY = 're_test_key';
  try {
    let r = await call(question({ license: await legacyLicense({}) }));
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(rows().at(-1).mail_state, 'sent');
    assert.equal(calls.length, 1);
    const c = calls[0];
    assert.equal(c.init.method, 'POST');
    assert.equal(new Headers(c.init.headers).get('authorization'), 'Bearer re_test_key');
    const b = JSON.parse(c.init.body);
    assert.equal(b.from, 'NİS PDKS Destek <destek@ozkandemir.net>');
    assert.deepEqual(b.to, ['info@ozkandemir.net']);
    assert.equal(b.reply_to, 'muhasebe@kitapsec.example');
    assert.match(b.subject, /^\[NİS PDKS Destek #\d+\]/);
    assert.match(b.text, /Fazla mesai raporunu/);
    fail = true;
    r = await call(question({ license: await legacyLicense({}) }));
    assert.equal(r.status, 200);
    const q = rows().at(-1);
    assert.equal(q.mail_state, 'pending');
    assert.match(q.mail_error, /validation_error/);
    fail = false;
    assert.equal(await retrySupportMail(env), 1);
    assert.equal(rows().at(-1).mail_state, 'sent');
  } finally {
    globalThis.fetch = realFetch;
    delete env.RESEND_API_KEY;
    env.SUPPORT_MAIL = savedMail;
  }
});

// Panel: Destek soruları kartı
const ORIGIN = 'https://ozkandemir.net';
const jar = {};
async function panel(method, p, body) {
  const h = new Headers({ 'cf-connecting-ip': '203.0.113.10', 'user-agent': 'Test' });
  if (method !== 'GET') { h.set('x-od-panel', '1'); h.set('origin', ORIGIN); }
  const ck = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  if (ck) h.set('cookie', ck);
  if (body !== undefined) h.set('content-type', 'application/json');
  const res = await worker.fetch(new Request(ORIGIN + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined }), env);
  for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

await test('Panel: destek soruları listelenir, yanıtlandı işaretlenir; oturumsuz erişilemez', async () => {
  assert.equal((await panel('GET', '/panel/api/support')).status, 401);
  const r1 = await panel('POST', '/panel/api/login', { email: EMAIL, password: PASS });
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  const code = await S.hotp(S.base32Decode(setup.secret), Math.floor(S.now() / 30));
  const r2 = await panel('POST', '/panel/api/verify', { challenge: r1.data.challenge, code });
  assert.equal(r2.status, 200, JSON.stringify(r2.data));
  let l = await panel('GET', '/panel/api/support');
  assert.equal(l.status, 200, JSON.stringify(l.data));
  const total = rows().length;
  assert.equal(l.data.open, total);
  assert.equal(l.data.to, 'info@ozkandemir.net');
  assert.equal(l.data.mailReady, true);
  const first = l.data.list.find((q) => q.contact === 'muhasebe@kitapsec.example');
  assert.equal(first.contactIsEmail, true);
  assert.equal((await panel('POST', `/panel/api/support/${first.id}/answered`, {})).status, 200);
  l = await panel('GET', '/panel/api/support');
  assert.equal(l.data.open, total - 1);
  assert.ok(!l.data.list.some((q) => q.id === first.id), 'yanıtlanan bekleyenlerde görünmez');
  l = await panel('GET', '/panel/api/support?hepsi=1');
  assert.ok(l.data.list.some((q) => q.id === first.id && q.answered));
  assert.equal((await panel('POST', `/panel/api/support/${first.id}/answered`, { reopen: true })).status, 200);
  assert.equal((await panel('GET', '/panel/api/support')).data.open, total);
  assert.equal((await panel('POST', '/panel/api/support/99999/answered', {})).status, 404);
});

await test('Panel: deneme e-postası sabit adrese gider, dakikada bir; kurulum yoksa açık hata', async () => {
  const saved = env.SUPPORT_MAIL;
  delete env.SUPPORT_MAIL;
  let r = await panel('POST', '/panel/api/support/test-mail', {});
  assert.equal(r.status, 400); assert.match(r.data.error, /RESEND_API_KEY/);
  env.SUPPORT_MAIL = mailOk;
  const n = sent.length;
  r = await panel('POST', '/panel/api/support/test-mail', { to: 'baska@x.y' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(sent.length, n + 1);
  assert.equal(sent.at(-1).to, 'info@ozkandemir.net');
  assert.match(sent.at(-1).subject, /Deneme/);
  assert.equal((await panel('POST', '/panel/api/support/test-mail', {})).status, 429);
  env.SUPPORT_MAIL = saved;
});

console.log(out.join('\n'));
console.log(`\n${passed} test geçti.`);
