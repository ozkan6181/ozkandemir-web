// ozkandemir.net V3.6 — Panel güvenlik ve uçtan uca testleri
// Çalıştır: node tests/test-panel.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createD1, createR2, createAssets } from './helpers/cf-local.mjs';
import * as S from '../src/panel/security.js';
import { CFG } from '../src/panel/panel.js';
import { buildAdminSetup } from '../scripts/setup-lib.mjs';
import worker from '../src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push('  ✓ ' + name); }
  catch (e) { results.push('  ✗ ' + name + '\n    ' + (e && e.stack || e)); console.log(results.join('\n')); process.exit(1); }
}

// Sahte saat (TOTP adımlarını ilerletmek için)
let clock = Date.now();
const realNow = Date.now;
Date.now = () => clock;
const tick = (sec) => { clock += sec * 1000; };

// ================= Birim testleri =================
await test('TOTP RFC 6238 test vektörü (SHA-1, T=59 → 94287082)', async () => {
  const secret = new TextEncoder().encode('12345678901234567890');
  assert.equal(await S.hotp(secret, Math.floor(59 / 30), 8), '94287082');
  assert.equal(await S.hotp(secret, Math.floor(1111111109 / 30), 8), '07081804');
  assert.equal(await S.hotp(secret, Math.floor(20000000000 / 30), 8), '65353130');
});

await test('TOTP doğrulama: pencere ±1 adım, tekrar kullanım engeli, biçim', async () => {
  const sec = S.randomBytes(20), t = 1_800_000_000, step = Math.floor(t / 30);
  const code = await S.hotp(sec, step);
  assert.equal(await S.verifyTotp(sec, code, 0, t), step);
  assert.equal(await S.verifyTotp(sec, code, step, t), null, 'aynı kod ikinci kez geçmemeli');
  assert.equal(await S.verifyTotp(sec, await S.hotp(sec, step - 1), 0, t), step - 1);
  assert.equal(await S.verifyTotp(sec, await S.hotp(sec, step - 2), 0, t), null);
  assert.equal(await S.verifyTotp(sec, 'abcdef', 0, t), null);
});

await test('Base32 gidiş-dönüş', async () => {
  for (let i = 0; i < 20; i++) {
    const b = S.randomBytes(1 + i);
    assert.deepEqual([...S.base32Decode(S.base32Encode(b))], [...b]);
  }
  assert.equal(S.base32Encode(new TextEncoder().encode('foobar')), 'MZXW6YTBOI');
});

await test('PBKDF2 şifre özeti ve doğrulama', async () => {
  const h = await S.hashPassword('Dogru-Sifre-2026');
  assert.match(h, /^pbkdf2-sha256\$100000\$/);
  assert.equal(await S.verifyPassword('Dogru-Sifre-2026', h), true);
  assert.equal(await S.verifyPassword('dogru-sifre-2026', h), false);
  assert.equal(await S.verifyPassword('x', 'bozuk'), false);
  assert.notEqual(await S.hashPassword('aynı'), await S.hashPassword('aynı'), 'tuz her seferinde farklı olmalı');
});

await test('Şifre kuralı', () => {
  assert.ok(S.passwordProblem('kisa'));
  assert.ok(S.passwordProblem('sadecekucukharf123'));
  assert.equal(S.passwordProblem('Guclu-Bir-Sifre-2026'), '');
});

await test('AES-GCM: şifrele/çöz, yanlış anahtar reddedilir', async () => {
  const k1 = S.b64(S.randomBytes(32)), k2 = S.b64(S.randomBytes(32));
  const e = await S.encryptText(k1, 'GIZLI');
  assert.equal(await S.decryptText(k1, e), 'GIZLI');
  await assert.rejects(S.decryptText(k2, e));
});

