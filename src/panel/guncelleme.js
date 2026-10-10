// ozkandemir.net V3.8 — Program güncellemelerinin müşterilere dağıtımı
// Müşteri programı:  POST /lisans/api/update-check   → imzalı güncelleme bildirimi (manifest)
//                    GET  /lisans/api/update-download?t=… → imzalı, 1 saat geçerli indirme
// Yönetim paneli:    /panel/api/versions/:id/release (yayınla / yayından kaldır)
// Güncellemeyi müşteri tarafında yönetici onaylar; program dosyanın SHA-256 parmak izini ve imzayı doğrular.
import { now } from './security.js';
import { json, fail, first, all, run, readJson, fmtTR, fmtSize, contentDisposition, audit } from './common.js';
import {
  BY_PREFIX, keyHash, licState, cleanBody, licLocked, licFail, event, signPayload, verifyToken, signingPublicKey,
} from './license.js';

export const UPD = {
  MANIFEST_TTL: 3600,   // bildirim ve indirme izni 1 saat geçerli
};

// "v2.10.1" > "v2.9.7" — sayısal karşılaştırma; sayı olmayan son ekler (beta, rc) önceliği düşürür
export function compareVersions(a, b) {
  const pa = String(a || '').match(/\d+/g) || [];
  const pb = String(b || '').match(/\d+/g) || [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number(pa[i] || 0), y = Number(pb[i] || 0);
    if (x !== y) return x > y ? 1 : -1;
  }
  const preA = /[-_.]?(alpha|beta|rc|test)/i.test(String(a)), preB = /[-_.]?(alpha|beta|rc|test)/i.test(String(b));
  return preA === preB ? 0 : preA ? -1 : 1;
}

async function latestRelease(env, programId) {
  const rows = await all(env,
    "SELECT r.version_id, r.mandatory, r.public_notes, r.published_at, v.version, v.filename, v.size, v.sha256, v.r2_key, v.notes FROM releases r JOIN versions v ON v.id = r.version_id WHERE r.program_id = ? AND v.status = 'ready'",
    programId);
  rows.sort((x, y) => compareVersions(y.version, x.version) || y.published_at - x.published_at);
  return rows[0] || null;
}

// ---------- Müşteri programı ----------
export async function updateCheck(request, env, cl) {
  const t = now();
  const lu = await licLocked(env, cl.ip, t);
  if (lu) return json({ ok: false, code: 'rate_limited', message: `Çok fazla hatalı deneme. ${Math.ceil((lu - t) / 60)} dakika sonra tekrar deneyin.` }, 429);
  const body = cleanBody(await readJson(request));
  if (!body.key) { await licFail(env, cl.ip, t); return json({ ok: false, code: 'invalid_key', message: 'Lisans anahtarı geçersiz.' }, 404); }
  const lic = await first(env, 'SELECT * FROM licenses WHERE key_hash = ?', await keyHash(body.key));
  if (!lic) { await licFail(env, cl.ip, t); return json({ ok: false, code: 'invalid_key', message: 'Lisans anahtarı geçersiz.' }, 404); }
  const prefix = body.key.slice(0, 4);
  if (body.product && body.product !== prefix) return json({ ok: false, code: 'wrong_product', message: 'Bu anahtar başka bir programa ait.' }, 400);
  const state = licState(lic, t);
  if (state !== 'active') return json({ ok: false, code: state, message: 'Güncelleme için lisansın etkin olması gerekir.' }, 403);
  const act = await first(env, 'SELECT * FROM activations WHERE license_id = ? AND device_id = ? AND removed_at IS NULL', lic.id, body.deviceId);
  if (!act) return json({ ok: false, code: 'device_removed', message: 'Bu cihaz lisansa kayıtlı değil. Önce lisansı etkinleştirin.' }, 403);
  if (body.version && body.version !== act.app_version) {
    await run(env, 'UPDATE activations SET app_version = ? WHERE id = ?', body.version, act.id);
  }

  const rel = await latestRelease(env, lic.program_id);
  if (!rel || compareVersions(rel.version, body.version) <= 0) {
    return json({ ok: true, update: false, current: body.version, latest: rel ? rel.version : body.version, message: 'Program güncel.' });
  }
  const exp = t + UPD.MANIFEST_TTL;
  const dl = await signPayload(env, { typ: 'od-dl', vid: rel.version_id, lid: lic.id, device: body.deviceId, exp });
  const manifest = await signPayload(env, {
    v: 1,
    typ: 'od-update',
    product: prefix,
    program: BY_PREFIX[prefix].name,
    device: body.deviceId,
    current: body.version,
    version: rel.version,
    filename: rel.filename,
    size: rel.size,
    sha256: rel.sha256,
    mandatory: Boolean(rel.mandatory),
    notes: rel.public_notes || rel.notes || '',
    published: rel.published_at,
    download: `/lisans/api/update-download?t=${encodeURIComponent(dl)}`,
    iat: t,
    exp,
    server: 'ozkandemir.net',
  });
  return json({ ok: true, update: true, current: body.version, latest: rel.version, mandatory: Boolean(rel.mandatory), manifest });
}

