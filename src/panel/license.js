// ozkandemir.net V3.6 — Online lisans yönetimi
// Müşteri programı:  POST /lisans/api/activate , POST /lisans/api/check , GET /lisans/api/public-key
// Yönetim paneli:    /panel/api/licenses/*  (oturum + 2FA arkasında, panel.js yönlendirir)
import { now, randomBytes, sha256hex, b64url, unb64url, encryptText, decryptText } from './security.js';
import { json, fail, first, all, run, changes, readJson, HttpError, fmtTR, audit, chargeAttempt } from './common.js';

// ---------- Ürünler ----------
// slug → programs.slug ; prefix → anahtar ön eki ; limits/modules → lisans koşulları
export const PRODUCTS = {
  'nis-pdks': {
    prefix: 'NPDK', name: 'NİS PDKS',
    limits: [{ key: 'personel', label: 'Personel sınırı', def: 100 }, { key: 'sube', label: 'Şube sınırı', def: 1 }],
    modules: [{ key: 'mobil', label: 'Mobil / PWA', def: true }, { key: 'push', label: 'Push bildirim', def: true }, { key: 'coklu_sirket', label: 'Çoklu şirket' }, { key: 'izin_entegrasyon', label: 'Yıllık izin entegrasyonu' }],
  },
  'banka-xml-aktarim': {
    prefix: 'BNKX', name: 'Banka XML Aktarım',
    limits: [{ key: 'firma', label: 'Logo firma sınırı', def: 1 }, { key: 'banka_hesap', label: 'Banka hesabı sınırı', def: 10 }],
    modules: [{ key: 'kredi_karti', label: 'Kredi kartı ekstresi', def: true }, { key: 'coklu_banka', label: 'Çoklu banka', def: true }],
  },
  'satinalma-denetim': {
    prefix: 'SATD', name: 'Satınalma Denetim',
    limits: [{ key: 'kullanici', label: 'Kullanıcı sınırı', def: 3 }],
    modules: [{ key: 'barkod', label: 'Barkod / miktar kontrolü', def: true }, { key: 'excel_rapor', label: 'Excel raporu', def: true }],
  },
  'cari-mutabakat': {
    prefix: 'CRMT', name: 'Cari Mutabakat',
    limits: [{ key: 'firma', label: 'Firma sınırı', def: 1 }],
    modules: [{ key: 'eposta', label: 'E-posta gönderimi', def: true }, { key: 'fark_analizi', label: 'Ekstre fark analizi', def: true }],
  },
  'yillik-izin': {
    prefix: 'IZIN', name: 'Yıllık İzin',
    limits: [{ key: 'personel', label: 'Personel sınırı', def: 100 }],
    modules: [{ key: 'pdks_entegrasyon', label: 'NİS PDKS entegrasyonu' }],
  },
  'cari360': {
    prefix: 'C360', name: 'Cari360',
    limits: [{ key: 'kullanici', label: 'Kullanıcı sınırı', def: 5 }],
    modules: [{ key: 'hizli_entegrasyon', label: 'Hızlı Bilişim entegrasyonu', def: true }],
  },
};
export const BY_PREFIX = Object.fromEntries(Object.entries(PRODUCTS).map(([slug, p]) => [p.prefix, { slug, ...p }]));

export const LIC = {
  CHECK_EVERY: 7 * 86400,   // program 7 günde bir doğrular
  OFFLINE_GRACE: 30 * 86400, // internet yoksa 30 gün çalışır
  EXPIRING: 30 * 86400,     // 30 gün kala "süresi yaklaşıyor"
  STALE: 8 * 86400,         // 8 gündür bağlanmayan cihaz
  FAIL_MAX: 20,             // aynı IP'den 15 dk içinde 20 geçersiz anahtar → 1 saat kilit
  FAIL_WINDOW: 15 * 60,
  FAIL_LOCK: 3600,
};

// ---------- Anahtar ----------
const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: I, L, O, U yok

export function generateKey(prefix) {
  const r = randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) s += ALPHA[r[i] & 31];
  return `${prefix}-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`;
}

