// ozkandemir.net V3.7 — Panelin kendini kurması
// * Veritabanı tabloları yoksa ilk istekte oluşturulur (komut satırı gerekmez).
// * PANEL_ENC_KEY ve LICENSE_SIGNING_KEY Cloudflare secret olarak tanımlıysa onlar kullanılır;
//   tanımlı değilse bir kez üretilip veritabanında saklanır (system_keys).
import { SCHEMA, SCHEMA_VERSION } from './schema.js';
import { b64, randomBytes } from './security.js';
import { HttpError } from './common.js';

const cache = new WeakMap(); // aynı Worker örneğinde (aynı veritabanı için) tekrar kontrol etmemek için

async function ensureSchema(db) {
  let ok = false;
  try {
    const r = await db.prepare("SELECT value FROM system_keys WHERE name = 'schema_version'").first();
    ok = r && r.value === SCHEMA_VERSION;
  } catch {
    ok = false; // tablo yok
  }
  if (ok) return;
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  await db.prepare("INSERT INTO system_keys (name, value, created_at) VALUES ('schema_version', ?, unixepoch()) ON CONFLICT(name) DO UPDATE SET value = excluded.value")
    .bind(SCHEMA_VERSION).run();
}

async function storedKey(db, name, make) {
  const r = await db.prepare('SELECT value FROM system_keys WHERE name = ?').bind(name).first();
  if (r) return r.value;
  // Aynı anda iki istek gelirse yalnızca biri yazılır; ikisi de kazananı okur
  await db.prepare('INSERT OR IGNORE INTO system_keys (name, value, created_at) VALUES (?, ?, unixepoch())').bind(name, await make()).run();
  return (await db.prepare('SELECT value FROM system_keys WHERE name = ?').bind(name).first()).value;
}

async function newSigningKey() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return JSON.stringify({ kty: 'OKP', crv: 'Ed25519', d: jwk.d, x: jwk.x });
}

async function dropMovedKeys(env) {
  const rows = (await env.DB.prepare("SELECT name, value FROM system_keys WHERE name IN ('panel_enc_key', 'license_signing_key')").all()).results || [];
  const same = { panel_enc_key: env.PANEL_ENC_KEY, license_signing_key: env.LICENSE_SIGNING_KEY };
  for (const r of rows) {
    if (r.value !== same[r.name]) continue; // farklı bir anahtar: dokunma
    await env.DB.prepare("INSERT OR IGNORE INTO system_keys (name, value, created_at) VALUES ('keys_moved', '1', unixepoch())").run();
    await env.DB.prepare('DELETE FROM system_keys WHERE name = ? AND value = ?').bind(r.name, r.value).run();
    await env.DB.prepare('INSERT INTO audit (at, type, detail) VALUES (unixepoch(), ?, ?)')
      .bind('Güvenlik', `${r.name === 'panel_enc_key' ? 'Şifreleme' : 'Lisans imza'} anahtarı Cloudflare gizli değişkenine taşındı; veritabanı kopyası silindi`).run();
  }
}

// env'i bozmadan, eksik anahtarları tamamlanmış bir görünüm döndürür
export async function prepareEnv(env) {
  if (!env || !env.DB) return env;
  let ready = cache.get(env.DB);
  if (!ready) {
    ready = (async () => {
      await ensureSchema(env.DB);
      // Anahtarlar Cloudflare gizli değişkenine taşındıysa ve değerler aynıysa veritabanındaki kopyalar silinir
      if (env.PANEL_ENC_KEY && env.LICENSE_SIGNING_KEY) await dropMovedKeys(env);
      else if (await env.DB.prepare("SELECT 1 AS x FROM system_keys WHERE name = 'keys_moved'").first()) {
        // Anahtarlar gizli değişkene taşınmıştı ama artık yok: yeni anahtar üretmek tüm lisansları ve paneli bozar
        throw new HttpError(503, 'Gizli anahtarlar (PANEL_ENC_KEY / LICENSE_SIGNING_KEY) bulunamadı. Cloudflare Worker ayarlarındaki gizli değişkenleri kurtarma yedeğinden geri yükleyin.');
      }
      const panelKey = env.PANEL_ENC_KEY || (await storedKey(env.DB, 'panel_enc_key', async () => b64(randomBytes(32))));
      const signKey = env.LICENSE_SIGNING_KEY || (await storedKey(env.DB, 'license_signing_key', newSigningKey));
      return {
        PANEL_ENC_KEY: panelKey,
        LICENSE_SIGNING_KEY: signKey,
        KEY_SOURCE: env.PANEL_ENC_KEY && env.LICENSE_SIGNING_KEY ? 'secret' : 'database',
      };
    })().catch((e) => { cache.delete(env.DB); throw e; });
    cache.set(env.DB, ready);
  }
  const extra = await ready;
  const view = Object.create(env);
  Object.assign(view, extra);
  return view;
}