export async function updateDownload(request, env, url, cl) {
  const t = now();
  if (!env.FILES) return fail(503, 'Dosya deposu hazır değil.');
  const p = await verifyToken(await signingPublicKey(env), url.searchParams.get('t')).catch(() => null);
  if (!p || p.typ !== 'od-dl' || !(p.exp > t)) return json({ ok: false, code: 'expired', message: 'İndirme izninin süresi doldu. Güncellemeyi yeniden denetleyin.' }, 403);
  const row = await first(env,
    "SELECT v.*, l.status AS lic_status, l.starts_at, l.ends_at, l.customer, p.name AS program FROM releases r JOIN versions v ON v.id = r.version_id JOIN licenses l ON l.id = ? JOIN programs p ON p.id = v.program_id WHERE r.version_id = ? AND v.status = 'ready' AND l.program_id = v.program_id",
    p.lid, p.vid);
  if (!row) return json({ ok: false, code: 'not_found', message: 'Bu güncelleme artık yayında değil.' }, 404);
  if (licState({ status: row.lic_status, starts_at: row.starts_at, ends_at: row.ends_at }, t) !== 'active') {
    return json({ ok: false, code: 'license', message: 'Lisans etkin değil.' }, 403);
  }
  const act = await first(env, 'SELECT id FROM activations WHERE license_id = ? AND device_id = ? AND removed_at IS NULL', p.lid, p.device);
  if (!act) return json({ ok: false, code: 'device_removed', message: 'Bu cihaz lisansa kayıtlı değil.' }, 403);
  const range = request.headers.get('range');
  let obj;
  try {
    obj = await env.FILES.get(row.r2_key, range ? { range: request.headers } : undefined);
  } catch {
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${row.size}` } });
  }
  if (!obj) return fail(404, 'Dosya bulunamadı.');
  const headers = {
    'content-type': 'application/octet-stream',
    'content-disposition': contentDisposition(row.filename),
    'accept-ranges': 'bytes',
    'x-od-sha256': row.sha256 || '',
  };
  if (range && obj.range && (typeof obj.range.offset === 'number' || typeof obj.range.suffix === 'number')) {
    const start = typeof obj.range.suffix === 'number' ? Math.max(0, obj.size - obj.range.suffix) : obj.range.offset;
    const len = typeof obj.range.suffix === 'number' ? obj.size - start : (obj.range.length ?? obj.size - start);
    headers['content-range'] = `bytes ${start}-${start + len - 1}/${obj.size}`;
    headers['content-length'] = String(len);
    return new Response(request.method === 'HEAD' ? null : obj.body, { status: 206, headers });
  }
  headers['content-length'] = String(obj.size);
  if (request.method !== 'HEAD') {
    await event(env, p.lid, 'Güncelleme', `${row.version} güncellemesi indirildi (${fmtSize(row.size)})`, cl);
  }
  return new Response(request.method === 'HEAD' ? null : obj.body, { headers });
}

export async function handleUpdateApi(request, env, url, cl) {
  const path = url.pathname.slice('/lisans/api'.length);
  if (!env.DB) return fail(503, 'Güncelleme hizmeti hazır değil.');
  if (path === '/update-check' && request.method === 'POST') return updateCheck(request, env, cl);
  if (path === '/update-download' && (request.method === 'GET' || request.method === 'HEAD')) return updateDownload(request, env, url, cl);
  return fail(404, 'Bulunamadı.');
}

// ---------- Yönetim paneli ----------
export async function publishRelease(c, [, vid]) {
  const v = await first(c.env, "SELECT v.*, p.name AS program, p.slug FROM versions v JOIN programs p ON p.id = v.program_id WHERE v.id = ? AND v.status = 'ready'", Number(vid));
  if (!v) return fail(404, 'Sürüm bulunamadı.');
  if (!v.sha256) return fail(400, 'Bu sürümün SHA-256 parmak izi yok; dosyayı yeniden yükleyin.');
  const b = await readJson(c.req);
  const notes = String(b.notes ?? '').trim().slice(0, 1000) || null;
  const mandatory = b.mandatory ? 1 : 0;
  const latest = await latestRelease(c.env, v.program_id);
  if (latest && latest.version_id !== v.id && compareVersions(v.version, latest.version) < 0) {
    return fail(400, `Yayında daha yeni bir sürüm var (${latest.version}). Eski sürüm güncelleme olarak sunulamaz.`);
  }
  await run(c.env,
    'INSERT INTO releases (version_id, program_id, mandatory, public_notes, published_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(version_id) DO UPDATE SET mandatory = excluded.mandatory, public_notes = excluded.public_notes',
    v.id, v.program_id, mandatory, notes, c.t);
  await audit(c, 'Güncelleme', `${v.program} ${v.version} müşterilere güncelleme olarak yayınlandı${mandatory ? ' (zorunlu)' : ''}`);
  return json({ ok: true });
}

export async function unpublishRelease(c, [, vid]) {
  const v = await first(c.env, 'SELECT v.id, v.version, p.name AS program FROM versions v JOIN programs p ON p.id = v.program_id WHERE v.id = ?', Number(vid));
  if (!v) return fail(404, 'Sürüm bulunamadı.');
  await run(c.env, 'DELETE FROM releases WHERE version_id = ?', v.id);
  await audit(c, 'Güncelleme', `${v.program} ${v.version} güncelleme yayınından kaldırıldı`);
  return json({ ok: true });
}

// Programlar ekranı için: program başına yayındaki sürüm ve sürüm dağılımı
export async function releaseSummary(env, t) {
  const rels = await all(env, "SELECT r.program_id, r.version_id, r.mandatory, r.published_at, v.version FROM releases r JOIN versions v ON v.id = r.version_id WHERE v.status = 'ready'");
  const byProg = {};
  for (const r of rels) {
    const cur = byProg[r.program_id];
    if (!cur || compareVersions(r.version, cur.version) > 0) byProg[r.program_id] = r;
  }
  const acts = await all(env,
    "SELECT l.program_id, a.app_version FROM activations a JOIN licenses l ON l.id = a.license_id WHERE a.removed_at IS NULL AND l.status = 'active' AND l.ends_at > ?", t);
  const out = {};
  for (const [pid, r] of Object.entries(byProg)) {
    const devices = acts.filter((a) => String(a.program_id) === pid);
    out[pid] = {
      versionId: r.version_id, version: r.version, mandatory: Boolean(r.mandatory), published: fmtTR(r.published_at),
      devices: devices.length,
      upToDate: devices.filter((a) => compareVersions(a.app_version, r.version) >= 0).length,
    };
  }
  return out;
}