export function normalizeKey(input) {
  const raw = String(input || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (raw.length !== 20) return null;
  const prefix = raw.slice(0, 4);
  if (!BY_PREFIX[prefix]) return null;
  const body = raw.slice(4).replace(/O/g, '0').replace(/[IL]/g, '1');
  if (!/^[0-9A-HJKMNP-TV-Z]{16}$/.test(body)) return null;
  return `${prefix}-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${body.slice(12)}`;
}
export const maskKey = (k) => `${k.slice(0, 9)}-••••-••••-${k.slice(-4)}`;
export const keyHash = (k) => sha256hex('lk:' + k);

// ---------- Tarih ----------
function parseDateTR(s, endOfDay) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = endOfDay ? Date.UTC(y, mo - 1, d, 23, 59, 59) : Date.UTC(y, mo - 1, d, 0, 0, 0);
  const dt = new Date(ms);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return ms / 1000 - 3 * 3600;
}
export function isoDateTR(t) {
  const d = new Date((t + 3 * 3600) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
export const dateTR = (t) => fmtTR(t).slice(0, 10);
function addYearISO(iso, years = 1) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y + years, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) dt.setUTCDate(0); // 29 Şubat → 28 Şubat
  dt.setUTCDate(dt.getUTCDate() - 1); // 08.10.2026 → 07.10.2027 (tam bir yıl)
  return dt.toISOString().slice(0, 10);
}

// ---------- İmza (Ed25519) ----------
let signCache = { src: '', key: null, x: '' };
async function signingKey(env) {
  const src = env.LICENSE_SIGNING_KEY;
  if (!src) throw new HttpError(503, 'Lisans imza anahtarı (LICENSE_SIGNING_KEY) tanımlı değil.');
  if (signCache.src !== src) {
    let jwk;
    try { jwk = JSON.parse(src); } catch { throw new HttpError(503, 'LICENSE_SIGNING_KEY biçimi hatalı.'); }
    const key = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', d: jwk.d, x: jwk.x }, { name: 'Ed25519' }, false, ['sign']);
    signCache = { src, key, x: jwk.x };
  }
  return signCache;
}

export async function signingPublicKey(env) {
  return (await signingKey(env)).x;
}

export async function signPayload(env, payload) {
  const { key } = await signingKey(env);
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(body));
  return `ODL1.${body}.${b64url(sig)}`;
}

export async function verifyToken(publicX, token) {
  const [tag, body, sig] = String(token || '').split('.');
  if (tag !== 'ODL1' || !body || !sig) return null;
  const key = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: publicX }, { name: 'Ed25519' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, unb64url(sig), new TextEncoder().encode(body));
  return ok ? JSON.parse(new TextDecoder().decode(unb64url(body))) : null;
}

// ---------- Durum ----------
export function licState(lic, t) {
  if (lic.status === 'revoked') return 'revoked';
  if (lic.status === 'suspended') return 'suspended';
  if (lic.ends_at < t) return 'expired';
  if (lic.starts_at > t) return 'not_started';
  return 'active';
}
const STATE_MSG = {
  revoked: 'Bu lisans iptal edilmiş. Lütfen Özkan Demir ile iletişime geçin.',
  suspended: 'Bu lisans askıya alınmış. Lütfen Özkan Demir ile iletişime geçin.',
  expired: 'Lisans süresi dolmuş. Yenileme için Özkan Demir ile iletişime geçin.',
  not_started: 'Lisans henüz başlamadı.',
  device_removed: 'Bu cihazın lisansı kaldırılmış. Lisansı yeniden etkinleştirin.',
  device_limit: 'Bu anahtar izin verilen sayıda cihazda zaten etkin. Sunucu değiştirdiyseniz Özkan Demir ile iletişime geçin.',
  invalid_key: 'Lisans anahtarı geçersiz.',
  wrong_product: 'Bu anahtar başka bir programa ait.',
};

function parseJsonSafe(s, def) { try { return JSON.parse(s); } catch { return def; } }

async function buildToken(env, lic, prefix, deviceId, state, t, offline = false) {
  const active = state === 'active';
  return signPayload(env, {
    v: 1,
    typ: 'od-license',
    lid: lic.id,
    product: prefix,
    program: BY_PREFIX[prefix].name,
    customer: lic.customer,
    key: lic.key_mask,
    device: deviceId,
    status: state,
    message: active ? '' : STATE_MSG[state] || '',
    starts: lic.starts_at,
    expires: lic.ends_at,
    limits: parseJsonSafe(lic.limits_json, {}),
    modules: parseJsonSafe(lic.modules_json, []),
    iat: t,
    check_after: t + LIC.CHECK_EVERY,
    // Çevrimdışı (panelden verilen) lisans internet olmadan bitiş tarihine kadar geçerlidir
    valid_until: active ? (offline ? lic.ends_at : Math.min(t + LIC.OFFLINE_GRACE, lic.ends_at)) : t,
    offline,
    server: 'ozkandemir.net',
  });
}

