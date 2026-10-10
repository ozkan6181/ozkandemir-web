// ozkandemir.net V3.7 — Yönetim paneli API'si, web üzerinden ilk kurulum ve müşteri indirme sayfası
import {
  now, randomBytes, randomToken, sha256hex, timingSafeEqual,
  hashPassword, verifyPassword, passwordProblem,
  base32Encode, base32Decode, verifyTotp, otpauthUri,
  newBackupCodes, normalizeBackupCode,
  encryptText, decryptText, verifyAccessJwt,
} from './security.js';
import {
  secure, json, fail, q, first, all, run, changes, parseCookies, setCookie, clientInfo, readJson, HttpError, fmtTR, esc, slugify, cleanFilename, fmtSize, contentDisposition, audit,
  chargeAttempt, lockIfReached,
} from './common.js';
import {
  handleLicenseApi, licenseProducts, listLicenses, createLicense, getLicense, updateLicense, extendLicense,
  suspendLicense, resumeLicense, revokeLicense, removeDevice, offlineActivate,
} from './license.js';
import { prepareEnv } from './bootstrap.js';
import { signingPublicKey, isoDateTR, dateTR, LIC } from './license.js';
import { handleUpdateApi, publishRelease, unpublishRelease, releaseSummary } from './guncelleme.js';
import { getPayroll, previewPayroll, publishPayroll, restorePayroll, dismissAlert, isPayrollPublicPath, servePayrollPublic } from './parametre.js';
import { runWatch } from './watch.js';
import { accessConfig, markAccessActive, cloudflareSetup, CfError } from './cfsetup.js';

// ---------- Ayarlar ----------
export const CFG = {
  SESSION_ABS: 8 * 3600,        // oturum en fazla 8 saat
  SESSION_IDLE: 30 * 60,        // 30 dk hareketsizlikte biter
  CHALLENGE_TTL: 5 * 60,        // şifreden sonra kod için 5 dk
  CHALLENGE_MAX: 5,             // bir girişte en fazla 5 kod denemesi
  TRUST_TTL: 30 * 86400,        // "bu cihaza güven" 30 gün
  IP_MAX: 5,                    // aynı IP'den 5 hata → kilit
  ACCT_MAX: 10,                 // tüm IP'lerden toplam 10 hata → hesap kilidi
  FAIL_WINDOW: 15 * 60,
  LOCK_SECS: 15 * 60,
  PART_SIZE: 20 * 1024 * 1024,  // yükleme parçası 20 MB
  MAX_FILE: 2 * 1024 ** 3,      // en fazla 2 GB
  FREE_QUOTA: 10 * 1024 ** 3,   // R2 ücretsiz kota
};
const ALLOWED_EXT = ['zip', 'exe', 'msi', 'rar', '7z'];
const SESS = '__Host-od_sess';
const TRUST = '__Host-od_trust';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const CSP_PANEL = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const CSP_DL = "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

// ---------- Deneme sınırı ----------
// Güvenilir cihazdan gelen istek hesap kilidinden etkilenmez (yöneticiyi dışarıda bırakma saldırısına karşı)
const limitKeys = (c, trusted = false) => [['ip:' + c.cl.ip, CFG.IP_MAX], ...(trusted ? [] : [['acct', CFG.ACCT_MAX]])];

// Denemeyi önceden say; kilitliyse kilit bitiş zamanını döndür
async function chargeAll(c, trusted = false) {
  let until = 0;
  for (const [key, max] of limitKeys(c, trusted)) {
    const r = await chargeAttempt(c.env, key, c.t, max, CFG.FAIL_WINDOW, CFG.LOCK_SECS);
    if (r && r.locked_until > c.t) until = Math.max(until, r.locked_until);
  }
  return until;
}

// Hatalı denemeden sonra: sınıra ulaşıldıysa kilitle
async function registerFail(c, trusted = false) {
  let locked = 0;
  for (const [key, max] of limitKeys(c, trusted)) locked = Math.max(locked, await lockIfReached(c.env, key, c.t, max, CFG.LOCK_SECS));
  return locked;
}

async function isTrustedDevice(c) {
  const tok = c.cookies[TRUST];
  if (!tok || !TOKEN_RE.test(tok)) return false;
  return Boolean(await first(c.env, 'SELECT id_hash FROM trusted_devices WHERE id_hash = ? AND expires_at > ?', await sha256hex(tok), c.t));
}

const clearFails = (c) => run(c.env, 'DELETE FROM login_attempts WHERE key IN (?, ?)', 'ip:' + c.cl.ip, 'acct');

const lockedResp = (until, t) => {
  const mins = Math.max(1, Math.ceil((until - t) / 60));
  return fail(429, `Çok fazla hatalı deneme. ${mins} dakika sonra tekrar deneyin.`, { retryAfter: until - t });
};

// ---------- Oturum ----------
async function createSession(c) {
  const tok = randomToken(32);
  await run(c.env, 'INSERT INTO sessions (id_hash, created_at, last_seen, expires_at, ip, location, ua) VALUES (?, ?, ?, ?, ?, ?, ?)',
    await sha256hex(tok), c.t, c.t, c.t + CFG.SESSION_ABS, c.cl.ip, c.cl.location, c.cl.ua);
  return setCookie(SESS, tok, CFG.SESSION_ABS);
}

async function getSession(c) {
  const tok = c.cookies[SESS];
  if (!tok || !TOKEN_RE.test(tok)) return null;
  const h = await sha256hex(tok);
  const s = await first(c.env, 'SELECT * FROM sessions WHERE id_hash = ? AND revoked = 0 AND expires_at > ? AND last_seen > ?',
    h, c.t, c.t - CFG.SESSION_IDLE);
  if (!s) return null;
  if (c.t - s.last_seen >= 15) {
    await run(c.env, 'UPDATE sessions SET last_seen = ? WHERE id_hash = ?', c.t, h);
    s.last_seen = c.t;
  }
  return s;
}

const getAdmin = (env) => first(env, 'SELECT * FROM admin WHERE id = 1');

async function totpSecret(c, enc) {
  return base32Decode(await decryptText(c.env.PANEL_ENC_KEY, enc));
}

// Oturum içindeki hassas işlemler için doğrulama kodu kontrolü (tekrar kullanım engelli)
async function checkTotp(c, admin, code) {
  const step = await verifyTotp(await totpSecret(c, admin.totp_enc), code, admin.totp_last_step, c.t);
  if (step === null) return false;
  const r = await run(c.env, 'UPDATE admin SET totp_last_step = ? WHERE id = 1 AND totp_last_step < ?', step, step);
  return changes(r) === 1;
}

async function useBackupCode(c, code) {
  const r = await run(c.env, 'UPDATE backup_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL',
    c.t, await sha256hex('bc:' + normalizeBackupCode(code)));
  return changes(r) === 1;
}

async function cleanup(c) {
  const t = c.t;
  await run(c.env, 'DELETE FROM challenges WHERE expires_at < ?', t);
  await run(c.env, 'DELETE FROM sessions WHERE expires_at < ?', t - 30 * 86400);
  await run(c.env, 'DELETE FROM trusted_devices WHERE expires_at < ?', t);
  await run(c.env, 'DELETE FROM login_attempts WHERE locked_until < ? AND first_at < ?', t, t - CFG.FAIL_WINDOW);
  await run(c.env, 'DELETE FROM audit WHERE at < ?', t - 365 * 86400 - 3600);
  await run(c.env, "DELETE FROM license_events WHERE at < ? AND type = 'Doğrulama'", t - 180 * 86400);
}

