// ozkandemir.net V3.6 — Panel güvenlik çekirdeği
// Yalnızca Web Crypto kullanır (Cloudflare Workers ve Node 20+ ile uyumlu).

const enc = new TextEncoder();
const dec = new TextDecoder();

export const now = () => Math.floor(Date.now() / 1000);

export function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function b64(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function unb64(s) {
  const bin = atob(String(s));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const b64url = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64url = (s) => unb64(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4));

export const randomToken = (n = 32) => b64url(randomBytes(n));

export async function sha256hex(input) {
  const data = typeof input === 'string' ? enc.encode(input) : input;
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...h].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// Sabit süreli karşılaştırma (zamanlama saldırılarına karşı)
export function timingSafeEqual(a, b) {
  a = String(a);
  b = String(b);
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// ---------- Şifre: PBKDF2-SHA256 ----------
// Cloudflare Workers PBKDF2 için en fazla 100.000 tur destekler.
export const PBKDF2_ITER = 100000;

export async function hashPassword(password, salt = randomBytes(16), iterations = PBKDF2_ITER) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return `pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(bits)}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 10000 || iterations > PBKDF2_ITER) return false;
  const calc = await hashPassword(password, unb64(parts[2]), iterations);
  return timingSafeEqual(calc, stored);
}

export function passwordProblem(pw) {
  pw = String(pw || '');
  if (pw.length < 14) return 'Şifre en az 14 karakter olmalı.';
  if (pw.length > 256) return 'Şifre çok uzun.';
  if (!/[a-zçğıöşü]/.test(pw) || !/[A-ZÇĞİÖŞÜ]/.test(pw) || !/\d/.test(pw)) return 'Şifre büyük harf, küçük harf ve rakam içermeli.';
  return '';
}

// ---------- Base32 (RFC 4648) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes) {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const s = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of s) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Geçersiz base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

// ---------- TOTP (RFC 6238, HMAC-SHA1, 30 sn) ----------
export async function hotp(secretBytes, counter, digits = 6) {
  const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
  const o = mac[mac.length - 1] & 15;
  const bin = ((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

// Doğruysa kullanılan zaman adımını döndürür; aynı kod ikinci kez kabul edilmez (lastStep).
export async function verifyTotp(secretBytes, code, lastStep = 0, t = now()) {
  code = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(t / 30);
  for (const d of [0, -1, 1]) {
    const s = step + d;
    if (s <= lastStep) continue;
    if (timingSafeEqual(await hotp(secretBytes, s), code)) return s;
  }
  return null;
}

export function otpauthUri(secretB32, email) {
  const label = encodeURIComponent('ozkandemir.net:' + email);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=ozkandemir.net&algorithm=SHA1&digits=6&period=30`;
}

// ---------- Yedek kodlar ----------
export function newBackupCodes(n = 10) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const codes = [];
  for (let i = 0; i < n; i++) {
    const r = randomBytes(8);
    let c = '';
    for (let j = 0; j < 8; j++) c += alphabet[r[j] % alphabet.length];
    codes.push(c.slice(0, 4) + '-' + c.slice(4));
  }
  return codes;
}
export const normalizeBackupCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ---------- AES-GCM (TOTP anahtarını veritabanında şifreli tutmak için) ----------
async function aesKey(keyB64) {
  const raw = unb64(String(keyB64 || ''));
  if (raw.length !== 32) throw new Error('PANEL_ENC_KEY 32 baytlık base64 olmalı');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptText(keyB64, text) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(keyB64), enc.encode(text));
  return `v1:${b64(iv)}:${b64(ct)}`;
}

export async function decryptText(keyB64, payload) {
  const [v, iv, ct] = String(payload || '').split(':');
  if (v !== 'v1') throw new Error('Bilinmeyen şifreleme biçimi');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(keyB64), unb64(ct));
  return dec.decode(pt);
}

// ---------- Cloudflare Access JWT doğrulaması ----------
let certCache = { at: 0, team: '', keys: [] };

export async function verifyAccessJwt(token, teamDomain, aud, fetchImpl = fetch) {
  try {
    if (!token || !teamDomain || !aud) return null;
    const team = String(teamDomain).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    const header = JSON.parse(dec.decode(unb64url(parts[0])));
    const payload = JSON.parse(dec.decode(unb64url(parts[1])));
    if (header.alg !== 'RS256') return null;
    const t = now();
    if (!payload.exp || payload.exp < t) return null;
    if (payload.nbf && payload.nbf > t + 60) return null;
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(aud)) return null;
    if (payload.iss !== `https://${team}`) return null;
    if (certCache.team !== team || t - certCache.at > 3600 || !certCache.keys.some((k) => k.kid === header.kid)) {
      const r = await fetchImpl(`https://${team}/cdn-cgi/access/certs`);
      if (!r.ok) return null;
      const j = await r.json();
      certCache = { at: t, team, keys: Array.isArray(j.keys) ? j.keys : [] };
    }
    const jwk = certCache.keys.find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64url(parts[2]), enc.encode(parts[0] + '.' + parts[1]));
    return ok ? payload : null;
  } catch {
    return null;
  }
}

export function _resetAccessCache() {
  certCache = { at: 0, team: '', keys: [] };
}