export async function event(env, licenseId, type, detail, cl) {
  await run(env, 'INSERT INTO license_events (license_id, at, type, detail, ip, location) VALUES (?, ?, ?, ?, ?, ?)',
    licenseId, now(), type, String(detail).slice(0, 500), cl ? cl.ip : null, cl ? cl.location : null);
}

// ---------- Müşteri programı API'si ----------
export function cleanBody(b) {
  const deviceId = String(b.device_id || '').toLowerCase();
  if (!/^[a-f0-9]{32,128}$/.test(deviceId)) throw new HttpError(400, 'Cihaz kimliği geçersiz.');
  let usage = b.usage && typeof b.usage === 'object' && !Array.isArray(b.usage) ? b.usage : {};
  usage = Object.fromEntries(Object.entries(usage).slice(0, 20).filter(([k, v]) => /^[a-z_]{1,32}$/.test(k) && Number.isFinite(Number(v))).map(([k, v]) => [k, Number(v)]));
  return {
    key: normalizeKey(b.key),
    deviceId,
    deviceName: String(b.device_name || '').replace(/[\u0000-\u001f]/g, '').slice(0, 100) || 'Bilinmeyen cihaz',
    os: String(b.os || '').slice(0, 100),
    version: String(b.app_version || '').slice(0, 32),
    product: String(b.product || '').toUpperCase().slice(0, 4),
    usage,
  };
}

export async function licLocked(env, ip, t) {
  const r = await first(env, 'SELECT locked_until FROM login_attempts WHERE key = ?', 'lic:' + ip);
  return r && r.locked_until > t ? r.locked_until : 0;
}
// Geçersiz anahtar denemesini atomik say; sınır aşılırsa IP 1 saat kilitlenir
export async function licFail(env, ip, t) {
  await chargeAttempt(env, 'lic:' + ip, t, LIC.FAIL_MAX - 1, LIC.FAIL_WINDOW, LIC.FAIL_LOCK);
}

const deny = (status, code, extra = {}) => json({ ok: false, code, message: STATE_MSG[code] || code, ...extra }, status);

