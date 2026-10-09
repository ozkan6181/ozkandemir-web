// ozkandemir.net V3.6 — Panel ve lisans modüllerinin ortak sunucu yardımcıları
import { now } from './security.js';

// ---------- Yardımcılar ----------
export function secure(resp, csp) {
  const r = new Response(resp.body, resp);
  const h = r.headers;
  h.set('Content-Security-Policy', csp);
  h.set('X-Frame-Options', 'DENY');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Strict-Transport-Security', 'max-age=31536000');
  h.set('X-Robots-Tag', 'noindex, nofollow');
  h.set('Cache-Control', 'no-store');
  h.delete('access-control-allow-origin');
  return r;
}

export const json = (data, status = 200, headers) => {
  const h = new Headers(headers);
  h.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data), { status, headers: h });
};
export const fail = (status, error, extra = {}) => json({ error, ...extra }, status);

export const q = (env, sql, ...a) => env.DB.prepare(sql).bind(...a.map((v) => (v === undefined ? null : v)));
export const first = (env, sql, ...a) => q(env, sql, ...a).first();
export const all = async (env, sql, ...a) => (await q(env, sql, ...a).all()).results || [];
export const run = (env, sql, ...a) => q(env, sql, ...a).run();
export const changes = (r) => (r && r.meta ? r.meta.changes : 0);

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
export const setCookie = (name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

export function clientInfo(req) {
  const cf = req.cf || {};
  return {
    ip: req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || '0.0.0.0',
    location: [cf.city, cf.country].filter(Boolean).join(', ') || 'Bilinmiyor',
    ua: (req.headers.get('user-agent') || '').slice(0, 300),
  };
}

export async function readJson(req) {
  const len = Number(req.headers.get('content-length') || 0);
  if (len > 64 * 1024) throw new HttpError(413, 'İstek çok büyük.');
  try {
    const b = await req.json();
    return b && typeof b === 'object' ? b : {};
  } catch {
    throw new HttpError(400, 'Geçersiz istek gövdesi.');
  }
}

export class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

export function fmtTR(t) {
  if (!t) return '';
  const d = new Date((Number(t) + 3 * 3600) * 1000); // Türkiye UTC+3
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

export function slugify(s) {
  const map = { ç: 'c', ğ: 'g', ı: 'i', i: 'i', ö: 'o', ş: 's', ü: 'u', Ç: 'c', Ğ: 'g', İ: 'i', I: 'i', Ö: 'o', Ş: 's', Ü: 'u' };
  return String(s).replace(/[çğıöşüÇĞİIÖŞÜ]/g, (m) => map[m] || m).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export function cleanFilename(name) {
  const base = String(name || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').trim();
  return base.slice(-120);
}

export const fmtSize = (n) => {
  n = Number(n) || 0;
  if (!n) return '0 MB';
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2).replace('.', ',') + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1).replace('.', ',') + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
};

export function contentDisposition(filename) {
  const ascii = slugify(filename.replace(/\.[^.]+$/, '')) + (filename.match(/\.[A-Za-z0-9]+$/) || [''])[0].toLowerCase();
  return `attachment; filename="${ascii || 'dosya'}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function audit(c, type, detail) {
  try {
    await run(c.env, 'INSERT INTO audit (at, type, detail, ip, location, ua) VALUES (?, ?, ?, ?, ?, ?)',
      now(), type, String(detail).slice(0, 500), c.cl.ip, c.cl.location, c.cl.ua);
  } catch (e) {
    console.error('audit', e);
  }
}


// ---------- Atomik deneme sayacı ----------
// Denemeyi kontrol ETMEDEN ÖNCE tek SQL ifadesiyle sayar; paralel isteklerle sınır aşılamaz.
// Dönüş: { fails, locked_until } — locked_until > t ise istek reddedilmeli.
export async function chargeAttempt(env, key, t, max, windowSecs, lockSecs) {
  return first(env,
    `INSERT INTO login_attempts (key, fails, first_at, locked_until) VALUES (?, 1, ?, 0)
     ON CONFLICT(key) DO UPDATE SET
       fails = CASE WHEN locked_until > ? THEN fails
                    WHEN locked_until > 0 OR first_at < ? THEN 1
                    ELSE fails + 1 END,
       first_at = CASE WHEN locked_until > ? THEN first_at
                       WHEN locked_until > 0 OR first_at < ? THEN ?
                       ELSE first_at END,
       locked_until = CASE WHEN locked_until > ? THEN locked_until
                           WHEN locked_until > 0 OR first_at < ? THEN 0
                           WHEN fails + 1 > ? THEN ?
                           ELSE 0 END
     RETURNING fails, locked_until`,
    key, t,
    t, t - windowSecs,
    t, t - windowSecs, t,
    t, t - windowSecs, max, t + lockSecs);
}

// Başarısız denemeden sonra sınıra ulaşıldıysa hemen kilitle
export async function lockIfReached(env, key, t, max, lockSecs) {
  const r = await run(env, 'UPDATE login_attempts SET locked_until = ? WHERE key = ? AND fails >= ? AND locked_until <= ?', t + lockSecs, key, max, t);
  return changes(r) > 0 ? t + lockSecs : 0;
}