// ---------- Giriş ----------
async function login(c) {
  const trusted = await isTrustedDevice(c);
  const lu = await chargeAll(c, trusted);
  if (lu) return lockedResp(lu, c.t);
  const b = await readJson(c.req);
  const email = String(b.email || '').trim().toLowerCase().slice(0, 200);
  const password = String(b.password || '').slice(0, 256);
  const admin = await getAdmin(c.env);
  let ok = false;
  if (admin) {
    const pwOk = await verifyPassword(password, admin.pass_hash);
    ok = pwOk && timingSafeEqual(email, String(admin.email).toLowerCase());
  } else {
    await hashPassword(password); // süre farkından bilgi sızmasın
  }
  if (!ok) {
    const l = await registerFail(c, trusted);
    await audit(c, 'Başarısız giriş', `Hatalı e-posta veya şifre (${email || 'boş'})`);
    if (l) {
      await audit(c, 'Engellendi', `Çok fazla hatalı deneme · ${Math.round((l - c.t) / 60)} dk kilit`);
      return lockedResp(l, c.t);
    }
    return fail(401, 'E-posta veya şifre hatalı.');
  }

  if (trusted) {
    await clearFails(c);
    const ck = await createSession(c);
    await audit(c, 'Giriş', 'Şifre + güvenilir cihaz ile başarılı giriş');
    return json({ ok: true }, 200, { 'set-cookie': ck });
  }

  const ch = randomToken(32);
  await run(c.env, 'INSERT INTO challenges (id_hash, created_at, expires_at, ip) VALUES (?, ?, ?, ?)',
    await sha256hex(ch), c.t, c.t + CFG.CHALLENGE_TTL, c.cl.ip);
  await cleanup(c);
  return json({ challenge: ch, expiresIn: CFG.CHALLENGE_TTL });
}

async function verify(c) {
  const lu = await chargeAll(c);
  if (lu) return lockedResp(lu, c.t);
  const b = await readJson(c.req);
  const chTok = String(b.challenge || '');
  if (!TOKEN_RE.test(chTok)) return fail(400, 'Geçersiz doğrulama isteği.');
  const chHash = await sha256hex(chTok);
  // Deneme hakkını kodu kontrol etmeden ÖNCE atomik olarak düş (paralel tahminlere karşı)
  const ch = await first(c.env, 'UPDATE challenges SET attempts = attempts + 1 WHERE id_hash = ? AND expires_at > ? AND attempts < ? RETURNING attempts',
    chHash, c.t, CFG.CHALLENGE_MAX);
  if (!ch) return fail(401, 'Doğrulama süresi doldu veya çok fazla hatalı kod girildi. Lütfen yeniden giriş yapın.', { restart: true });
  const admin = await getAdmin(c.env);
  const code = String(b.code || '').trim();
  let ok = false, method = '';
  if (/^\d{6}$/.test(code.replace(/\s/g, ''))) {
    ok = await checkTotp(c, admin, code);
    method = 'doğrulama kodu';
  } else if (normalizeBackupCode(code).length === 8) {
    ok = await useBackupCode(c, code);
    method = 'yedek kod';
  }
  if (!ok) {
    const last = ch.attempts >= CFG.CHALLENGE_MAX;
    if (last) await run(c.env, 'DELETE FROM challenges WHERE id_hash = ?', chHash);
    const l = await registerFail(c);
    await audit(c, 'Başarısız doğrulama', method === 'yedek kod' ? 'Hatalı yedek kod' : 'Hatalı doğrulama kodu');
    if (l) {
      await audit(c, 'Engellendi', `Çok fazla hatalı deneme · ${Math.round((l - c.t) / 60)} dk kilit`);
      return lockedResp(l, c.t);
    }
    if (last) return fail(401, 'Çok fazla hatalı kod. Lütfen yeniden giriş yapın.', { restart: true });
    return fail(401, 'Kod hatalı veya süresi geçmiş.');
  }

  await run(c.env, 'DELETE FROM challenges WHERE id_hash = ?', chHash);
  await clearFails(c);
  const seen = await first(c.env, 'SELECT 1 AS x FROM sessions WHERE ua = ? LIMIT 1', c.cl.ua);
  const headers = new Headers();
  headers.append('set-cookie', await createSession(c));
  if (b.trust === true) {
    const tt = randomToken(32);
    await run(c.env, 'INSERT INTO trusted_devices (id_hash, created_at, expires_at, ua) VALUES (?, ?, ?, ?)',
      await sha256hex(tt), c.t, c.t + CFG.TRUST_TTL, c.cl.ua);
    headers.append('set-cookie', setCookie(TRUST, tt, CFG.TRUST_TTL));
  }
  await audit(c, 'Giriş', `Şifre + ${method} ile başarılı giriş${b.trust === true ? ' · cihaz 30 gün güvenilir' : ''}`);
  if (!seen) await audit(c, 'Uyarı', 'Daha önce görülmemiş cihaz/tarayıcıdan giriş yapıldı');
  let backupLeft;
  if (method === 'yedek kod') {
    backupLeft = (await first(c.env, 'SELECT COUNT(*) AS n FROM backup_codes WHERE used_at IS NULL')).n;
  }
  return json({ ok: true, backupLeft }, 200, headers);
}

async function logout(c) {
  await run(c.env, 'UPDATE sessions SET revoked = 1 WHERE id_hash = ?', c.session.id_hash);
  await audit(c, 'Çıkış', 'Kullanıcı çıkış yaptı');
  return json({ ok: true }, 200, { 'set-cookie': setCookie(SESS, '', 0) });
}

// ---------- Bilgi ----------
async function me(c) {
  const admin = await getAdmin(c.env);
  return json({
    email: admin.email,
    serverTime: c.t,
    idleTimeout: CFG.SESSION_IDLE,
    expiresAt: c.session.expires_at,
    location: c.session.location,
    ua: c.session.ua,
  });
}