await test('Cloudflare Access JWT: geçerli / yanlış aud / süresi dolmuş / değiştirilmiş', async () => {
  S._resetAccessCache();
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1' };
  const fakeFetch = async () => new Response(JSON.stringify({ keys: [jwk] }));
  const team = 'ozkan.cloudflareaccess.com';
  const enc = (o) => S.b64url(new TextEncoder().encode(JSON.stringify(o)));
  const sign = async (payload) => {
    const h = enc({ alg: 'RS256', kid: 'k1' }), p = enc(payload);
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(h + '.' + p));
    return `${h}.${p}.${S.b64url(sig)}`;
  };
  const t = S.now();
  const good = await sign({ aud: ['AUD1'], iss: `https://${team}`, exp: t + 600, email: 'a@b.c' });
  assert.ok(await S.verifyAccessJwt(good, team, 'AUD1', fakeFetch));
  assert.equal(await S.verifyAccessJwt(good, team, 'BASKA', fakeFetch), null);
  assert.equal(await S.verifyAccessJwt(await sign({ aud: ['AUD1'], iss: `https://${team}`, exp: t - 5 }), team, 'AUD1', fakeFetch), null);
  const parts = good.split('.');
  const tampered = parts[0] + '.' + enc({ aud: ['AUD1'], iss: `https://${team}`, exp: t + 600, email: 'saldirgan@x.y' }) + '.' + parts[2];
  assert.equal(await S.verifyAccessJwt(tampered, team, 'AUD1', fakeFetch), null);
  globalThis.__accessKit = { sign, jwk, team };
});

// ================= Uçtan uca =================
CFG.PART_SIZE = 5 * 1024 * 1024; // testte daha küçük parçalar
const schema = fs.readdirSync(path.join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort().map((f) => fs.readFileSync(path.join(ROOT, 'migrations', f), 'utf8')).join('\n');
const EMAIL = 'ozkan6181@hotmail.com', PASS = 'Cok-Guclu-Sifre-2026';
const setup = await buildAdminSetup({ email: EMAIL, password: PASS });
const env = { DB: createD1(schema), FILES: createR2(), PANEL_ENC_KEY: setup.encKey, ASSETS: createAssets(path.join(ROOT, 'public')) };
await env.DB.exec(setup.sql);
const SECRET = S.base32Decode(setup.secret);
const totpNow = async (offset = 0) => S.hotp(SECRET, Math.floor(S.now() / 30) + offset);

const ORIGIN = 'https://ozkandemir.net';
function client(ip = '203.0.113.10', ua = 'Mozilla/5.0 Test Chrome') {
  const jar = {};
  return {
    jar,
    async req(method, p, { body, headers = {}, raw = false, csrf = true } = {}) {
      const h = new Headers({ 'cf-connecting-ip': ip, 'user-agent': ua, ...headers });
      if (csrf && method !== 'GET') { h.set('x-od-panel', '1'); h.set('origin', ORIGIN); }
      const cookie = Object.entries(jar).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookie) h.set('cookie', cookie);
      let b = body;
      if (body !== undefined && !(body instanceof Uint8Array) && typeof body !== 'string') { b = JSON.stringify(body); h.set('content-type', 'application/json'); }
      if (b instanceof Uint8Array) h.set('content-length', String(b.length));
      const res = await worker.fetch(new Request(ORIGIN + p, { method, headers: h, body: b }), env);
      const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of sc) { const [kv, ...attrs] = c.split(';'); const [k, v] = kv.split('='); jar[k.trim()] = /Max-Age=0/.test(attrs.join(';')) ? '' : v; }
      if (raw) return res;
      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data, headers: res.headers };
    },
  };
}
async function loginFull(c, { trust = false } = {}) {
  const r1 = await c.req('POST', '/panel/api/login', { body: { email: EMAIL, password: PASS } });
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  if (r1.data.ok) return r1;
  tick(31);
  const r2 = await c.req('POST', '/panel/api/verify', { body: { challenge: r1.data.challenge, code: await totpNow(), trust } });
  assert.equal(r2.status, 200, JSON.stringify(r2.data));
  return r2;
}
const auditTypes = () => env.DB._db.prepare('SELECT type FROM audit ORDER BY id').all().map((r) => r.type);

await test('Mevcut site etkilenmedi: ana sayfa ve TCMB yolu eskisi gibi', async () => {
  const c = client();
  const home = await c.req('GET', '/index.html', { raw: true });
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('content-security-policy'), null, 'ana siteye panel başlıkları eklenmemeli');
  assert.match(await home.text(), /BIST 100/);
});

await test('Panel sayfası güvenlik başlıklarıyla gelir', async () => {
  const r = await client().req('GET', '/panel/', { raw: true });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
});

