// ozkandemir.net V3.8 — Panel güvenliğinin son iki katmanı (Cloudflare API ile, panelden tek seferde)
// 1) Anahtarları Cloudflare gizli değişkenlerine taşır (PANEL_ENC_KEY, LICENSE_SIGNING_KEY).
// 2) Cloudflare Access kapısını kurar: /panel yalnızca yöneticinin e-postasına gelen tek kullanımlık kodla açılır.
// API anahtarı (token) yalnızca bu istek sırasında kullanılır; hiçbir yere kaydedilmez.
import { first, run } from './common.js';
import { now } from './security.js';

const CF = 'https://api.cloudflare.com/client/v4';
export const SCRIPT = 'ozkandemir-web';
export const PANEL_HOSTS = ['ozkandemir.net/panel', 'www.ozkandemir.net/panel'];

class CfError extends Error {}

async function cf(token, method, path, body) {
  let r;
  try {
    r = await fetch(CF + path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new CfError('Cloudflare API\'ye bağlanılamadı.');
  }
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok || data.success === false) {
    const m = (data.errors && data.errors[0] && data.errors[0].message) || `HTTP ${r.status}`;
    const e = new CfError(m);
    e.status = r.status;
    throw e;
  }
  return data.result;
}

// ---------- Ayarlar (Access yapılandırması) ----------
let accessCache = { at: 0, db: null, val: null };
export function clearAccessCache() { accessCache = { at: 0, db: null, val: null }; }

export async function accessConfig(env) {
  if (env.ACCESS_KAPAT === '1') return null; // kilitlenme halinde Cloudflare panelinden açılan acil durum anahtarı
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) return { team: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD, state: 'active', from: 'env' };
  if (!env.DB) return null;
  if (accessCache.db === env.DB && Date.now() - accessCache.at < 60000) return accessCache.val;
  let val = null;
  try {
    const r = await first(env, "SELECT value FROM settings WHERE name = 'access'");
    if (r) val = { ...JSON.parse(r.value), from: 'db' };
  } catch {}
  accessCache = { at: Date.now(), db: env.DB, val };
  return val;
}

export async function markAccessActive(env, cfg) {
  const val = { team: cfg.team, aud: cfg.aud, email: cfg.email, appId: cfg.appId, state: 'active', activatedAt: now() };
  await run(env, "UPDATE settings SET value = ?, updated_at = ? WHERE name = 'access'", JSON.stringify(val), now());
  clearAccessCache();
}

// ---------- Kurulum ----------
async function findAccount(token) {
  const accounts = await cf(token, 'GET', '/accounts?per_page=50');
  for (const a of accounts || []) {
    try {
      const scripts = await cf(token, 'GET', `/accounts/${a.id}/workers/scripts`);
      if ((scripts || []).some((s) => s.id === SCRIPT)) return a;
    } catch {}
  }
  throw new CfError(`API anahtarının yetkili olduğu hesaplarda "${SCRIPT}" Worker'ı bulunamadı. Anahtarı oluştururken hesabınızı seçtiğinizden ve "Workers Scripts: Edit" iznini verdiğinizden emin olun.`);
}

async function moveKeys(token, accountId, env) {
  for (const name of ['PANEL_ENC_KEY', 'LICENSE_SIGNING_KEY']) {
    if (!env[name]) throw new CfError(`${name} değeri bulunamadı.`);
    await cf(token, 'PUT', `/accounts/${accountId}/workers/scripts/${SCRIPT}/secrets`, { name, text: env[name], type: 'secret_text' });
  }
}

async function setupAccess(token, accountId, email) {
  let org;
  try {
    org = await cf(token, 'GET', `/accounts/${accountId}/access/organizations`);
  } catch (e) {
    throw new CfError('Cloudflare Zero Trust henüz açılmamış görünüyor. Cloudflare panelinde sol menüden "Zero Trust"a bir kez girip ücretsiz planı seçin (takım adı: ozkandemir), sonra bu adımı tekrarlayın.');
  }
  if (!org || !org.auth_domain) throw new CfError('Zero Trust takım adresi okunamadı.');
  const idps = await cf(token, 'GET', `/accounts/${accountId}/access/identity_providers`);
  let otp = (idps || []).find((i) => i.type === 'onetimepin');
  if (!otp) otp = await cf(token, 'POST', `/accounts/${accountId}/access/identity_providers`, { name: 'E-posta ile tek kullanımlık kod', type: 'onetimepin', config: {} });
  const apps = await cf(token, 'GET', `/accounts/${accountId}/access/apps?per_page=100`);
  let app = (apps || []).find((a) => PANEL_HOSTS.includes(String(a.domain || '').replace(/\/$/, '')));
  const appBody = {
    name: 'ozkandemir.net Yönetim Paneli',
    type: 'self_hosted',
    domain: PANEL_HOSTS[0],
    self_hosted_domains: PANEL_HOSTS,
    session_duration: '8h',
    app_launcher_visible: false,
    allowed_idps: [otp.id],
    auto_redirect_to_identity: true,
  };
  app = app ? await cf(token, 'PUT', `/accounts/${accountId}/access/apps/${app.id}`, appBody)
    : await cf(token, 'POST', `/accounts/${accountId}/access/apps`, appBody);
  const policies = await cf(token, 'GET', `/accounts/${accountId}/access/apps/${app.id}/policies`).catch(() => []);
  const policyBody = { name: 'Yalnızca yönetici', decision: 'allow', include: [{ email: { email } }], precedence: 1 };
  const existing = (policies || []).find((p) => p.name === policyBody.name);
  if (existing) await cf(token, 'PUT', `/accounts/${accountId}/access/apps/${app.id}/policies/${existing.id}`, policyBody);
  else await cf(token, 'POST', `/accounts/${accountId}/access/apps/${app.id}/policies`, policyBody);
  return { team: org.auth_domain, aud: app.aud, appId: app.id };
}

// panel.js, iki adımlı kod doğrulandıktan sonra çağırır
export async function cloudflareSetup(env, { token, keys, access, email }) {
  token = String(token || '').trim();
  if (!/^[A-Za-z0-9_-]{30,80}$/.test(token)) throw new CfError('API anahtarı biçimi geçersiz. Cloudflare\'de oluşturduğunuz anahtarı eksiksiz yapıştırın.');
  const verify = await cf(token, 'GET', '/user/tokens/verify').catch(() => null);
  if (!verify || verify.status !== 'active') throw new CfError('API anahtarı geçersiz veya süresi dolmuş.');
  const account = await findAccount(token);
  const done = [];
  let recovery = null;
  if (keys && env.KEY_SOURCE !== 'secret') {
    recovery = { olusturma: new Date().toISOString(), PANEL_ENC_KEY: env.PANEL_ENC_KEY, LICENSE_SIGNING_KEY: env.LICENSE_SIGNING_KEY };
    await moveKeys(token, account.id, env);
    done.push('keys');
  }
  let error = null;
  if (access) {
    try {
      const a = await setupAccess(token, account.id, email);
      const val = { ...a, email, state: 'pending', createdAt: now() };
      await run(env, 'INSERT INTO settings (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        'access', JSON.stringify(val), now());
      clearAccessCache();
      done.push('access');
    } catch (e) {
      // Anahtar adımı başarılı olduysa kurtarma yedeği yine de verilmeli
      if (!done.length) throw e;
      error = e instanceof CfError ? e.message : 'Access kurulumu tamamlanamadı.';
    }
  }
  return { done, account: account.name, recovery, error };
}

export { CfError };