// Etkinleştirme / doğrulama çekirdeği (çevrimiçi ve çevrimdışı ortak)
async function activateCore(env, lic, body, cl, t, mode) {
  const prefix = body.product;
  const state = licState(lic, t);
  if (state !== 'active') {
    return { status: 403, data: { ok: false, code: state, message: STATE_MSG[state], token: await buildToken(env, lic, prefix, body.deviceId, state, t) } };
  }
  const act = await first(env, 'SELECT * FROM activations WHERE license_id = ? AND device_id = ?', lic.id, body.deviceId);
  const usage = JSON.stringify(body.usage);
  if (mode === 'check') {
    if (!act || act.removed_at) {
      await event(env, lic.id, 'Reddedildi', `Kaldırılmış/kayıtsız cihaz doğrulama denedi: ${body.deviceName}`, cl);
      return { status: 403, data: { ok: false, code: 'device_removed', message: STATE_MSG.device_removed, token: await buildToken(env, lic, prefix, body.deviceId, 'device_removed', t) } };
    }
  }
  if (act && !act.removed_at) {
    await run(env, 'UPDATE activations SET device_name = ?, os = ?, app_version = ?, usage_json = ?, ip = ?, location = ?, last_seen = ? WHERE id = ?',
      body.deviceName, body.os, body.version, usage, cl.ip, cl.location, t, act.id);
  } else {
    // Cihaz sınırı tek ve atomik SQL ifadesiyle uygulanır (aynı anda gelen etkinleştirmeler sınırı aşamaz)
    const ins = await run(env,
      `INSERT INTO activations (license_id, device_id, device_name, os, app_version, usage_json, ip, location, activated_at, last_seen)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM activations WHERE license_id = ? AND removed_at IS NULL) < ?
       ON CONFLICT(license_id, device_id) DO UPDATE SET
         device_name = excluded.device_name, os = excluded.os, app_version = excluded.app_version, usage_json = excluded.usage_json,
         ip = excluded.ip, location = excluded.location, last_seen = excluded.last_seen,
         activated_at = CASE WHEN removed_at IS NULL THEN activated_at ELSE excluded.activated_at END, removed_at = NULL`,
      lic.id, body.deviceId, body.deviceName, body.os, body.version, usage, cl.ip, cl.location, t, t,
      lic.id, lic.max_devices);
    if (changes(ins) !== 1) {
      await event(env, lic.id, 'Uyarı', `${body.deviceName} cihazından etkinleştirme reddedildi (cihaz sınırı: ${lic.max_devices})`, cl);
      return { status: 409, data: { ok: false, code: 'device_limit', message: STATE_MSG.device_limit } };
    }
  }
  const usageText = Object.entries(body.usage).map(([k, v]) => `${v} ${k}`).join(', ');
  // Doğrulama kaydı en fazla 6 saatte bir yazılır (geçmiş tablosu şişmesin)
  if (mode === 'check') { if (!act || t - act.last_seen >= 6 * 3600) await event(env, lic.id, 'Doğrulama', `${body.deviceName} · v${body.version || '?'}${usageText ? ' · ' + usageText : ''}`, cl); }
  else if (!act || act.removed_at) await event(env, lic.id, 'Etkinleşti', `${body.deviceName} cihazında ${mode === 'offline' ? 'çevrimdışı ' : ''}etkinleştirildi (v${body.version || '?'})`, cl);
  else await event(env, lic.id, 'Doğrulama', `${body.deviceName} yeniden etkinleştirme (aynı cihaz)`, cl);
  const token = await buildToken(env, lic, prefix, body.deviceId, 'active', t, mode === 'offline');
  return {
    status: 200,
    data: {
      ok: true, token,
      license: { customer: lic.customer, program: BY_PREFIX[prefix].name, key: lic.key_mask, expires: dateTR(lic.ends_at), limits: parseJsonSafe(lic.limits_json, {}), modules: parseJsonSafe(lic.modules_json, []) },
    },
  };
}

export async function handleLicenseApi(request, env, url, cl) {
  const t = now();
  const path = url.pathname.slice('/lisans/api'.length);
  if (!env.DB) return fail(503, 'Lisans hizmeti hazır değil.');
  if (path === '/public-key' && request.method === 'GET') {
    const { x } = await signingKey(env);
    return json({ alg: 'Ed25519', x, check_every_days: LIC.CHECK_EVERY / 86400, offline_grace_days: LIC.OFFLINE_GRACE / 86400 });
  }
  if (request.method !== 'POST' || !['/activate', '/check'].includes(path)) return fail(404, 'Bulunamadı.');
  const lu = await licLocked(env, cl.ip, t);
  if (lu) return json({ ok: false, code: 'rate_limited', message: `Çok fazla hatalı deneme. ${Math.ceil((lu - t) / 60)} dakika sonra tekrar deneyin.` }, 429);
  const body = cleanBody(await readJson(request));
  if (!body.key) { await licFail(env, cl.ip, t); return deny(404, 'invalid_key'); }
  const lic = await first(env, 'SELECT * FROM licenses WHERE key_hash = ?', await keyHash(body.key));
  if (!lic) { await licFail(env, cl.ip, t); return deny(404, 'invalid_key'); }
  const prefix = body.key.slice(0, 4);
  if (body.product && body.product !== prefix) return deny(400, 'wrong_product');
  body.product = prefix;
  const r = await activateCore(env, lic, body, cl, t, path === '/check' ? 'check' : 'activate');
  return json(r.data, r.status);
}

// ---------- Yönetim paneli API'si ----------
async function programsWithProducts(env) {
  const progs = await all(env, 'SELECT id, slug, name FROM programs ORDER BY id');
  const latest = await all(env, "SELECT program_id, id, version, created_at FROM versions WHERE status = 'ready' ORDER BY created_at DESC, id DESC");
  const latestBy = {};
  for (const v of latest) if (!latestBy[v.program_id]) latestBy[v.program_id] = v;
  return progs.filter((p) => PRODUCTS[p.slug]).map((p) => ({
    programId: p.id, slug: p.slug, name: p.name, prefix: PRODUCTS[p.slug].prefix,
    limits: PRODUCTS[p.slug].limits, modules: PRODUCTS[p.slug].modules,
    latest: latestBy[p.id] ? { id: latestBy[p.id].id, version: latestBy[p.id].version } : null,
  }));
}