function monthStartTR(t) {
  const d = new Date((t + 3 * 3600) * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000 - 3 * 3600;
}

async function overview(c) {
  const env = c.env, t = c.t;
  const programs = await all(env, 'SELECT id, slug, name FROM programs ORDER BY id');
  const versions = await all(env, "SELECT id, program_id, version, filename, size, sha256, created_at FROM versions WHERE status = 'ready' ORDER BY created_at DESC, id DESC");
  const active = await all(env,
    'SELECT v.program_id AS pid, COUNT(*) AS n, MIN(l.expires_at) AS next FROM links l JOIN versions v ON v.id = l.version_id WHERE l.revoked = 0 AND l.expires_at > ? AND l.downloads < l.max_downloads GROUP BY v.program_id', t);
  const activeBy = Object.fromEntries(active.map((a) => [a.pid, a]));
  const latest = {};
  const counts = {};
  for (const v of versions) {
    if (!latest[v.program_id]) latest[v.program_id] = v;
    counts[v.program_id] = (counts[v.program_id] || 0) + 1;
  }
  const list = programs.map((p) => {
    const v = latest[p.id];
    return {
      id: p.id, name: p.name, slug: p.slug,
      versionCount: counts[p.id] || 0,
      latest: v ? { id: v.id, version: v.version, filename: v.filename, size: v.size, sizeText: fmtSize(v.size), date: fmtTR(v.created_at), at: v.created_at } : null,
      access: activeBy[p.id] ? 'link' : 'private',
      activeLinks: activeBy[p.id] ? activeBy[p.id].n : 0,
    };
  }).sort((a, b) => ((b.latest && b.latest.at) || 0) - ((a.latest && a.latest.at) || 0) || a.id - b.id);
  const rel = await releaseSummary(env, t);
  for (const p of list) p.release = rel[p.id] || null;
  const storage = versions.reduce((s, v) => s + Number(v.size || 0), 0);
  const totalActive = active.reduce((s, a) => s + a.n, 0);
  const next = active.reduce((m, a) => (m && m < a.next ? m : a.next), 0);
  const dl = await first(env, "SELECT COUNT(*) AS n FROM audit WHERE type = 'İndirme' AND at >= ?", monthStartTR(t));
  return json({
    programs: list,
    stats: {
      programs: programs.length,
      versions: versions.length,
      storage, storageText: fmtSize(storage),
      quotaPct: Math.round((storage / CFG.FREE_QUOTA) * 1000) / 10,
      activeLinks: totalActive,
      nextExpiryIn: next ? next - t : 0,
      downloadsThisMonth: dl ? dl.n : 0,
    },
    limits: { maxFile: CFG.MAX_FILE, partSize: CFG.PART_SIZE, extensions: ALLOWED_EXT },
  });
}

async function createProgram(c) {
  const b = await readJson(c.req);
  const name = String(b.name || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 80) return fail(400, 'Program adı 2–80 karakter olmalı.');
  const slug = slugify(name);
  if (!slug) return fail(400, 'Program adı geçersiz.');
  if (await first(c.env, 'SELECT id FROM programs WHERE slug = ?', slug)) return fail(409, 'Bu isimde bir program zaten var.');
  const r = await run(c.env, 'INSERT INTO programs (slug, name, created_at) VALUES (?, ?, ?)', slug, name, c.t);
  await audit(c, 'Program', `Yeni program eklendi: ${name}`);
  return json({ id: r.meta.last_row_id, name, slug });
}

async function listVersions(c, [, pid]) {
  const p = await first(c.env, 'SELECT id, name FROM programs WHERE id = ?', Number(pid));
  if (!p) return fail(404, 'Program bulunamadı.');
  const rows = await all(c.env,
    "SELECT v.id, v.version, v.filename, v.size, v.sha256, v.notes, v.created_at, (SELECT COUNT(*) FROM links l WHERE l.version_id = v.id AND l.revoked = 0 AND l.expires_at > ? AND l.downloads < l.max_downloads) AS active, r.published_at AS released_at, r.mandatory, r.public_notes FROM versions v LEFT JOIN releases r ON r.version_id = v.id WHERE v.program_id = ? AND v.status = 'ready' ORDER BY v.created_at DESC, v.id DESC",
    c.t, p.id);
  return json({
    program: p,
    versions: rows.map((v) => ({ ...v, sizeText: fmtSize(v.size), date: fmtTR(v.created_at), released: v.released_at ? fmtTR(v.released_at) : null, mandatory: Boolean(v.mandatory) })),
  });
}

async function deleteVersion(c, [, vid]) {
  const v = await first(c.env, 'SELECT v.*, p.name AS program FROM versions v JOIN programs p ON p.id = v.program_id WHERE v.id = ?', Number(vid));
  if (!v) return fail(404, 'Sürüm bulunamadı.');
  if (v.status === 'uploading' && v.upload_id) {
    try { await c.env.FILES.resumeMultipartUpload(v.r2_key, v.upload_id).abort(); } catch {}
  } else {
    await c.env.FILES.delete(v.r2_key);
  }
  await run(c.env, 'DELETE FROM links WHERE version_id = ?', v.id);
  await run(c.env, 'DELETE FROM releases WHERE version_id = ?', v.id);
  await run(c.env, 'DELETE FROM versions WHERE id = ?', v.id);
  await audit(c, 'Silme', `${v.program} ${v.version} silindi (bağlı indirme linkleri iptal edildi)`);
  return json({ ok: true });
}

// ---------- Yükleme (R2 çok parçalı) ----------
const partsFor = (size) => Math.max(1, Math.ceil(size / CFG.PART_SIZE));

async function uploadStart(c) {
  const b = await readJson(c.req);
  const p = await first(c.env, 'SELECT * FROM programs WHERE id = ?', Number(b.programId));
  if (!p) return fail(400, 'Program seçin.');
  const version = String(b.version || '').trim();
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/.test(version)) return fail(400, 'Sürüm numarası geçersiz (ör. v2.4.0).');
  const filename = cleanFilename(b.filename);
  const ext = (filename.match(/\.([A-Za-z0-9]+)$/) || [])[1];
  if (!filename || !ext || !ALLOWED_EXT.includes(ext.toLowerCase())) return fail(400, `İzin verilen dosya türleri: ${ALLOWED_EXT.map((e) => '.' + e).join(', ')}`);
  const size = Number(b.size);
  if (!Number.isInteger(size) || size < 1) return fail(400, 'Dosya boş.');
  if (size > CFG.MAX_FILE) return fail(400, 'Dosya 2 GB sınırını aşıyor.');
  const notes = String(b.notes || '').trim().slice(0, 1000);

  const existing = await first(c.env, 'SELECT * FROM versions WHERE program_id = ? AND version = ?', p.id, version);
  if (existing && existing.status === 'ready') return fail(409, `${p.name} için ${version} sürümü zaten var.`);
  if (existing) {
    try { await c.env.FILES.resumeMultipartUpload(existing.r2_key, existing.upload_id).abort(); } catch {}
    await run(c.env, 'DELETE FROM versions WHERE id = ?', existing.id);
  }
  const safe = slugify(filename.replace(/\.[^.]+$/, '')) + '.' + ext.toLowerCase();
  const key = `programlar/${p.slug}/${slugify(version) || 'surum'}/${randomToken(6)}-${safe}`;
  const mp = await c.env.FILES.createMultipartUpload(key, {
    httpMetadata: { contentType: 'application/octet-stream', contentDisposition: contentDisposition(filename) },
    customMetadata: { program: p.slug, version },
  });
  const r = await run(c.env,
    "INSERT INTO versions (program_id, version, filename, size, notes, r2_key, upload_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'uploading', ?)",
    p.id, version, filename, size, notes, key, mp.uploadId, c.t);
  return json({ versionId: r.meta.last_row_id, partSize: CFG.PART_SIZE, parts: partsFor(size) });
}

async function uploadingRow(c, vid) {
  const v = await first(c.env, "SELECT v.*, p.name AS program FROM versions v JOIN programs p ON p.id = v.program_id WHERE v.id = ? AND v.status = 'uploading'", Number(vid));
  if (!v) throw new HttpError(404, 'Yükleme bulunamadı veya tamamlanmış.');
  return v;
}

async function uploadPart(c, [, vid, n]) {
  const v = await uploadingRow(c, vid);
  const total = partsFor(v.size);
  const part = Number(n);
  if (!Number.isInteger(part) || part < 1 || part > total) return fail(400, 'Geçersiz parça numarası.');
  const expected = part < total ? CFG.PART_SIZE : v.size - (total - 1) * CFG.PART_SIZE;
  const declared = Number(c.req.headers.get('content-length') || -1);
  if (declared !== -1 && declared !== expected) return fail(400, 'Parça boyutu beklenenden farklı.');
  const body = await c.req.arrayBuffer();
  if (body.byteLength !== expected) return fail(400, 'Parça boyutu beklenenden farklı.');
  const mp = c.env.FILES.resumeMultipartUpload(v.r2_key, v.upload_id);
  const up = await mp.uploadPart(part, body);
  return json({ partNumber: up.partNumber, etag: up.etag });
}