await test('Panel HTML/JS dosyalarında satır içi script ve style yok (CSP uyumu)', () => {
  for (const f of fs.readdirSync(path.join(ROOT, 'public/panel'))) {
    if (!f.endsWith('.html')) continue;
    const html = fs.readFileSync(path.join(ROOT, 'public/panel', f), 'utf8');
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/i, f + ': satır içi script');
    assert.doesNotMatch(html, /\sstyle\s*=/i, f + ': style niteliği');
    assert.doesNotMatch(html, /<style/i, f + ': <style> etiketi');
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, f + ': satır içi olay');
  }
  for (const f of fs.readdirSync(path.join(ROOT, 'public/panel')).filter((x) => x.endsWith('.js'))) {
    const js = fs.readFileSync(path.join(ROOT, 'public/panel', f), 'utf8');
    assert.doesNotMatch(js, /\.innerHTML\s*=|insertAdjacentHTML|eval\(|new Function/, f + ': güvensiz DOM/eval');
    assert.doesNotMatch(js, /setAttribute\(\s*['"]style/, f + ': style niteliği');
  }
});

await test('CSRF: özel başlık veya doğru kaynak yoksa reddedilir', async () => {
  const c = client();
  assert.equal((await c.req('POST', '/panel/api/login', { body: { email: EMAIL, password: PASS }, csrf: false })).status, 403);
  assert.equal((await c.req('POST', '/panel/api/login', { body: { email: EMAIL, password: PASS }, headers: { 'x-od-panel': '1', origin: 'https://kotu-site.com' }, csrf: false })).status, 403);
});

await test('Oturumsuz API erişimi 401', async () => {
  const c = client();
  for (const p of ['/panel/api/me', '/panel/api/overview', '/panel/api/security', '/panel/api/audit', '/panel/api/audit.csv', '/panel/api/links']) {
    assert.equal((await c.req('GET', p)).status, 401, p);
  }
  c.jar['__Host-od_sess'] = S.randomToken(32);
  assert.equal((await c.req('GET', '/panel/api/me')).status, 401, 'uydurma çerez geçmemeli');
});

await test('Şifre tek başına yetmez: doğru şifre yalnızca 2. adıma geçirir', async () => {
  const c = client();
  const r = await c.req('POST', '/panel/api/login', { body: { email: EMAIL, password: PASS } });
  assert.equal(r.status, 200);
  assert.match(r.data.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(c.jar['__Host-od_sess'], undefined);
  assert.equal((await c.req('GET', '/panel/api/me')).status, 401);
});

await test('Yanlış e-posta / şifre: aynı hata mesajı, 5. hatada IP kilidi', async () => {
  const c = client('198.51.100.7');
  const a = await c.req('POST', '/panel/api/login', { body: { email: 'baska@x.com', password: PASS } });
  const b = await c.req('POST', '/panel/api/login', { body: { email: EMAIL, password: 'Yanlis-Sifre-2026' } });
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.equal(a.data.error, b.data.error, 'hangi bilginin yanlış olduğu söylenmemeli');
  await c.req('POST', '/panel/api/login', { body: { email: EMAIL, password: 'x' } });
  await c.req('POST', '/panel/api/login', { body: { email: EMAIL, password: 'y' } });
  const fifth = await c.req('POST', '/panel/api/login', { body: { email: EMAIL, password: 'z' } });
  assert.equal(fifth.status, 429);
  const locked = await c.req('POST', '/panel/api/login', { body: { email: EMAIL, password: PASS } });
  assert.equal(locked.status, 429, 'kilitliyken doğru şifre bile kabul edilmemeli');
  assert.ok(auditTypes().includes('Engellendi'));
  const other = await client('192.0.2.99').req('POST', '/panel/api/login', { body: { email: EMAIL, password: PASS } });
  assert.equal(other.status, 200, 'başka IP etkilenmemeli');
  tick(CFG.LOCK_SECS + 1);
  const after = await c.req('POST', '/panel/api/login', { body: { email: EMAIL, password: PASS } });
  assert.equal(after.status, 200, 'kilit 15 dk sonra açılmalı');
  await env.DB.exec('DELETE FROM login_attempts');
});

await test('Yanlış doğrulama kodu; 5 hatada giriş denemesi sıfırlanır', async () => {
  const c = client('203.0.113.50');
  const r = await c.req('POST', '/panel/api/login', { body: { email: EMAIL, password: PASS } });
  for (let i = 0; i < 3; i++) {
    const v = await c.req('POST', '/panel/api/verify', { body: { challenge: r.data.challenge, code: '000000' } });
    assert.equal(v.status, 401);
  }
  await env.DB.exec('DELETE FROM login_attempts'); // IP kilidinden bağımsız sayaç kontrolü
  await c.req('POST', '/panel/api/verify', { body: { challenge: r.data.challenge, code: '111111' } });
  const fifth = await c.req('POST', '/panel/api/verify', { body: { challenge: r.data.challenge, code: '222222' } });
  assert.equal(fifth.data.restart, true);
  const late = await c.req('POST', '/panel/api/verify', { body: { challenge: r.data.challenge, code: await totpNow() } });
  assert.equal(late.status, 401, 'iptal edilen denemede doğru kod da geçmemeli');
  await env.DB.exec('DELETE FROM login_attempts');
});

await test('Doğrulama adımı 5 dakika sonra geçersiz', async () => {
  const c = client();
  const r = await c.req('POST', '/panel/api/login', { body: { email: EMAIL, password: PASS } });
  tick(CFG.CHALLENGE_TTL + 1);
  const v = await c.req('POST', '/panel/api/verify', { body: { challenge: r.data.challenge, code: await totpNow() } });
  assert.equal(v.status, 401);
});

let admin;
await test('Tam giriş: şifre + kod → güvenli çerez', async () => {
  admin = client();
  const r1 = await admin.req('POST', '/panel/api/login', { body: { email: EMAIL, password: PASS } });
  tick(31);
  const r2 = await admin.req('POST', '/panel/api/verify', { body: { challenge: r1.data.challenge, code: await totpNow() } });
  assert.equal(r2.status, 200);
  const sc = r2.headers.getSetCookie()[0];
  assert.match(sc, /^__Host-od_sess=/);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(sc.includes(flag), flag);
  const me = await admin.req('GET', '/panel/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.email, EMAIL);
});

await test('Aynı doğrulama kodu ikinci kez kullanılamaz (tekrar saldırısı)', async () => {
  const code = await totpNow();
  const c = client('203.0.113.77');
  const r = await c.req('POST', '/panel/api/login', { body: { email: EMAIL, password: PASS } });
  const v = await c.req('POST', '/panel/api/verify', { body: { challenge: r.data.challenge, code } });
  assert.equal(v.status, 401);
  await env.DB.exec('DELETE FROM login_attempts');
});

await test('Yedek kod bir kez çalışır', async () => {
  const code = setup.codes[0].toLowerCase();
  const c1 = client();
  const r = await c1.req('POST', '/panel/api/login', { body: { email: EMAIL, password: PASS } });
  const v = await c1.req('POST', '/panel/api/verify', { body: { challenge: r.data.challenge, code } });
  assert.equal(v.status, 200);
  assert.equal(v.data.backupLeft, 9);
  const c2 = client();
  const r2 = await c2.req('POST', '/panel/api/login', { body: { email: EMAIL, password: PASS } });
  assert.equal((await c2.req('POST', '/panel/api/verify', { body: { challenge: r2.data.challenge, code } })).status, 401);
  await env.DB.exec('DELETE FROM login_attempts');
});

await test('Program listesi: 6 program hazır gelir', async () => {
  const o = await admin.req('GET', '/panel/api/overview');
  assert.equal(o.status, 200);
  assert.equal(o.data.programs.length, 6);
  assert.ok(o.data.programs.some((p) => p.name === 'Cari Mutabakat'));
  assert.equal(o.data.stats.activeLinks, 0);
});

const fileBytes = new Uint8Array(12 * 1024 * 1024 + 12345);
for (let i = 0; i < fileBytes.length; i += 65536) crypto.getRandomValues(fileBytes.subarray(i, Math.min(i + 65536, fileBytes.length)));
const fileSha = await S.sha256hex(fileBytes);
let cariId, versionId;

await test('Yükleme doğrulamaları: tür, boyut, sürüm biçimi', async () => {
  const o = await admin.req('GET', '/panel/api/overview');
  cariId = o.data.programs.find((p) => p.slug === 'cari-mutabakat').id;
  const base = { programId: cariId, version: 'v2.4.0', filename: 'Kurulum.zip', size: 100 };
  assert.equal((await admin.req('POST', '/panel/api/uploads', { body: { ...base, filename: 'virus.js' } })).status, 400);
  assert.equal((await admin.req('POST', '/panel/api/uploads', { body: { ...base, filename: 'a.zip.php' } })).status, 400);
  assert.equal((await admin.req('POST', '/panel/api/uploads', { body: { ...base, size: 3 * 1024 ** 3 } })).status, 400);
  assert.equal((await admin.req('POST', '/panel/api/uploads', { body: { ...base, version: '../../etc' } })).status, 400);
  assert.equal((await admin.req('POST', '/panel/api/uploads', { body: { ...base, programId: 9999 } })).status, 400);
});

await test('Çok parçalı yükleme (3 parça) + SHA-256 kaydı', async () => {
  const s = await admin.req('POST', '/panel/api/uploads', { body: { programId: cariId, version: 'v2.4.0', filename: 'Cari Mutabakat Kurulum v2.4.0.zip', size: fileBytes.length, notes: 'PDF şablonu güncellendi' } });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.equal(s.data.parts, 3);
  versionId = s.data.versionId;
  const wrong = await admin.req('PUT', `/panel/api/uploads/${versionId}/parts/1`, { body: fileBytes.subarray(0, 1000) });
  assert.equal(wrong.status, 400, 'yanlış boyutlu parça reddedilmeli');
  const parts = [];
  for (let n = 1; n <= 3; n++) {
    const chunk = fileBytes.subarray((n - 1) * CFG.PART_SIZE, Math.min(n * CFG.PART_SIZE, fileBytes.length));
    const r = await admin.req('PUT', `/panel/api/uploads/${versionId}/parts/${n}`, { body: chunk });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    parts.push(r.data);
  }
  assert.equal((await admin.req('POST', `/panel/api/uploads/${versionId}/complete`, { body: { parts: parts.slice(0, 2), sha256: fileSha } })).status, 400, 'eksik parça');
  const done = await admin.req('POST', `/panel/api/uploads/${versionId}/complete`, { body: { parts, sha256: fileSha } });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  const o = await admin.req('GET', '/panel/api/overview');
  const cari = o.data.programs.find((p) => p.id === cariId);
  assert.equal(cari.latest.version, 'v2.4.0');
  assert.equal(o.data.programs[0].id, cariId, 'son güncellenen en üstte');
  const dup = await admin.req('POST', '/panel/api/uploads', { body: { programId: cariId, version: 'v2.4.0', filename: 'x.zip', size: 10 } });
  assert.equal(dup.status, 409);
  const key = env.DB._db.prepare('SELECT r2_key FROM versions WHERE id = ?').get(versionId).r2_key;
  assert.match(key, /^programlar\/cari-mutabakat\/v2-4-0\/[A-Za-z0-9_-]{8}-cari-mutabakat-kurulum-v2-4-0\.zip$/);
});

await test('Yarım kalan yükleme iptal edilir', async () => {
  const s = await admin.req('POST', '/panel/api/uploads', { body: { programId: cariId, version: 'v9.9.9', filename: 'x.zip', size: 10 } });
  const a = await admin.req('POST', `/panel/api/uploads/${s.data.versionId}/abort`, { body: {} });
  assert.equal(a.status, 200);
  assert.equal(env.DB._db.prepare('SELECT COUNT(*) n FROM versions WHERE id = ?').get(s.data.versionId).n, 0);
});

let linkUrl;
await test('Müşteri linki: oluştur, sayfa açılır (sayaç düşmez), indir, hak bitince kapanır', async () => {
  const bad = await admin.req('POST', '/panel/api/links', { body: { versionId, customer: 'Örnek Şirket A.Ş.', hours: 999, maxDownloads: 1 } });
  assert.equal(bad.status, 400);
  const l = await admin.req('POST', '/panel/api/links', { body: { versionId, customer: 'Örnek Şirket A.Ş.', hours: 24, maxDownloads: 1 } });
  assert.equal(l.status, 200);
  linkUrl = new URL(l.data.url);
  assert.match(linkUrl.pathname, /^\/indir\/[A-Za-z0-9_-]{43}$/);
  const anon = client('100.64.0.1', 'WhatsApp/2.23 önizleme');
  for (let i = 0; i < 3; i++) {
    const page = await anon.req('GET', linkUrl.pathname, { raw: true });
    assert.equal(page.status, 200, 'önizleme botları sayacı tüketmemeli');
    const html = await page.text();
    assert.match(html, /Cari Mutabakat/);
    assert.match(html, new RegExp(fileSha));
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  }
  const dl = await anon.req('POST', linkUrl.pathname, { raw: true, csrf: false });
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /attachment; filename="cari-mutabakat-kurulum-v2-4-0\.zip"; filename\*=UTF-8''Cari%20Mutabakat/);
  const got = new Uint8Array(await dl.arrayBuffer());
  assert.equal(got.length, fileBytes.length);
  assert.equal(await S.sha256hex(got), fileSha, 'indirilen dosya birebir aynı olmalı');
  assert.equal((await anon.req('POST', linkUrl.pathname, { raw: true, csrf: false })).status, 410, 'hak bitti');
  assert.equal((await anon.req('GET', linkUrl.pathname, { raw: true })).status, 410);
  assert.ok(auditTypes().includes('İndirme'));
});

await test('Link: süre dolunca ve iptal edilince çalışmaz; uydurma token 404', async () => {
  const l = await admin.req('POST', '/panel/api/links', { body: { versionId, customer: 'Cari B Ltd.', hours: 72, maxDownloads: 3 } });
  const p = new URL(l.data.url).pathname;
  const anon = client('100.64.0.2');
  assert.equal((await anon.req('GET', p, { raw: true })).status, 200);
  const links = await admin.req('GET', '/panel/api/links');
  const id = links.data.links.find((x) => x.customer === 'Cari B Ltd.').id;
  assert.equal((await admin.req('POST', `/panel/api/links/${id}/revoke`, { body: {} })).status, 200);
  assert.equal((await anon.req('POST', p, { raw: true, csrf: false })).status, 410);
  const l2 = await admin.req('POST', '/panel/api/links', { body: { versionId, customer: 'Cari C', hours: 24, maxDownloads: 1 } });
  tick(24 * 3600 + 5);
  assert.equal((await anon.req('POST', new URL(l2.data.url).pathname, { raw: true, csrf: false })).status, 410);
  assert.equal((await anon.req('GET', '/indir/' + S.randomToken(32), { raw: true })).status, 404);
  assert.equal((await anon.req('GET', '/indir/../../wrangler.jsonc', { raw: true })).status, 404);
});

await test('Hareketsizlik: 30 dk sonra oturum düşer', async () => {
  const c = client();
  await loginFull(c);
  assert.equal((await c.req('GET', '/panel/api/me')).status, 200);
  tick(CFG.SESSION_IDLE + 1);
  assert.equal((await c.req('GET', '/panel/api/me')).status, 401);
});

await test('Mutlak süre: aktif kullanılsa bile 8 saatte oturum biter', async () => {
  const c = client();
  await loginFull(c);
  for (let i = 0; i < 17; i++) { tick(29 * 60); await c.req('GET', '/panel/api/me'); }
  assert.equal((await c.req('GET', '/panel/api/me')).status, 401);
});

await test('Çıkış: çerez silinir, aynı token tekrar kullanılamaz', async () => {
  const c = client();
  await loginFull(c);
  const tok = c.jar['__Host-od_sess'];
  assert.equal((await c.req('POST', '/panel/api/logout', { body: {} })).status, 200);
  c.jar['__Host-od_sess'] = tok;
  assert.equal((await c.req('GET', '/panel/api/me')).status, 401);
});

await test('Bu cihaza güven: sonraki girişte kod istenmez; sıfırlanınca yine istenir', async () => {
  const c = client('203.0.113.88', 'Mozilla/5.0 Ev Bilgisayari');
  await loginFull(c, { trust: true });
  assert.ok(c.jar['__Host-od_trust']);
  await c.req('POST', '/panel/api/logout', { body: {} });
  const again = await c.req('POST', '/panel/api/login', { body: { email: EMAIL, password: PASS } });
  assert.equal(again.data.ok, true);
  assert.equal((await c.req('POST', '/panel/api/trusted/clear', { body: {} })).status, 200);
  await c.req('POST', '/panel/api/logout', { body: {} });
  const third = await c.req('POST', '/panel/api/login', { body: { email: EMAIL, password: PASS } });
  assert.ok(third.data.challenge, 'güven kaldırıldıktan sonra kod istenmeli');
});

await test('Diğer oturumları kapat', async () => {
  const a = client(), b = client('203.0.113.99', 'Safari iPhone');
  tick(31); await loginFull(a); tick(31); await loginFull(b);
  const sec = await a.req('GET', '/panel/api/security');
  assert.ok(sec.data.sessions.length >= 2);
  await a.req('POST', '/panel/api/sessions/revoke-others', { body: {} });
  assert.equal((await b.req('GET', '/panel/api/me')).status, 401);
  assert.equal((await a.req('GET', '/panel/api/me')).status, 200);
  admin = a;
});

await test('Güvenlik ekranı: katmanlar, Access kapalı uyarısı, yeni cihaz uyarısı kaydı', async () => {
  const s = await admin.req('GET', '/panel/api/security');
  assert.equal(s.status, 200);
  assert.equal(s.data.layers.length, 6);
  assert.equal(s.data.layers.find((l) => l.key === 'access').ok, false);
  assert.equal(s.data.allOk, false);
  assert.equal(s.data.backup.left, 9);
  assert.ok(auditTypes().includes('Uyarı'));
});

await test('Paralel saldırı: aynı anda 40 şifre denemesinden en fazla 5 tanesi değerlendirilir', async () => {
  await env.DB.exec('DELETE FROM login_attempts');
  const c = client('198.51.100.66');
  const rs = await Promise.all(Array.from({ length: 40 }, (_, i) => c.req('POST', '/panel/api/login', { body: { email: EMAIL, password: 'Yanlis-' + i } })));
  const evaluated = rs.filter((r) => r.status === 401).length;
  assert.ok(evaluated <= CFG.IP_MAX, `${evaluated} deneme değerlendirildi`);
  assert.ok(rs.filter((r) => r.status === 429).length >= 35);
  await env.DB.exec('DELETE FROM login_attempts');
});

await test('Paralel saldırı: tek doğrulama adımında aynı anda 30 kod tahmininden en fazla 5 tanesi değerlendirilir', async () => {
  await env.DB.exec('DELETE FROM login_attempts');
  const saved = [CFG.IP_MAX, CFG.ACCT_MAX];
  CFG.IP_MAX = 1000; CFG.ACCT_MAX = 1000; // yalnızca doğrulama adımı sayacını ölç
  try {
    const c = client('198.51.100.67');
    const r = await c.req('POST', '/panel/api/login', { body: { email: EMAIL, password: PASS } });
    const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => c.req('POST', '/panel/api/verify', { body: { challenge: r.data.challenge, code: String(100000 + i) } })));
    const evaluated = rs.filter((x) => x.status === 401 && !x.data.restart).length + rs.filter((x) => x.data.error && x.data.error.startsWith('Çok fazla hatalı kod')).length;
    assert.ok(evaluated <= CFG.CHALLENGE_MAX, `${evaluated} kod değerlendirildi`);
    assert.equal(env.DB._db.prepare('SELECT COUNT(*) n FROM challenges WHERE id_hash = ?').get(await S.sha256hex(r.data.challenge)).n, 0, 'doğrulama adımı silinmeli');
  } finally { [CFG.IP_MAX, CFG.ACCT_MAX] = saved; await env.DB.exec('DELETE FROM login_attempts'); }
});

await test('Güvenilir cihaz, hesap kilidinden etkilenmez (yöneticiyi dışarıda bırakma saldırısı)', async () => {
  await env.DB.exec('DELETE FROM login_attempts');
  const home = client('203.0.113.120', 'Mozilla/5.0 Ofis');
  await loginFull(home, { trust: true });
  await home.req('POST', '/panel/api/logout', { body: {} });
  for (let i = 0; i < 12; i++) await client('198.51.100.' + (100 + i)).req('POST', '/panel/api/login', { body: { email: EMAIL, password: 'saldiri' } });
  assert.equal((await client('192.0.2.50').req('POST', '/panel/api/login', { body: { email: EMAIL, password: PASS } })).status, 429, 'hesap kilitli');
  const r = await home.req('POST', '/panel/api/login', { body: { email: EMAIL, password: PASS } });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  await env.DB.exec('DELETE FROM login_attempts');
});

await test('Şifre değiştirme: eski şifre + kod şart, sonra yeni şifre çalışır', async () => {
  tick(31);
  const NEW = 'Yepyeni-Sifre-2027';
  assert.equal((await admin.req('POST', '/panel/api/password', { body: { current: 'yanlis', next: NEW, code: await totpNow() } })).status, 401);
  tick(31);
  assert.equal((await admin.req('POST', '/panel/api/password', { body: { current: PASS, next: 'zayif', code: await totpNow() } })).status, 400);
  tick(31);
  const ok = await admin.req('POST', '/panel/api/password', { body: { current: PASS, next: NEW, code: await totpNow() } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const c = client();
  assert.equal((await c.req('POST', '/panel/api/login', { body: { email: EMAIL, password: PASS } })).status, 401);
  assert.equal((await c.req('POST', '/panel/api/login', { body: { email: EMAIL, password: NEW } })).status, 200);
  await env.DB.exec('DELETE FROM login_attempts');
});

await test('Doğrulama uygulamasını yeniden kurma ve yedek kod yenileme', async () => {
  tick(31);
  const noCode = await admin.req('POST', '/panel/api/totp/begin', { body: { password: 'Yepyeni-Sifre-2027' } });
  assert.equal(noCode.status, 401, 'yalnızca şifreyle 2FA değiştirilememeli');
  const begin = await admin.req('POST', '/panel/api/totp/begin', { body: { password: 'Yepyeni-Sifre-2027', code: await totpNow() } });
  assert.equal(begin.status, 200, JSON.stringify(begin.data));
  assert.match(begin.data.uri, /^otpauth:\/\/totp\/ozkandemir\.net/);
  const newSecret = S.base32Decode(begin.data.secret);
  tick(31);
  assert.equal((await admin.req('POST', '/panel/api/totp/confirm', { body: { code: await totpNow() } })).status, 401, 'eski anahtarın kodu geçmemeli');
  const conf = await admin.req('POST', '/panel/api/totp/confirm', { body: { code: await S.hotp(newSecret, Math.floor(S.now() / 30)) } });
  assert.equal(conf.status, 200);
  tick(31);
  const bc = await admin.req('POST', '/panel/api/backup-codes', { body: { code: await S.hotp(newSecret, Math.floor(S.now() / 30)) } });
  assert.equal(bc.status, 200);
  assert.equal(bc.data.codes.length, 10);
  await env.DB.exec('DELETE FROM login_attempts');
});

await test('Denetim kaydı: liste, Excel CSV (formül enjeksiyonu engelli), silinemez', async () => {
  await client('203.0.113.5').req('POST', '/panel/api/login', { body: { email: '=HYPERLINK("http://x")', password: 'a' } });
  const list = await admin.req('GET', '/panel/api/audit?limit=500');
  assert.ok(list.data.entries.length > 10);
  const csv = await admin.req('GET', '/panel/api/audit.csv', { raw: true });
  const bytes = new Uint8Array(await csv.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'Excel için UTF-8 BOM');
  const text = new TextDecoder().decode(bytes);
  assert.ok(text.startsWith('Zaman;Olay;'));
  assert.doesNotMatch(text, /;"=HYPERLINK/);
  assert.throws(() => env.DB._db.exec('DELETE FROM audit'));
  assert.throws(() => env.DB._db.exec("UPDATE audit SET detail = 'x'"));
  await env.DB.exec('DELETE FROM login_attempts');
});

await test('Sürüm silme: dosya depodan silinir, linkler iptal olur', async () => {
  const before = env.FILES._objects.size;
  const d = await admin.req('DELETE', `/panel/api/versions/${versionId}`);
  assert.equal(d.status, 200);
  assert.equal(env.FILES._objects.size, before - 1);
  assert.equal((await client().req('POST', linkUrl.pathname, { raw: true, csrf: false })).status, 404);
});

await test('Yeni program ekleme', async () => {
  const r = await admin.req('POST', '/panel/api/programs', { body: { name: 'Mobil PDKS' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.slug, 'mobil-pdks');
  assert.equal((await admin.req('POST', '/panel/api/programs', { body: { name: 'Mobil PDKS' } })).status, 409);
});


await test('Cloudflare Access açıkken JWT olmadan panele erişilemez, müşteri linki etkilenmez', async () => {
  const { sign, team } = globalThis.__accessKit;
  S._resetAccessCache();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => (String(u).includes('/cdn-cgi/access/certs') ? new Response(JSON.stringify({ keys: [globalThis.__accessKit.jwk] })) : realFetch(u, o));
  env.ACCESS_TEAM_DOMAIN = team; env.ACCESS_AUD = 'AUD1';
  try {
    assert.equal((await client().req('GET', '/panel/', { raw: true })).status, 403);
    assert.equal((await admin.req('GET', '/panel/api/me')).status, 403, 'geçerli oturum çerezi bile Access olmadan geçmemeli');
    const jwt = await sign({ aud: ['AUD1'], iss: `https://${team}`, exp: S.now() + 600, email: EMAIL });
    const ok = await admin.req('GET', '/panel/api/security', { headers: { 'cf-access-jwt-assertion': jwt } });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.layers.find((l) => l.key === 'access').ok, true);
    assert.equal((await client().req('GET', '/indir/' + S.randomToken(32), { raw: true })).status, 404, '/indir Access dışında kalmalı');
  } finally {
    delete env.ACCESS_TEAM_DOMAIN; delete env.ACCESS_AUD; globalThis.fetch = realFetch;
  }
});

await test('Kurulum eksikse panel API anlaşılır hata verir', async () => {
  const bare = { ASSETS: env.ASSETS };
  const r = await worker.fetch(new Request(ORIGIN + '/panel/api/login', { method: 'POST', headers: { 'x-od-panel': '1', origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' }), bare);
  assert.equal(r.status, 503);
  const page = await worker.fetch(new Request(ORIGIN + '/panel/'), bare);
  assert.equal(page.status, 200);
});

Date.now = realNow;
console.log(results.join('\n'));
console.log(`panel tests: OK (${passed} test)`);
