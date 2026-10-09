// ozkandemir.net V3.7 — Web üzerinden ilk kurulum testleri
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createD1, createR2, createAssets } from './helpers/cf-local.mjs';
import * as S from '../src/panel/security.js';
import { setupCodeHash } from '../src/panel/panel.js';
import worker from '../src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log('  ✓ ' + name); };
let clock = Date.now();
Date.now = () => clock;
const tick = (s) => { clock += s * 1000; };

const CODE = 'ODK-7K2Q-M9XD-4TRE-H8WC';
const env = { DB: createD1(''), FILES: createR2(), ASSETS: createAssets(path.join(ROOT, 'public')), SETUP_CODE_HASH: await setupCodeHash(CODE) };
const ORIGIN = 'https://ozkandemir.net';
function client(ip = '203.0.113.1') {
  const jar = {};
  return {
    jar,
    async req(method, p, body) {
      const h = new Headers({ 'cf-connecting-ip': ip, 'user-agent': 'Test' });
      if (method !== 'GET') { h.set('x-od-panel', '1'); h.set('origin', ORIGIN); h.set('content-type', 'application/json'); }
      const ck = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (ck) h.set('cookie', ck);
      const r = await worker.fetch(new Request(ORIGIN + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env);
      for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
      return { status: r.status, data: await r.json().catch(() => ({})) };
    },
  };
}
const PASS = 'Guclu-Panel-Sifresi-2026';

await ok('Kurulum gerekli görünür', async () => {
  const r = await client().req('GET', '/panel/api/setup/status');
  assert.deepEqual(r.data, { needsSetup: true, setupEnabled: true });
});

await ok('Yanlış kurulum kodu reddedilir; 5 denemeden sonra IP kilitlenir', async () => {
  const c = client('198.51.100.9');
  for (let i = 0; i < 5; i++) {
    const r = await c.req('POST', '/panel/api/setup/start', { setupCode: 'ODK-0000-0000-0000-000' + i, email: 'a@b.co', password: PASS });
    assert.equal(r.status, 401);
  }
  assert.equal((await c.req('POST', '/panel/api/setup/start', { setupCode: CODE, email: 'a@b.co', password: PASS })).status, 429);
  await env.DB.exec('DELETE FROM login_attempts');
});

await ok('Zayıf şifre ve geçersiz e-posta reddedilir; kod büyük/küçük harf ve tire farkına toleranslı', async () => {
  const c = client();
  assert.equal((await c.req('POST', '/panel/api/setup/start', { setupCode: CODE, email: 'x', password: PASS })).status, 400);
  assert.equal((await c.req('POST', '/panel/api/setup/start', { setupCode: CODE.toLowerCase().replace(/-/g, ' '), email: 'ozkan6181@hotmail.com', password: 'kisa' })).status, 400);
  await env.DB.exec('DELETE FROM login_attempts');
});

let secret, token;
await ok('Kurulum başlar: doğrulama anahtarı ve karekod bağlantısı verilir; henüz hesap yok', async () => {
  const r = await client().req('POST', '/panel/api/setup/start', { setupCode: CODE, email: 'Ozkan6181@Hotmail.com', password: PASS });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.uri, /^otpauth:\/\/totp\/ozkandemir\.net/);
  secret = S.base32Decode(r.data.secret);
  token = r.data.token;
  assert.equal(env.DB._db.prepare('SELECT COUNT(*) n FROM admin').get().n, 0);
  const pend = env.DB._db.prepare('SELECT * FROM setup_pending').get();
  assert.ok(!JSON.stringify(pend).includes(PASS), 'şifre açık saklanmamalı');
  assert.ok(!JSON.stringify(pend).includes(r.data.secret.replace(/ /g, '')), 'doğrulama anahtarı açık saklanmamalı');
});

let admin;
await ok('Yanlış kodla bitirilemez; doğru kodla hesap açılır, oturum ve 10 yedek kod gelir', async () => {
  admin = client();
  assert.equal((await admin.req('POST', '/panel/api/setup/finish', { token, code: '000000' })).status, 401);
  const r = await admin.req('POST', '/panel/api/setup/finish', { token, code: await S.hotp(secret, Math.floor(S.now() / 30)) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.codes.length, 10);
  assert.ok(admin.jar['__Host-od_sess']);
  const me = await admin.req('GET', '/panel/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.email, 'ozkan6181@hotmail.com');
  assert.equal(env.DB._db.prepare('SELECT COUNT(*) n FROM setup_pending').get().n, 0);
});

await ok('Kurulum kapandı: kod bilinse bile ikinci hesap açılamaz', async () => {
  const c = client('192.0.2.77');
  assert.deepEqual((await c.req('GET', '/panel/api/setup/status')).data, { needsSetup: false, setupEnabled: true });
  assert.equal((await c.req('POST', '/panel/api/setup/start', { setupCode: CODE, email: 'saldirgan@x.co', password: PASS })).status, 409);
  assert.equal((await c.req('POST', '/panel/api/setup/finish', { token, code: '123456' })).status, 409);
});

await ok('Normal giriş: şifre + kod; aynı kod tekrar kullanılamaz', async () => {
  const c = client('203.0.113.50');
  const r1 = await c.req('POST', '/panel/api/login', { email: 'ozkan6181@hotmail.com', password: PASS });
  assert.equal(r1.status, 200);
  const usedCode = await S.hotp(secret, Math.floor(S.now() / 30));
  assert.equal((await c.req('POST', '/panel/api/verify', { challenge: r1.data.challenge, code: usedCode })).status, 401, 'kurulumda kullanılan kod');
  tick(31);
  const r2 = await c.req('POST', '/panel/api/verify', { challenge: r1.data.challenge, code: await S.hotp(secret, Math.floor(S.now() / 30)) });
  assert.equal(r2.status, 200);
});

await ok('Yarım kalan kurulum 15 dakika sonra geçersiz olur', async () => {
  const env2 = { ...env, DB: createD1('') };
  const call = (p, b) => worker.fetch(new Request(ORIGIN + p, { method: 'POST', headers: { 'x-od-panel': '1', origin: ORIGIN, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' }, body: JSON.stringify(b) }), env2).then(async (r) => ({ status: r.status, data: await r.json() }));
  const s = await call('/panel/api/setup/start', { setupCode: CODE, email: 'a@b.co', password: PASS });
  tick(16 * 60);
  const f = await call('/panel/api/setup/finish', { token: s.data.token, code: await S.hotp(S.base32Decode(s.data.secret), Math.floor(S.now() / 30)) });
  assert.equal(f.status, 401);
  assert.equal(f.data.restart, true);
});

console.log(`setup tests: OK (${n} test)`);