async function uploadComplete(c, [, vid]) {
  const v = await uploadingRow(c, vid);
  const b = await readJson(c.req);
  const total = partsFor(v.size);
  const parts = Array.isArray(b.parts) ? b.parts.map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag || '') })) : [];
  parts.sort((a, b2) => a.partNumber - b2.partNumber);
  if (parts.length !== total || parts.some((p, i) => p.partNumber !== i + 1 || !p.etag)) return fail(400, 'Eksik parça var, yüklemeyi yeniden başlatın.');
  const sha = String(b.sha256 || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha)) return fail(400, 'SHA-256 parmak izi geçersiz.');
  const mp = c.env.FILES.resumeMultipartUpload(v.r2_key, v.upload_id);
  await mp.complete(parts);
  const head = await c.env.FILES.head(v.r2_key);
  if (!head || head.size !== v.size) {
    await c.env.FILES.delete(v.r2_key);
    await run(c.env, 'DELETE FROM versions WHERE id = ?', v.id);
    return fail(400, 'Yüklenen dosya boyutu tutmadı, lütfen tekrar deneyin.');
  }
  await run(c.env, "UPDATE versions SET status = 'ready', sha256 = ?, upload_id = NULL, created_at = ? WHERE id = ?", sha, c.t, v.id);
  await audit(c, 'Yükleme', `${v.program} ${v.version} yüklendi · ${fmtSize(v.size)} · SHA-256 ${sha.slice(0, 8)}…${sha.slice(-8)}`);
  return json({ ok: true });
}

async function uploadAbort(c, [, vid]) {
  const v = await uploadingRow(c, vid);
  try { await c.env.FILES.resumeMultipartUpload(v.r2_key, v.upload_id).abort(); } catch {}
  await run(c.env, 'DELETE FROM versions WHERE id = ?', v.id);
  return json({ ok: true });
}

// ---------- İndirme bağlantıları ----------
async function listLinks(c) {
  const rows = await all(c.env,
    'SELECT l.id, l.customer, l.expires_at, l.max_downloads, l.downloads, l.revoked, l.created_at, v.version, p.name AS program FROM links l JOIN versions v ON v.id = l.version_id JOIN programs p ON p.id = v.program_id ORDER BY l.created_at DESC, l.id DESC LIMIT 50');
  return json({
    links: rows.map((l) => {
      const status = l.revoked ? 'revoked' : l.expires_at <= c.t ? 'expired' : l.downloads >= l.max_downloads ? 'used' : 'active';
      return { ...l, status, expiresIn: l.expires_at - c.t, expires: fmtTR(l.expires_at), created: fmtTR(l.created_at) };
    }),
  });
}

