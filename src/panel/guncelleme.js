// ozkandemir.net V3.8 — Program güncellemelerinin müşterilere dağıtımı
// Müşteri programı:  POST /lisans/api/update-check   → imzalı güncelleme bildirimi (manifest)
//                    GET  /lisans/api/update-download?t=… → imzalı, 1 saat geçerli indirme
// Yönetim paneli:    /panel/api/versions/:id/release (yayınla / yayından kaldır)
// Güncellemeyi müşteri tarafında yönetici onaylar; program dosyanın SHA-256 parmak izini ve imzayı doğrular.
import { now } from './security.js';
import { json, fail, first, all, run, readJson, fmtTR, fmtSize, contentDisposition, audit, compareVersions } from './common.js';

export { compareVersions };
import {
  BY_PREFIX, keyHash, licState, cleanBody, licLocked, licFail, event, signPayload, verifyToken, signingPublicKey,
} from './license.js';

export const UPD = {
  MANIFEST_TTL: 3600,   // bildirim ve indirme izni 1 saat geçerli
};


// Programın yayındaki tüm sürümleri, eskiden yeniye (aynı numarada önce yayınlanan önce)
async function releasesFor(env, programId) {
  const rows = await all(env,
    "SELECT r.version_id, r.mandatory, r.public_notes, r.published_at, v.version, v.filename, v.size, v.sha256, v.r2_key, v.notes, v.created_at FROM releases r JOIN versions v ON v.id = r.version_id WHERE r.program_id = ? AND v.status = 'ready'",
    programId);
  return rows.sort((x, y) => compareVersions(x.version, y.version) || x.created_at - y.created_at || x.version_id - y.version_id);
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

  // Güncellemeler sırayla kurulur: programa, kurulu sürümünden SONRAKİ ilk yayındaki sürüm verilir.
  // Kurulunca program yeniden sorar ve bir sonrakini alır; böylece hiçbir ara sürüm atlanmaz.
  const list = await releasesFor(env, lic.program_id);
  const pending = list.filter((x) => compareVersions(x.version, body.version) > 0);
  const latest = list.length ? list[list.length - 1].version : body.version;
  if (!pending.length) {
    return json({ ok: true, update: false, current: body.version, latest, remaining: 0, message: 'Program güncel.' });
  }
  const rel = pending[0];
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
    remaining: pending.length - 1,
    latest,
    published: rel.published_at,
    download: `/lisans/api/update-download?t=${encodeURIComponent(dl)}`,
    iat: t,
    exp,
    server: 'ozkandemir.net',
  });
  return json({ ok: true, update: true, current: body.version, next: rel.version, latest, remaining: pending.length - 1, mandatory: Boolean(rel.mandatory), manifest });
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
  // Eski sürümler de yayınlanabilir: müşteriler kurulu sürümlerinden sonraki sürümü sırayla alır
  await run(c.env,
    'INSERT INTO releases (version_id, program_id, mandatory, public_notes, published_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(version_id) DO UPDATE SET mandatory = excluded.mandatory, public_notes = excluded.public_notes',
    v.id, v.program_id, mandatory, notes, c.t);
  await audit(c, 'Güncelleme', `${v.program} ${v.version} müşterilere güncelleme olarak yayınlandı${mandatory ? ' (zorunlu)' : ''}`);
  return json({ ok: true });
}

// Programın yayında olmayan tüm sürümlerini tek seferde yayınlar (eski sürümler sonradan yüklendiğinde)
export async function publishAllReleases(c, [, pid]) {
  const p = await first(c.env, 'SELECT id, name FROM programs WHERE id = ?', Number(pid));
  if (!p) return fail(404, 'Program bulunamadı.');
  const rows = await all(c.env, "SELECT v.id, v.version FROM versions v LEFT JOIN releases r ON r.version_id = v.id WHERE v.program_id = ? AND v.status = 'ready' AND v.sha256 IS NOT NULL AND r.version_id IS NULL", p.id);
  if (!rows.length) return fail(400, 'Yayınlanmamış sürüm yok.');
  for (const v of rows) {
    await run(c.env, 'INSERT OR IGNORE INTO releases (version_id, program_id, mandatory, public_notes, published_at) VALUES (?, ?, 0, NULL, ?)', v.id, p.id, c.t);
  }
  const names = rows.map((v) => v.version).sort(compareVersions);
  await audit(c, 'Güncelleme', `${p.name}: ${names.length} sürüm müşterilere güncelleme olarak yayınlandı (${names.join(', ')})`);
  return json({ ok: true, count: names.length, versions: names });
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
      count: rels.filter((x) => String(x.program_id) === pid).length,
      devices: devices.length,
      upToDate: devices.filter((a) => compareVersions(a.app_version, r.version) >= 0).length,
    };
  }
  return out;
}