export async function licenseProducts(c) {
  const t = c.t;
  const today = isoDateTR(t);
  return json({ products: await programsWithProducts(c.env), defaults: { starts: today, ends: addYearISO(today) } });
}

function displayState(lic, t, devices, lastSeen) {
  const s = licState(lic, t);
  if (s !== 'active') return s;
  if (lic.ends_at - t <= LIC.EXPIRING) return 'expiring';
  if (!devices) return 'waiting';
  if (lastSeen && t - lastSeen > LIC.STALE) return 'stale';
  return 'active';
}

export async function listLicenses(c) {
  const { env, t, url } = c;
  const rows = await all(env,
    `SELECT l.*, p.name AS program, p.slug,
      (SELECT COUNT(*) FROM activations a WHERE a.license_id = l.id AND a.removed_at IS NULL) AS devices,
      (SELECT MAX(last_seen) FROM activations a WHERE a.license_id = l.id AND a.removed_at IS NULL) AS last_seen
     FROM licenses l JOIN programs p ON p.id = l.program_id ORDER BY l.created_at DESC, l.id DESC`);
  const q = String(url.searchParams.get('q') || '').trim().toLocaleLowerCase('tr');
  const prog = Number(url.searchParams.get('program') || 0);
  const st = String(url.searchParams.get('status') || '');
  const list = rows.map((l) => ({
    id: l.id, programId: l.program_id, program: l.program, prefix: PRODUCTS[l.slug] ? PRODUCTS[l.slug].prefix : '',
    customer: l.customer, key: l.key_mask, starts: dateTR(l.starts_at), ends: dateTR(l.ends_at), endsIn: l.ends_at - t,
    devices: l.devices, maxDevices: l.max_devices, lastSeen: l.last_seen, lastSeenAgo: l.last_seen ? t - l.last_seen : null,
    state: displayState(l, t, l.devices, l.last_seen), email: l.email, phone: l.phone,
  }));
  const counts = {};
  for (const l of list) counts[l.programId] = (counts[l.programId] || 0) + 1;
  const filtered = list.filter((l) => (!prog || l.programId === prog)
    && (!st || l.state === st || (st === 'active' && ['active', 'expiring', 'stale', 'waiting'].includes(l.state)))
    && (!q || l.customer.toLocaleLowerCase('tr').includes(q) || l.key.toLowerCase().includes(q) || (l.email || '').toLowerCase().includes(q)));
  const live = list.filter((l) => ['active', 'expiring', 'stale', 'waiting'].includes(l.state));
  const checks = await first(env, "SELECT COUNT(*) AS n FROM license_events WHERE at > ? AND type IN ('Doğrulama', 'Etkinleşti')", t - 86400);
  const rejected = await first(env, "SELECT COUNT(*) AS n FROM license_events WHERE at > ? AND type IN ('Reddedildi', 'Uyarı')", t - 86400);
  return json({
    licenses: filtered,
    total: list.length,
    counts,
    stats: {
      active: live.length,
      programs: new Set(live.map((l) => l.programId)).size,
      expiring: list.filter((l) => l.state === 'expiring').length,
      devices: live.reduce((s, l) => s + l.devices, 0),
      stale: list.filter((l) => l.state === 'stale').length,
      checks24h: checks.n,
      rejected24h: rejected.n,
    },
    products: await programsWithProducts(env),
  });
}

function cleanTerms(cfg, b, base = {}) {
  const limits = {};
  for (const l of cfg.limits) {
    const v = b.limits && b.limits[l.key] !== undefined ? Number(b.limits[l.key]) : base.limits ? base.limits[l.key] : l.def;
    if (!Number.isInteger(v) || v < 0 || v > 1000000) throw new HttpError(400, `${l.label} geçersiz.`);
    limits[l.key] = v;
  }
  const allowed = cfg.modules.map((m) => m.key);
  const modules = Array.isArray(b.modules) ? [...new Set(b.modules.map(String))].filter((m) => allowed.includes(m)) : base.modules || cfg.modules.filter((m) => m.def).map((m) => m.key);
  return { limits, modules };
}