async function createLink(c) {
  const b = await readJson(c.req);
  const v = await first(c.env, "SELECT v.*, p.name AS program FROM versions v JOIN programs p ON p.id = v.program_id WHERE v.id = ? AND v.status = 'ready'", Number(b.versionId));
  if (!v) return fail(400, 'Sürüm seçin.');
  const customer = String(b.customer || '').trim().replace(/\s+/g, ' ');
  if (customer.length < 2 || customer.length > 100) return fail(400, 'Müşteri / firma adı 2–100 karakter olmalı.');
  const hours = Number(b.hours);
  if (![24, 72, 168].includes(hours)) return fail(400, 'Geçerlilik süresi geçersiz.');
  const max = Number(b.maxDownloads);
  if (![1, 3, 5].includes(max)) return fail(400, 'İndirme hakkı geçersiz.');
  const token = randomToken(32);
  const expires = c.t + hours * 3600;
  await run(c.env, 'INSERT INTO links (token_hash, version_id, customer, expires_at, max_downloads, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    await sha256hex(token), v.id, customer, expires, max, c.t);
  await audit(c, 'Link', `${customer} için ${v.program} ${v.version} · ${hours} saat · ${max} indirme hakkı`);
  return json({ url: `${c.url.origin}/indir/${token}`, expires: fmtTR(expires), program: v.program, version: v.version, customer });
}

async function revokeLink(c, [, id]) {
  const l = await first(c.env, 'SELECT l.id, l.customer, v.version, p.name AS program FROM links l JOIN versions v ON v.id = l.version_id JOIN programs p ON p.id = v.program_id WHERE l.id = ?', Number(id));
  if (!l) return fail(404, 'Bağlantı bulunamadı.');
  await run(c.env, 'UPDATE links SET revoked = 1 WHERE id = ?', l.id);
  await audit(c, 'Link', `${l.customer} · ${l.program} ${l.version} bağlantısı iptal edildi`);
  return json({ ok: true });
}

// ---------- Güvenlik ----------
async function security(c) {
  const env = c.env;
  const admin = await getAdmin(env);
  const sessions = await all(env, 'SELECT id_hash, created_at, last_seen, location, ip, ua FROM sessions WHERE revoked = 0 AND expires_at > ? AND last_seen > ? ORDER BY last_seen DESC',
    c.t, c.t - CFG.SESSION_IDLE);
  const backup = await first(env, 'SELECT COUNT(*) AS total, SUM(CASE WHEN used_at IS NULL THEN 1 ELSE 0 END) AS left FROM backup_codes');
  const trusted = await first(env, 'SELECT COUNT(*) AS n FROM trusted_devices WHERE expires_at > ?', c.t);
  const acc = await accessConfig(env);
  const accessOn = Boolean(acc && acc.state === 'active' && c.accessOk === true);
  const layers = [
    { key: 'access', title: 'Cloudflare Access kapısı', ok: accessOn,
      detail: accessOn ? `Panel adresine yalnızca ${acc.email || 'onaylı e-posta'} adresine gelen tek kullanımlık kodla ulaşılır.`
        : acc && acc.state === 'pending' ? 'Kuruldu: panel adresini yeniden açıp e-postanıza gelen kodla girin; ilk girişten sonra sunucu tarafı denetim de kalıcı olarak açılır.'
        : 'Henüz açılmadı. Aşağıdaki “Cloudflare ile tamamla” düğmesiyle kurulabilir; açılana kadar panel şifre + kod ile korunur.' },
    { key: 'password', title: 'Güçlü şifre saklama', ok: String(admin.pass_hash).startsWith('pbkdf2-sha256$'), detail: 'Şifre geri çevrilemez PBKDF2 özeti olarak tutulur, düz metin asla.' },
    { key: 'totp', title: 'İki adımlı doğrulama', ok: Boolean(admin.totp_enc), detail: 'Her girişte doğrulama uygulamasından 6 haneli kod; anahtar veritabanında AES-256 ile şifreli.' },
    { key: 'ratelimit', title: 'Deneme sınırı ve kilit', ok: true, detail: `Aynı IP'den ${CFG.IP_MAX} hatada 15 dk kilit; toplamda ${CFG.ACCT_MAX} hatada hesap kilidi.` },
    { key: 'cookie', title: 'Güvenli oturum çerezi', ok: c.url.protocol === 'https:' || c.url.hostname === 'localhost', detail: 'HttpOnly, Secure, SameSite=Strict; 30 dk hareketsizlikte, en geç 8 saatte biter.' },
    { key: 'storage', title: 'Özel dosya deposu', ok: Boolean(env.FILES), detail: env.FILES ? 'Dosyalar herkese kapalı R2 deposunda; yalnızca süreli, sayılı indirme linkiyle iner.' : 'R2 dosya deposu henüz etkin değil; program yükleme kapalı. Cloudflare panelinde R2 hizmetini bir kez etkinleştirin.' },
    { key: 'keys', title: 'Anahtar saklama', ok: env.KEY_SOURCE === 'secret', detail: env.KEY_SOURCE === 'secret' ? 'Şifreleme ve lisans imza anahtarları Cloudflare gizli değişkenlerinde (veritabanından ayrı).' : 'Anahtarlar otomatik üretildi ve veritabanında saklanıyor. Çalışır; daha güçlü koruma için Cloudflare gizli değişkenine taşınabilir.' },
  ];
  return json({
    layers,
    allOk: layers.every((l) => l.ok),
    checkedAt: fmtTR(c.t),
    sessions: sessions.map((s) => ({
      current: s.id_hash === c.session.id_hash, ua: s.ua, location: s.location, ip: s.ip,
      created: fmtTR(s.created_at), lastSeenAgo: c.t - s.last_seen,
    })),
    password: { changed: fmtTR(admin.pass_changed_at), daysAgo: Math.floor((c.t - admin.pass_changed_at) / 86400) },
    backup: { total: backup.total || 0, left: backup.left || 0 },
    trustedDevices: trusted.n,
    email: admin.email,
    publicKey: await signingPublicKey(env).catch(() => ''),
    cloudflare: { keysInSecret: env.KEY_SOURCE === 'secret', access: acc ? acc.state : 'off' },
  });
}

async function revokeOthers(c) {
  const r = await run(c.env, 'UPDATE sessions SET revoked = 1 WHERE id_hash != ? AND revoked = 0', c.session.id_hash);
  await audit(c, 'Güvenlik', `Diğer oturumlar kapatıldı (${changes(r)})`);
  return json({ ok: true, closed: changes(r) });
}

async function clearTrusted(c) {
  const r = await run(c.env, 'DELETE FROM trusted_devices');
  await audit(c, 'Güvenlik', `Güvenilir cihazlar sıfırlandı (${changes(r)})`);
  return json({ ok: true }, 200, { 'set-cookie': setCookie(TRUST, '', 0) });
}

// Oturum içindeki hassas işlemler: denemeyi önce say (paralel denemelere karşı), hata olursa kilit + oturumu kapat
async function sensitiveGuard(c) {
  const lu = await chargeAll(c);
  if (!lu) return null;
  await run(c.env, 'UPDATE sessions SET revoked = 1 WHERE id_hash = ?', c.session.id_hash);
  return lockedResp(lu, c.t);
}
async function sensitiveFail(c, msg) {
  const l = await registerFail(c);
  await audit(c, 'Başarısız doğrulama', msg);
  if (l) {
    await run(c.env, 'UPDATE sessions SET revoked = 1 WHERE id_hash = ?', c.session.id_hash);
    await audit(c, 'Engellendi', 'Hassas işlemde çok fazla hata · oturum kapatıldı');
    return lockedResp(l, c.t);
  }
  return fail(401, msg + '.');
}

async function changePassword(c) {
  const guard = await sensitiveGuard(c);
  if (guard) return guard;
  const b = await readJson(c.req);
  const admin = await getAdmin(c.env);
  if (!(await verifyPassword(String(b.current || ''), admin.pass_hash))) return sensitiveFail(c, 'Mevcut şifre hatalı');
  if (!(await checkTotp(c, admin, b.code))) return sensitiveFail(c, 'Doğrulama kodu hatalı');
  const problem = passwordProblem(b.next);
  if (problem) return fail(400, problem);
  if (b.next === b.current) return fail(400, 'Yeni şifre eskisiyle aynı olamaz.');
  const iter = Number(String(admin.pass_hash).split('$')[1]) || undefined; // kurulumda seçilen tur sayısı korunur
  await run(c.env, 'UPDATE admin SET pass_hash = ?, pass_changed_at = ?, updated_at = ? WHERE id = 1', await hashPassword(b.next, undefined, iter), c.t, c.t);
  await run(c.env, 'UPDATE sessions SET revoked = 1 WHERE id_hash != ?', c.session.id_hash);
  await run(c.env, 'DELETE FROM trusted_devices');
  await clearFails(c);
  await audit(c, 'Güvenlik', 'Şifre değiştirildi · diğer oturumlar ve güvenilir cihazlar kapatıldı');
  return json({ ok: true });
}

async function totpBegin(c) {
  const guard = await sensitiveGuard(c);
  if (guard) return guard;
  const b = await readJson(c.req);
  const admin = await getAdmin(c.env);
  if (!(await verifyPassword(String(b.password || ''), admin.pass_hash))) return sensitiveFail(c, 'Şifre hatalı');
  // Şifre tek başına yetmez: mevcut doğrulama kodu veya bir yedek kod da gerekir
  const code = String(b.code || '').trim();
  const second = /^\d{6}$/.test(code.replace(/\s/g, '')) ? await checkTotp(c, admin, code) : normalizeBackupCode(code).length === 8 ? await useBackupCode(c, code) : false;
  if (!second) return sensitiveFail(c, 'Mevcut doğrulama kodu veya yedek kod hatalı');
  const secret = base32Encode(randomBytes(20));
  await run(c.env, 'UPDATE admin SET totp_pending_enc = ? WHERE id = 1', await encryptText(c.env.PANEL_ENC_KEY, secret));
  return json({ secret: secret.match(/.{1,4}/g).join(' '), uri: otpauthUri(secret, admin.email) });
}

async function totpConfirm(c) {
  const guard = await sensitiveGuard(c);
  if (guard) return guard;
  const b = await readJson(c.req);
  const admin = await getAdmin(c.env);
  if (!admin.totp_pending_enc) return fail(400, 'Önce kurulumu başlatın.');
  const step = await verifyTotp(await totpSecret(c, admin.totp_pending_enc), b.code, 0, c.t);
  if (step === null) return sensitiveFail(c, 'Yeni uygulamadaki kod hatalı');
  await run(c.env, 'UPDATE admin SET totp_enc = totp_pending_enc, totp_pending_enc = NULL, totp_last_step = ?, updated_at = ? WHERE id = 1', step, c.t);
  await run(c.env, 'UPDATE sessions SET revoked = 1 WHERE id_hash != ?', c.session.id_hash);
  await run(c.env, 'DELETE FROM trusted_devices');
  await audit(c, 'Güvenlik', 'Doğrulama uygulaması yeniden kuruldu · diğer oturumlar kapatıldı');
  return json({ ok: true });
}

async function regenBackup(c) {
  const guard = await sensitiveGuard(c);
  if (guard) return guard;
  const b = await readJson(c.req);
  const admin = await getAdmin(c.env);
  if (!(await checkTotp(c, admin, b.code))) return sensitiveFail(c, 'Doğrulama kodu hatalı');
  const codes = newBackupCodes(10);
  await run(c.env, 'DELETE FROM backup_codes');
  for (const code of codes) {
    await run(c.env, 'INSERT INTO backup_codes (code_hash) VALUES (?)', await sha256hex('bc:' + normalizeBackupCode(code)));
  }
  await audit(c, 'Güvenlik', 'Yedek kodlar yenilendi');
  return json({ codes });
}

async function listAudit(c) {
  const limit = Math.min(500, Math.max(1, Number(c.url.searchParams.get('limit')) || 100));
  const rows = await all(c.env, 'SELECT id, at, type, detail, ip, location FROM audit ORDER BY at DESC, id DESC LIMIT ?', limit);
  return json({ entries: rows.map((r) => ({ ...r, time: fmtTR(r.at) })) });
}

async function auditCsv(c) {
  const rows = await all(c.env, 'SELECT at, type, detail, ip, location, ua FROM audit ORDER BY at DESC, id DESC LIMIT 20000');
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // Excel formül enjeksiyonuna karşı
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const lines = ['Zaman;Olay;Ayrıntı;IP;Konum;Tarayıcı'];
  for (const r of rows) lines.push([fmtTR(r.at), r.type, r.detail, r.ip, r.location, r.ua].map(cell).join(';'));
  await audit(c, 'Dışa aktarım', 'Denetim kaydı Excel (CSV) olarak indirildi');
  return new Response('﻿' + lines.join('\r\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="denetim-kaydi-${fmtTR(c.t).slice(0, 10).split('.').reverse().join('-')}.csv"`,
    },
  });
}

// ---------- Web üzerinden ilk kurulum ----------
// Yönetici hesabı yokken, yalnızca site sahibine verilen tek kullanımlık kurulum koduyla açılır.
// Kodun kendisi değil SHA-256 özeti yapılandırmadadır (SETUP_CODE_HASH). Hesap oluşunca kurulum kalıcı olarak kapanır.
const SETUP_ITER = 10000; // Workers ücretsiz planın CPU sınırına uygun; giriş ayrıca iki adımlı kodla korunur
const normSetupCode = (s) => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
export const setupCodeHash = (code) => sha256hex('od-setup:' + normSetupCode(code));

async function setupGuard(c) {
  const r = await chargeAttempt(c.env, 'setup:' + c.cl.ip, c.t, CFG.IP_MAX, CFG.FAIL_WINDOW, CFG.LOCK_SECS);
  return r && r.locked_until > c.t ? lockedResp(r.locked_until, c.t) : null;
}

async function setupStatus(c) {
  return json({ needsSetup: !(await getAdmin(c.env)), setupEnabled: Boolean(c.env.SETUP_CODE_HASH) });
}

async function setupStart(c) {
  if (await getAdmin(c.env)) return fail(409, 'Kurulum zaten tamamlanmış. Giriş ekranını kullanın.');
  if (!c.env.SETUP_CODE_HASH) return fail(503, 'Kurulum kodu tanımlı değil.');
  const guard = await setupGuard(c);
  if (guard) return guard;
  const b = await readJson(c.req);
  if (!timingSafeEqual(await setupCodeHash(b.setupCode), String(c.env.SETUP_CODE_HASH).toLowerCase())) {
    await audit(c, 'Başarısız giriş', 'Hatalı ilk kurulum kodu');
    return fail(401, 'Kurulum kodu hatalı.');
  }
  const email = String(b.email || '').trim().toLowerCase().slice(0, 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, 'Geçerli bir e-posta adresi girin.');
  const problem = passwordProblem(b.password);
  if (problem) return fail(400, problem);
  const secret = base32Encode(randomBytes(20));
  const token = randomToken(32);
  await run(c.env, 'DELETE FROM setup_pending WHERE expires_at < ?', c.t);
  await run(c.env, 'INSERT INTO setup_pending (token_hash, email, pass_hash, totp_enc, expires_at) VALUES (?, ?, ?, ?, ?)',
    await sha256hex(token), email, await hashPassword(String(b.password), undefined, SETUP_ITER), await encryptText(c.env.PANEL_ENC_KEY, secret), c.t + 15 * 60);
  return json({ token, secret: secret.match(/.{1,4}/g).join(' '), uri: otpauthUri(secret, email) });
}

async function setupFinish(c) {
  if (await getAdmin(c.env)) return fail(409, 'Kurulum zaten tamamlanmış. Giriş ekranını kullanın.');
  const guard = await setupGuard(c);
  if (guard) return guard;
  const b = await readJson(c.req);
  const tok = String(b.token || '');
  if (!TOKEN_RE.test(tok)) return fail(400, 'Geçersiz kurulum isteği.');
  const p = await first(c.env, 'SELECT * FROM setup_pending WHERE token_hash = ? AND expires_at > ?', await sha256hex(tok), c.t);
  if (!p) return fail(401, 'Kurulum süresi doldu. Lütfen baştan başlayın.', { restart: true });
  const step = await verifyTotp(base32Decode(await decryptText(c.env.PANEL_ENC_KEY, p.totp_enc)), b.code, 0, c.t);
  if (step === null) return fail(401, 'Kod tutmadı. Telefondaki güncel 6 haneli kodu girin (telefon saati otomatik olmalı).');
  const ins = await run(c.env, 'INSERT OR IGNORE INTO admin (id, email, pass_hash, pass_changed_at, totp_enc, totp_last_step, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)',
    p.email, p.pass_hash, c.t, p.totp_enc, step, c.t);
  if (changes(ins) !== 1) return fail(409, 'Kurulum zaten tamamlanmış. Giriş ekranını kullanın.');
  const codes = newBackupCodes(10);
  await run(c.env, 'DELETE FROM backup_codes');
  for (const code of codes) await run(c.env, 'INSERT INTO backup_codes (code_hash) VALUES (?)', await sha256hex('bc:' + normalizeBackupCode(code)));
  await run(c.env, 'DELETE FROM setup_pending');
  await run(c.env, 'DELETE FROM login_attempts WHERE key = ?', 'setup:' + c.cl.ip);
  await audit(c, 'Kurulum', `Yönetici hesabı web üzerinden oluşturuldu (${p.email})`);
  return json({ ok: true, codes }, 200, { 'set-cookie': await createSession(c) });
}

// ---------- Bordro parametreleri (yayın iki adımlı kod ister) ----------
async function payrollPublish(c) {
  const guard = await sensitiveGuard(c);
  if (guard) return guard;
  const b = await readJson(c.req);
  if (!(await checkTotp(c, await getAdmin(c.env), b.code))) return sensitiveFail(c, 'Doğrulama kodu hatalı');
  await clearFails(c); // başarılı kod: ön sayım geri alınır (art arda yayınlar kilide yol açmasın)
  return publishPayroll(c, b.base, b.note);
}
async function payrollRestore(c, [, id]) {
  const guard = await sensitiveGuard(c);
  if (guard) return guard;
  const b = await readJson(c.req);
  if (!(await checkTotp(c, await getAdmin(c.env), b.code))) return sensitiveFail(c, 'Doğrulama kodu hatalı');
  await clearFails(c);
  return restorePayroll(c, id);
}
async function watchRun(c) {
  const r = await runWatch(c.env);
  await audit(c, 'Bordro', `Resmi kaynaklar elle tarandı · ${r.checked.length} kaynak okundu${r.failed.length ? ', okunamayan: ' + r.failed.join(', ') : ''} · ${r.found} yeni başlık`);
  return json(r);
}

// Müşterilerin bilgisayarına gidecek güncelleme: oturum yetmez, iki adımlı kod gerekir
async function releasePublish(c, m) {
  const guard = await sensitiveGuard(c);
  if (guard) return guard;
  const b = await c.req.clone().json().catch(() => ({}));
  if (!(await checkTotp(c, await getAdmin(c.env), b.code))) return sensitiveFail(c, 'Doğrulama kodu hatalı');
  await clearFails(c);
  return publishRelease(c, m);
}