function cleanContact(b, base = {}) {
  const customer = String(b.customer ?? base.customer ?? '').trim().replace(/\s+/g, ' ');
  if (customer.length < 2 || customer.length > 120) throw new HttpError(400, 'Firma unvanı 2–120 karakter olmalı.');
  const email = String(b.email ?? base.email ?? '').trim().toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'E-posta adresi geçersiz.');
  const phone = String(b.phone ?? base.phone ?? '').replace(/[^\d+ ]/g, '').trim().slice(0, 20);
  const note = String(b.note ?? base.note ?? '').trim().slice(0, 500);
  const maxDevices = Number(b.maxDevices ?? base.max_devices ?? 1);
  if (!Number.isInteger(maxDevices) || maxDevices < 1 || maxDevices > 10) throw new HttpError(400, 'Cihaz sayısı 1–10 olmalı.');
  return { customer, email, phone, note, maxDevices };
}

export async function createLicense(c) {
  const { env, t } = c;
  const b = await readJson(c.req);
  const prog = await first(env, 'SELECT * FROM programs WHERE id = ?', Number(b.programId));
  if (!prog || !PRODUCTS[prog.slug]) return fail(400, 'Lisanslanabilir bir program seçin.');
  const cfg = PRODUCTS[prog.slug];
  const contact = cleanContact(b);
  const terms = cleanTerms(cfg, b);
  const startsIso = b.starts || isoDateTR(t);
  const startsAt = parseDateTR(startsIso, false);
  if (!startsAt) return fail(400, 'Başlangıç tarihi geçersiz.');
  const endsAt = parseDateTR(b.ends || addYearISO(startsIso), true);
  if (!startsAt || !endsAt) return fail(400, 'Tarih geçersiz.');
  if (endsAt <= startsAt) return fail(400, 'Bitiş tarihi başlangıçtan sonra olmalı.');
  if (endsAt - startsAt > 5 * 366 * 86400) return fail(400, 'Lisans süresi en fazla 5 yıl olabilir.');
  if (!env.PANEL_ENC_KEY) return fail(503, 'PANEL_ENC_KEY tanımlı değil.');
  let key, hash;
  for (let i = 0; i < 5; i++) {
    key = generateKey(cfg.prefix);
    hash = await keyHash(key);
    if (!(await first(env, 'SELECT id FROM licenses WHERE key_hash = ?', hash))) break;
  }
  const r = await run(env,
    'INSERT INTO licenses (program_id, key_hash, key_enc, key_mask, customer, email, phone, starts_at, ends_at, max_devices, limits_json, modules_json, note, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'active\', ?, ?)',
    prog.id, hash, await encryptText(env.PANEL_ENC_KEY, key), maskKey(key), contact.customer, contact.email, contact.phone,
    startsAt, endsAt, contact.maxDevices, JSON.stringify(terms.limits), JSON.stringify(terms.modules), contact.note, t, t);
  const id = r.meta.last_row_id;
  const limitText = cfg.limits.map((l) => `${terms.limits[l.key]} ${l.label.replace(' sınırı', '').toLocaleLowerCase('tr')}`).join(' · ');
  await event(env, id, 'Oluşturuldu', `Lisans oluşturuldu · ${dateTR(startsAt)} – ${dateTR(endsAt)} · ${contact.maxDevices} cihaz · ${limitText}`, c.cl);
  await audit(c, 'Lisans', `${contact.customer} için ${prog.name} lisansı oluşturuldu (${maskKey(key)})`);

  let download = null;
  if (b.withDownload) {
    const v = await first(env, "SELECT id, version FROM versions WHERE program_id = ? AND status = 'ready' ORDER BY created_at DESC, id DESC LIMIT 1", prog.id);
    if (v) {
      const token = b64url(randomBytes(32));
      await run(env, 'INSERT INTO links (token_hash, version_id, customer, expires_at, max_downloads, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        await sha256hex(token), v.id, contact.customer, t + 7 * 86400, 3, t);
      await audit(c, 'Link', `${contact.customer} için ${prog.name} ${v.version} · 168 saat · 3 indirme hakkı (lisansla birlikte)`);
      download = { url: `${c.url.origin}/indir/${token}`, version: v.version, expires: fmtTR(t + 7 * 86400) };
    }
  }
  return json({
    id, key, mask: maskKey(key), program: prog.name, customer: contact.customer,
    starts: dateTR(startsAt), ends: dateTR(endsAt), maxDevices: contact.maxDevices, limits: terms.limits, modules: terms.modules,
    limitText, download, latestVersion: download ? download.version : null,
  });
}

async function loadLicense(c, id) {
  const lic = await first(c.env, 'SELECT l.*, p.name AS program, p.slug FROM licenses l JOIN programs p ON p.id = l.program_id WHERE l.id = ?', Number(id));
  if (!lic) throw new HttpError(404, 'Lisans bulunamadı.');
  return lic;
}

export async function getLicense(c, [, id]) {
  const { env, t } = c;
  const lic = await loadLicense(c, id);
  const cfg = PRODUCTS[lic.slug];
  const devices = await all(env, 'SELECT * FROM activations WHERE license_id = ? ORDER BY removed_at IS NOT NULL, last_seen DESC', lic.id);
  const events = await all(env, 'SELECT at, type, detail, ip, location FROM license_events WHERE license_id = ? ORDER BY at DESC, id DESC LIMIT 100', lic.id);
  const latest = await first(env, "SELECT version FROM versions WHERE program_id = ? AND status = 'ready' ORDER BY created_at DESC, id DESC LIMIT 1", lic.program_id);
  const live = devices.filter((d) => !d.removed_at);
  const lastSeen = live.reduce((m, d) => Math.max(m, d.last_seen), 0);
  return json({
    id: lic.id, program: lic.program, programId: lic.program_id, prefix: cfg.prefix,
    key: await decryptText(env.PANEL_ENC_KEY, lic.key_enc).catch(() => lic.key_mask), mask: lic.key_mask,
    customer: lic.customer, email: lic.email, phone: lic.phone, note: lic.note,
    starts: dateTR(lic.starts_at), ends: dateTR(lic.ends_at), startsIso: isoDateTR(lic.starts_at), endsIso: isoDateTR(lic.ends_at),
    endsIn: lic.ends_at - t, nextYearIso: addYearISO(isoDateTR(lic.ends_at + 1)),
    maxDevices: lic.max_devices, status: lic.status, state: displayState(lic, t, live.length, lastSeen),
    limits: parseJsonSafe(lic.limits_json, {}), modules: parseJsonSafe(lic.modules_json, []),
    config: { limits: cfg.limits, modules: cfg.modules },
    latestVersion: latest ? latest.version : null,
    lic: { checkEveryDays: LIC.CHECK_EVERY / 86400, graceDays: LIC.OFFLINE_GRACE / 86400 },
    devices: devices.map((d) => ({
      id: d.id, name: d.device_name, os: d.os, fingerprint: `${d.device_id.slice(0, 4)}…${d.device_id.slice(-4)}`,
      version: d.app_version, usage: parseJsonSafe(d.usage_json, {}), ip: d.ip, location: d.location,
      activated: fmtTR(d.activated_at), lastSeenAgo: t - d.last_seen, lastSeen: fmtTR(d.last_seen),
      removed: d.removed_at ? fmtTR(d.removed_at) : null,
    })),
    events: events.map((e) => ({ ...e, time: fmtTR(e.at) })),
    created: fmtTR(lic.created_at),
  });
}

export async function updateLicense(c, [, id]) {
  const lic = await loadLicense(c, id);
  if (lic.status === 'revoked') return fail(400, 'İptal edilmiş lisans düzenlenemez.');
  const b = await readJson(c.req);
  const cfg = PRODUCTS[lic.slug];
  const contact = cleanContact(b, lic);
  const terms = cleanTerms(cfg, b, { limits: parseJsonSafe(lic.limits_json, {}), modules: parseJsonSafe(lic.modules_json, []) });
  await run(c.env, 'UPDATE licenses SET customer = ?, email = ?, phone = ?, note = ?, max_devices = ?, limits_json = ?, modules_json = ?, updated_at = ? WHERE id = ?',
    contact.customer, contact.email, contact.phone, contact.note, contact.maxDevices, JSON.stringify(terms.limits), JSON.stringify(terms.modules), c.t, lic.id);
  const limitText = cfg.limits.map((l) => `${terms.limits[l.key]} ${l.label.replace(' sınırı', '').toLocaleLowerCase('tr')}`).join(' · ');
  await event(c.env, lic.id, 'Düzenlendi', `Koşullar güncellendi · ${contact.maxDevices} cihaz · ${limitText}`, c.cl);
  await audit(c, 'Lisans', `${contact.customer} · ${lic.program} lisans koşulları güncellendi`);
  return json({ ok: true });
}

export async function extendLicense(c, [, id]) {
  const lic = await loadLicense(c, id);
  if (lic.status === 'revoked') return fail(400, 'İptal edilmiş lisansın süresi uzatılamaz.');
  const b = await readJson(c.req);
  const endsAt = parseDateTR(b.ends, true);
  if (!endsAt) return fail(400, 'Yeni bitiş tarihi geçersiz.');
  if (endsAt <= lic.ends_at) return fail(400, 'Yeni bitiş tarihi mevcut bitişten sonra olmalı.');
  if (endsAt - c.t > 5 * 366 * 86400) return fail(400, 'Bitiş en fazla 5 yıl sonrası olabilir.');
  await run(c.env, 'UPDATE licenses SET ends_at = ?, updated_at = ? WHERE id = ?', endsAt, c.t, lic.id);
  await event(c.env, lic.id, 'Süre uzatıldı', `${dateTR(lic.ends_at)} → ${dateTR(endsAt)}`, c.cl);
  await audit(c, 'Lisans', `${lic.customer} · ${lic.program} süresi ${dateTR(endsAt)} tarihine uzatıldı`);
  return json({ ok: true, ends: dateTR(endsAt) });
}

async function setStatus(c, id, to, label) {
  const lic = await loadLicense(c, id);
  if (lic.status === 'revoked') return fail(400, 'İptal edilmiş lisans değiştirilemez.');
  if (to === 'active' && lic.status !== 'suspended') return fail(400, 'Lisans askıda değil.');
  await run(c.env, 'UPDATE licenses SET status = ?, updated_at = ? WHERE id = ?', to, c.t, lic.id);
  await event(c.env, lic.id, label, `Lisans durumu: ${label.toLocaleLowerCase('tr')}`, c.cl);
  await audit(c, 'Lisans', `${lic.customer} · ${lic.program} lisansı ${label.toLocaleLowerCase('tr')}`);
  return json({ ok: true });
}
export const suspendLicense = (c, [, id]) => setStatus(c, id, 'suspended', 'Askıya alındı');
export const resumeLicense = (c, [, id]) => setStatus(c, id, 'active', 'Yeniden açıldı');
export const revokeLicense = (c, [, id]) => setStatus(c, id, 'revoked', 'İptal edildi');

export async function removeDevice(c, [, id, did]) {
  const lic = await loadLicense(c, id);
  const d = await first(c.env, 'SELECT * FROM activations WHERE id = ? AND license_id = ? AND removed_at IS NULL', Number(did), lic.id);
  if (!d) return fail(404, 'Cihaz bulunamadı.');
  await run(c.env, 'UPDATE activations SET removed_at = ? WHERE id = ?', c.t, d.id);
  await event(c.env, lic.id, 'Cihaz kaldırıldı', `${d.device_name} cihazının lisansı kaldırıldı; yer açıldı`, c.cl);
  await audit(c, 'Lisans', `${lic.customer} · ${lic.program} · ${d.device_name} cihazı kaldırıldı`);
  return json({ ok: true });
}

// Çevrimdışı etkinleştirme: müşteri programı bir "istek kodu" üretir, panel imzalı lisans kodu verir
export async function offlineActivate(c, [, id]) {
  const lic = await loadLicense(c, id);
  const b = await readJson(c.req);
  let req;
  try {
    const raw = String(b.request || '').replace(/\s+/g, '').replace(/^ODR1\./, '');
    req = JSON.parse(new TextDecoder().decode(unb64url(raw)));
  } catch {
    return fail(400, 'İstek kodu okunamadı. Müşterinin programındaki kodu eksiksiz yapıştırın.');
  }
  const key = normalizeKey(req.k);
  if (!key || (await keyHash(key)) !== lic.key_hash) return fail(400, 'İstek kodu bu lisansa ait değil.');
  const body = cleanBody({ key, device_id: req.d, device_name: req.n, os: req.o, app_version: req.v, product: key.slice(0, 4), usage: req.u });
  const r = await activateCore(c.env, lic, body, c.cl, c.t, 'offline');
  if (r.status !== 200) return fail(r.status, r.data.message);
  await audit(c, 'Lisans', `${lic.customer} · ${lic.program} · ${body.deviceName} çevrimdışı etkinleştirildi`);
  return json({ token: r.data.token, device: body.deviceName });
}