// ---------- Lisans yenileme takibi ----------
async function renewals(c) {
  const t = c.t;
  const rows = await all(c.env,
    `SELECT l.id, l.customer, l.email, l.phone, l.ends_at, l.status, p.name AS program
     FROM licenses l JOIN programs p ON p.id = l.program_id
     WHERE l.status != 'revoked' AND l.ends_at BETWEEN ? AND ? ORDER BY l.ends_at`,
    t - 30 * 86400, t + 60 * 86400);
  const list = rows.map((l) => ({
    id: l.id, customer: l.customer, program: l.program, email: l.email, phone: l.phone,
    ends: dateTR(l.ends_at), endsIso: isoDateTR(l.ends_at), daysLeft: Math.ceil((l.ends_at - t) / 86400),
    suspended: l.status === 'suspended',
  }));
  const year = await all(c.env, "SELECT ends_at FROM licenses WHERE status != 'revoked' AND ends_at BETWEEN ? AND ?", t, t + 365 * 86400);
  const months = {};
  for (const r of year) { const k = isoDateTR(r.ends_at).slice(0, 7); months[k] = (months[k] || 0) + 1; }
  return json({
    list,
    counts: {
      expired: list.filter((l) => l.daysLeft <= 0).length,
      in30: list.filter((l) => l.daysLeft > 0 && l.daysLeft <= 30).length,
      in60: list.filter((l) => l.daysLeft > 30).length,
    },
    months: Object.entries(months).sort().map(([month, n]) => ({ month, n })),
    expiringDays: LIC.EXPIRING / 86400,
  });
}

// ---------- Cloudflare ile güvenlik kurulumu ----------
async function cloudflareSetupRoute(c) {
  const guard = await sensitiveGuard(c);
  if (guard) return guard;
  const b = await readJson(c.req);
  const admin = await getAdmin(c.env);
  if (!(await checkTotp(c, admin, b.code))) return sensitiveFail(c, 'Doğrulama kodu hatalı');
  await clearFails(c);
  if (!b.keys && !b.access) return fail(400, 'En az bir adım seçin.');
  try {
    const r = await cloudflareSetup(c.env, { token: b.token, keys: Boolean(b.keys), access: Boolean(b.access), email: admin.email });
    await audit(c, 'Güvenlik', `Cloudflare kurulumu: ${r.done.map((d) => (d === 'keys' ? 'anahtarlar gizli değişkene taşındı' : 'Access kapısı kuruldu')).join(', ') || 'değişiklik yok'}${r.error ? ' · Access kurulamadı: ' + r.error : ''}`);
    return json({ ok: true, ...r });
  } catch (e) {
    if (e instanceof CfError) {
      await audit(c, 'Uyarı', `Cloudflare kurulumu tamamlanamadı: ${e.message}`);
      return fail(400, e.message);
    }
    throw e;
  }
}

// ---------- Yönlendirme ----------
const ROUTES = [
  ['POST', /^\/logout$/, logout],
  ['GET', /^\/me$/, me],
  ['GET', /^\/overview$/, overview],
  ['POST', /^\/programs$/, createProgram],
  ['GET', /^\/programs\/(\d+)\/versions$/, listVersions],
  ['DELETE', /^\/versions\/(\d+)$/, deleteVersion],
  ['POST', /^\/uploads$/, uploadStart],
  ['PUT', /^\/uploads\/(\d+)\/parts\/(\d+)$/, uploadPart],
  ['POST', /^\/uploads\/(\d+)\/complete$/, uploadComplete],
  ['POST', /^\/uploads\/(\d+)\/abort$/, uploadAbort],
  ['GET', /^\/links$/, listLinks],
  ['POST', /^\/links$/, createLink],
  ['POST', /^\/links\/(\d+)\/revoke$/, revokeLink],
  ['GET', /^\/security$/, security],
  ['POST', /^\/sessions\/revoke-others$/, revokeOthers],
  ['POST', /^\/trusted\/clear$/, clearTrusted],
  ['POST', /^\/password$/, changePassword],
  ['POST', /^\/totp\/begin$/, totpBegin],
  ['POST', /^\/totp\/confirm$/, totpConfirm],
  ['POST', /^\/backup-codes$/, regenBackup],
  ['GET', /^\/audit$/, listAudit],
  ['GET', /^\/audit\.csv$/, auditCsv],
  ['GET', /^\/license-products$/, licenseProducts],
  ['GET', /^\/licenses$/, listLicenses],
  ['POST', /^\/licenses$/, createLicense],
  ['GET', /^\/licenses\/(\d+)$/, getLicense],
  ['POST', /^\/licenses\/(\d+)\/update$/, updateLicense],
  ['POST', /^\/licenses\/(\d+)\/extend$/, extendLicense],
  ['POST', /^\/licenses\/(\d+)\/suspend$/, suspendLicense],
  ['POST', /^\/licenses\/(\d+)\/resume$/, resumeLicense],
  ['POST', /^\/licenses\/(\d+)\/revoke$/, revokeLicense],
  ['POST', /^\/licenses\/(\d+)\/devices\/(\d+)\/remove$/, removeDevice],
  ['POST', /^\/licenses\/(\d+)\/offline$/, offlineActivate],
  ['POST', /^\/versions\/(\d+)\/release$/, releasePublish],
  ['DELETE', /^\/versions\/(\d+)\/release$/, unpublishRelease],
  ['GET', /^\/payroll$/, getPayroll],
  ['POST', /^\/payroll\/preview$/, previewPayroll],
  ['POST', /^\/payroll$/, payrollPublish],
  ['POST', /^\/payroll\/(\d+)\/restore$/, payrollRestore],
  ['POST', /^\/alerts\/(\d+)\/dismiss$/, dismissAlert],
  ['POST', /^\/watch\/run$/, watchRun],
  ['GET', /^\/renewals$/, renewals],
  ['POST', /^\/security\/cloudflare$/, cloudflareSetupRoute],
];

async function api(c) {
  const { req, url, env } = c;
  const method = req.method;
  const path = url.pathname.slice('/panel/api'.length);
  if (method !== 'GET' && method !== 'HEAD') {
    // CSRF: özel başlık zorunlu + kaynak (Origin) aynı site olmalı
    if (req.headers.get('x-od-panel') !== '1') return fail(403, 'Geçersiz istek.');
    const origin = req.headers.get('origin');
    if (origin && origin !== url.origin) return fail(403, 'Geçersiz kaynak.');
  }
  if (!env.DB) return fail(503, 'Panel kurulumu tamamlanmadı (veritabanı bağlı değil).');
  if (path === '/setup/status' && method === 'GET') return setupStatus(c);
  if (path === '/setup/start' && method === 'POST') return setupStart(c);
  if (path === '/setup/finish' && method === 'POST') return setupFinish(c);
  if (path === '/login' && method === 'POST') return login(c);
  if (path === '/verify' && method === 'POST') return verify(c);
  if (!(await getAdmin(env))) return fail(503, 'Yönetici hesabı henüz oluşturulmadı.');
  const session = await getSession(c);
  if (!session) return fail(401, 'Oturum sona erdi. Lütfen yeniden giriş yapın.', { restart: true });
  c.session = session;
  if (!env.FILES && (/^\/uploads/.test(path) || /^\/versions\//.test(path))) {
    return fail(503, 'Dosya deposu (R2) henüz etkin değil. Cloudflare panelinde R2 hizmetini bir kez etkinleştirin.');
  }
  for (const [m, re, fn] of ROUTES) {
    const match = path.match(re);
    if (match && m === method) return fn(c, match);
  }
  return fail(404, 'Bulunamadı.');
}

// ---------- Müşteri indirme sayfası ----------
function dlPage(status, title, bodyHtml) {
  const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)} | Özkan Demir</title><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/indir.css"></head><body><header class="dl-head"><a class="dl-brand" href="https://ozkandemir.net/"><span>ÖD</span><b>ÖZKAN DEMİR<small>SERBEST MUHASEBECİ MALİ MÜŞAVİR</small></b></a></header><main class="dl-main"><section class="dl-card">${bodyHtml}</section><p class="dl-foot">Bu bağlantı size özel oluşturulmuştur, lütfen paylaşmayın. Sorun yaşarsanız: <a href="https://wa.me/905516007787">WhatsApp 0551 600 77 87</a></p></main></body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

const invalidPage = (status = 410) => dlPage(status, 'Bağlantı geçersiz',
  '<span class="dl-kicker">İNDİRME BAĞLANTISI</span><h1>Bu bağlantı artık geçerli değil</h1><p>Bağlantının süresi dolmuş, indirme hakkı kullanılmış ya da iptal edilmiş olabilir. Yeni bağlantı için Özkan Demir ile iletişime geçin.</p>');

async function handleDownload(req, env, url, cl) {
  const m = url.pathname.match(/^\/indir\/([A-Za-z0-9_-]{43})\/?$/);
  if (!m) return invalidPage(404);
  if (!env.DB || !env.FILES) return dlPage(503, 'Hizmet hazır değil', '<h1>Hizmet geçici olarak kullanılamıyor</h1><p>Lütfen daha sonra tekrar deneyin.</p>');
  const t = now();
  const row = await first(env,
    "SELECT l.*, v.filename, v.size, v.sha256, v.version, v.r2_key, p.name AS program FROM links l JOIN versions v ON v.id = l.version_id JOIN programs p ON p.id = v.program_id WHERE l.token_hash = ? AND v.status = 'ready'",
    await sha256hex(m[1]));
  const valid = row && !row.revoked && row.expires_at > t && row.downloads < row.max_downloads;

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (!valid) return invalidPage(row ? 410 : 404);
    const left = row.max_downloads - row.downloads;
    return dlPage(200, `${row.program} indir`, `<span class="dl-kicker">PROGRAM İNDİRME</span><h1>${esc(row.program)}</h1><p class="dl-sub">${esc(row.customer)} için hazırlandı</p><dl class="dl-meta"><div><dt>Sürüm</dt><dd>${esc(row.version)}</dd></div><div><dt>Dosya</dt><dd>${esc(row.filename)}</dd></div><div><dt>Boyut</dt><dd>${esc(fmtSize(row.size))}</dd></div><div><dt>Son geçerlilik</dt><dd>${esc(fmtTR(row.expires_at))}</dd></div><div><dt>Kalan indirme hakkı</dt><dd>${left}</dd></div></dl><form method="post" action="/indir/${m[1]}"><button type="submit" class="dl-btn">Dosyayı indir</button></form><details class="dl-hash"><summary>Dosya doğrulama (SHA-256)</summary><code>${esc(row.sha256 || '')}</code><small>İndirdiğiniz dosyanın bozulmadığını bu parmak iziyle kontrol edebilirsiniz.</small></details>`);
  }

  if (req.method === 'POST') {
    if (!row) return invalidPage(404);
    const u = await run(env, 'UPDATE links SET downloads = downloads + 1 WHERE id = ? AND revoked = 0 AND expires_at > ? AND downloads < max_downloads', row.id, t);
    if (changes(u) !== 1) return invalidPage(410);
    const obj = await env.FILES.get(row.r2_key);
    if (!obj) {
      await run(env, 'UPDATE links SET downloads = downloads - 1 WHERE id = ?', row.id);
      return dlPage(404, 'Dosya bulunamadı', '<h1>Dosya bulunamadı</h1><p>Lütfen Özkan Demir ile iletişime geçin.</p>');
    }
    await audit({ env, cl }, 'İndirme', `${row.customer} · ${row.program} ${row.version} (${row.downloads + 1}/${row.max_downloads})`);
    return new Response(obj.body, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(obj.size),
        'content-disposition': contentDisposition(row.filename),
      },
    });
  }
  return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, POST' } });
}

// ---------- Giriş noktası ----------
export function isPanelPath(pathname) {
  return pathname === '/panel' || pathname.startsWith('/panel/') || pathname.startsWith('/indir/') || pathname.startsWith('/lisans/api/') || isPayrollPublicPath(pathname);
}

// Cloudflare zamanlanmış görevi (günde bir): resmi kaynak takibi
export async function scheduledTasks(env) {
  if (!env.DB) return;
  env = await prepareEnv(env);
  const r = await runWatch(env);
  if (r.found) await audit({ env, cl: { ip: null, location: 'Zamanlanmış görev', ua: null } }, 'Bordro', `Resmi kaynaklarda ${r.found} yeni başlık bulundu; Bordro Parametreleri ekranında inceleyin`);
}

export async function handlePanel(request, env) {
  const url = new URL(request.url);
  const cl = clientInfo(request);
  try {
    // Panel ekranları dışındaki her şey veritabanı ister: tablolar ve anahtarlar burada (gerekirse) otomatik kurulur
    const staticPage = url.pathname === '/panel' || (url.pathname.startsWith('/panel/') && !url.pathname.startsWith('/panel/api/'));
    // Bordro parametre dosyaları: yayın varsa veritabanından, yoksa statik dosya (hata olursa da statik)
    if (isPayrollPublicPath(url.pathname)) {
      try { env = await prepareEnv(env); } catch (e) { return env.ASSETS.fetch(request); }
      return servePayrollPublic(request, env, url);
    }
    if (!staticPage) env = await prepareEnv(env);
    if (url.pathname.startsWith('/indir/')) return secure(await handleDownload(request, env, url, cl), CSP_DL);
    // Müşteri programlarının lisans API'si (Access dışında, kendi deneme sınırıyla)
    if (url.pathname.startsWith('/lisans/api/update-')) {
      return secure(await handleUpdateApi(request, env, url, cl), CSP_PANEL);
    }
    if (url.pathname.startsWith('/lisans/api/')) return secure(await handleLicenseApi(request, env, url, cl), CSP_PANEL);

    // 1. kat: Cloudflare Access (yapılandırıldıysa zorunlu)
    // Kurulumdan sonra ilk geçerli Access girişi kapıyı kalıcı olarak etkinleştirir (yanlış kurulumda kilitlenmeyi önler)
    let accessOk = null;
    const acc = await accessConfig(env);
    if (acc && acc.team && acc.aud) {
      accessOk = Boolean(await verifyAccessJwt(request.headers.get('cf-access-jwt-assertion'), acc.team, acc.aud));
      if (acc.state === 'active' && !accessOk) return secure(fail(403, 'Erişim reddedildi.'), CSP_PANEL);
      if (acc.state === 'pending' && accessOk && env.DB) await markAccessActive(env, acc);
    }

    if (url.pathname.startsWith('/panel/api/')) {
      const c = { req: request, env, url, cl, t: now(), cookies: parseCookies(request.headers.get('cookie')), accessOk };
      return secure(await api(c), CSP_PANEL);
    }
    return secure(await env.ASSETS.fetch(request), CSP_PANEL);
  } catch (e) {
    if (e instanceof HttpError) return secure(fail(e.status, e.message), CSP_PANEL);
    console.error('panel', e && e.stack ? e.stack : e);
    return secure(fail(500, 'Beklenmeyen bir hata oluştu.'), CSP_PANEL);
  }
}
