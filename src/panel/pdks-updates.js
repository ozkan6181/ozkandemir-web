// ozkandemir.net — NİS PDKS güncelleme kanalı (programın "Ayarlar › Güncellemeler" ekranı ve gece otomatik kurulum)
//
//   POST /pdks-api/api.php   {a: 'check' | 'download', machine, version, host, odl | license, target?}
//   GET  /pdks-api/api.php   → {ok:true, service}
//
// Kaynak: panelde "Programlar / Sürümler" › NİS PDKS altına yüklenen PDKS_Vx.y.z_guncelleme.zip dosyaları (R2).
// Her paketin hangi sürümden hangi sürüme götürdüğü paketin İÇİNDEKİ manifest.json'dan okunur (from_version →
// to_version); panelde yazılan sürüm etiketi ve Setup.exe gibi diğer dosyalar zinciri etkilemez.
// Paket imzası (satıcı anahtarı) müşteri sunucusunda kurulumdan önce yeniden doğrulanır; site ele geçirilse bile
// imzasız paket kurulmaz. Site hiçbir kurulumu başlatmaz: program sorar, kurulum kararı programdadır.
//
// Kimlik:
//   odl     — panel lisansı: programın data/lisans/lisans.json metni. İçindeki ODL1 belgesi bu sitenin imza anahtarıyla
//             doğrulanır; lisans durumu (etkin / süre / askı / iptal) ve cihazın kaldırılmamış olması veritabanından.
//   license — eski .lic lisansı (Kitapseç gibi ilk kurulumlar): satıcı anahtarıyla imzalı 4 ya da 8 satırlık dosya.
//             Güncelleme hakkı lisanstaki updates_until tarihine kadar (boş = süresiz).
// Diğer işlemler (support_question, tunnel_create, tunnel_delete) sonraki sürümde; şimdilik "henüz etkin değil" döner
// (program destek sorularını bekletir ve sonra yeniden gönderir).
import { now } from './security.js';
import { json, first, all, run, readJson } from './common.js';
import { verifyToken, signingPublicKey } from './license.js';

export const UPDATE_PATH = '/pdks-api/api.php';
// NİS PDKS satıcı genel anahtarı (Ed25519, ham 32 bayt, base64). Programdaki app/commercial/keys.py ile aynı.
export const VENDOR_PUBKEY = '2N6AjhRcWkO7+w3v/T7PHcn3yUmfzycK+uJevD2LYXY=';
const PROGRAM_SLUG = 'nis-pdks';
const PKG_RE = /(^|[\\/])PDKS_V\d+\.\d+\.\d+[A-Za-z0-9.-]*_guncelleme\.zip$/;
const LIC_H = '-----BEGIN NIS PDKS LICENSE-----', LIC_F = '-----END NIS PDKS LICENSE-----';

const ok = (data, status = 200) => json({ ok: true, ...data }, status);
const no = (status, error) => json({ ok: false, error }, status);

// ---------- yardımcılar ----------
export function vtuple(v) {
  return (String(v || '').match(/\d+/g) || []).slice(0, 4).map(Number);
}
export function vcmp(a, b) {
  const x = vtuple(a), y = vtuple(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}
const isoDate = (t) => new Date((Number(t) + 3 * 3600) * 1000).toISOString().slice(0, 10);
const stdB64 = (s) => Uint8Array.from(atob(String(s).trim()), (c) => c.charCodeAt(0));

async function edVerify(pubRaw, sig, msg) {
  try {
    const key = await crypto.subtle.importKey('raw', pubRaw, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, msg);
  } catch { return false; }
}

// ---------- kimlik ----------
// Eski .lic lisansı → {customer, updatesUntil (YYYY-MM-DD | null), machine (| null), id} ya da null
export async function verifyLegacyLicense(text, vendorPub = VENDOR_PUBKEY) {
  const lines = String(text || '').trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (![4, 8].includes(lines.length) || lines[0] !== LIC_H || lines[lines.length - 1] !== LIC_F) return null;
  let payload, sig;
  try { payload = stdB64(lines[1]); sig = stdB64(lines[2]); } catch { return null; }
  const pub = stdB64(vendorPub);
  if (!(await edVerify(pub, sig, payload))) return null;
  let data;
  try { data = JSON.parse(new TextDecoder().decode(payload)); } catch { return null; }
  if (!data || !data.customer) return null;
  let machine = data.machine || null;
  if (lines.length === 4) {
    if (data.v !== 1) return null;
  } else {
    if (data.v !== 2 || data.machine) return null;
    let bind, bsig, cert, csig;
    try { [bind, bsig, cert, csig] = lines.slice(3, 7).map(stdB64); } catch { return null; }
    if (!(await edVerify(pub, csig, cert))) return null;
    let c, b;
    try { c = JSON.parse(new TextDecoder().decode(cert)); b = JSON.parse(new TextDecoder().decode(bind)); } catch { return null; }
    if (c.purpose !== 'activation' || !c.pub || !c.kid) return null;
    if (!(await edVerify(stdB64(c.pub), bsig, bind))) return null;
    if (b.ent !== data.id || b.kid !== c.kid || !b.machine) return null;
    machine = b.machine;
  }
  return { kind: 'license', id: String(data.id || ''), customer: String(data.customer), updatesUntil: data.updates_until || null, machine };
}

// Panel lisansı (lisans.json metni) → {kind, lid, customer, device} ya da {error}
async function verifyPanelLicense(env, odlText, t) {
  let doc;
  try { doc = JSON.parse(String(odlText || '')); } catch { return { error: 'Lisans belgesi okunamadı.' }; }
  const payload = doc && doc.token ? await verifyToken(await signingPublicKey(env), doc.token) : null;
  if (!payload || payload.typ !== 'od-license' || payload.product !== 'NPDK') return { error: 'Lisans doğrulanamadı.' };
  const lic = await first(env, 'SELECT l.*, p.slug FROM licenses l JOIN programs p ON p.id = l.program_id WHERE l.id = ?', payload.lid);
  if (!lic || lic.slug !== PROGRAM_SLUG) return { error: 'Lisans bulunamadı.' };
  if (lic.status === 'revoked') return { error: 'Lisans iptal edilmiş. Lütfen Özkan Demir ile iletişime geçin.', status: 'revoked' };
  if (lic.status === 'suspended') return { error: 'Lisans askıya alınmış. Lütfen Özkan Demir ile iletişime geçin.', status: 'suspended' };
  if (lic.ends_at < t) return { error: 'Lisans süresi dolmuş; güncelleme alınamaz.', status: 'expired' };
  const act = await first(env, 'SELECT id, app_version, removed_at FROM activations WHERE license_id = ? AND device_id = ?', lic.id, payload.device);
  if (!act || act.removed_at) return { error: 'Bu sunucunun lisans kaydı kaldırılmış. Lisansı yeniden etkinleştirin.', status: 'deactivated' };
  return { kind: 'odl', lid: lic.id, customer: lic.customer, device: payload.device, activationId: act.id, activationVersion: act.app_version };
}

async function identify(env, body, t) {
  if (body.odl) return verifyPanelLicense(env, body.odl, t);
  if (body.license) {
    const l = await verifyLegacyLicense(body.license, env.PDKS_VENDOR_PUBKEY || VENDOR_PUBKEY);
    if (!l) return { error: 'Lisans dosyası doğrulanamadı.' };
    const machine = String(body.machine || '').toUpperCase();
    if (l.machine && machine && String(l.machine).toUpperCase() !== machine) return { error: 'Lisans bu sunucuya ait değil.' };
    return l;
  }
  return { error: 'Lisans bilgisi gönderilmedi.' };
}

// ---------- paketler ----------
// ZIP içinden "<klasör>/manifest.json" (manifest.imza.json değil) okunur.
export async function readZipManifest(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let n = 0; n < count && p + 46 <= u8.length; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) return null;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const loff = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    if (!/(^|\/)manifest\.json$/.test(name) || name.split('/').length > 2) continue;
    if (dv.getUint32(loff, true) !== 0x04034b50) return null;
    const start = loff + 30 + dv.getUint16(loff + 26, true) + dv.getUint16(loff + 28, true);
    const raw = u8.subarray(start, start + csize);
    let text;
    if (method === 0) text = dec.decode(raw);
    else if (method === 8) {
      const out = await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
      text = dec.decode(out);
    } else return null;
    try { return JSON.parse(text); } catch { return null; }
  }
  return null;
}

const META = new Map(); // r2_key|sha|size → {from, to} (aynı Worker örneğinde tekrar okunmaz)

async function packageMeta(env, v) {
  const ck = `${v.r2_key}|${v.sha256 || ''}|${v.size}`;
  if (META.has(ck)) return META.get(ck);
  let meta = null;
  const obj = await env.FILES.get(v.r2_key);
  if (obj) {
    const m = await readZipManifest(new Uint8Array(await obj.arrayBuffer()));
    if (m && m.from_version && m.to_version) meta = { from: String(m.from_version), to: String(m.to_version) };
  }
  META.set(ck, meta);
  return meta;
}

export async function releases(env) {
  const rows = await all(env,
    "SELECT v.* FROM versions v JOIN programs p ON p.id = v.program_id WHERE p.slug = ? AND v.status = 'ready' ORDER BY v.created_at, v.id",
    PROGRAM_SLUG);
  const out = [];
  for (const v of rows) {
    if (!PKG_RE.test(v.filename || '')) continue;               // Setup.exe vb. güncelleme zinciri dışında
    const meta = await packageMeta(env, v);
    if (!meta) continue;
    out.push({
      id: v.id, version: meta.to, from: meta.from, size: Number(v.size) || 0, r2_key: v.r2_key, filename: v.filename,
      sha256: /^[a-f0-9]{64}$/i.test(v.sha256 || '') ? v.sha256.toLowerCase() : '',
      notes: v.notes || '', published: isoDate(v.created_at), released: isoDate(v.created_at),
    });
  }
  return out;
}

// Kurulu sürümden en yeni sürüme sıralı zincir (her adımda o sürümden çıkan en yüksek hedef seçilir)
export function buildChain(rels, current, updatesUntil) {
  const byFrom = new Map();
  for (const r of rels) {
    const k = vtuple(r.from).join('.');
    if (!byFrom.has(k)) byFrom.set(k, []);
    byFrom.get(k).push(r);
  }
  const chain = [], blocked = [];
  let v = current, guard = 0;
  while (guard++ < 100) {
    const cands = (byFrom.get(vtuple(v).join('.')) || []).filter((r) => vcmp(r.version, v) > 0);
    if (!cands.length) break;
    cands.sort((a, b) => vcmp(b.version, a.version) || (b.id - a.id));
    const r = cands[0];
    const item = { version: r.version, from: r.from, sha256: r.sha256, size: r.size, notes: r.notes, published: r.published, released: r.released };
    if (updatesUntil && r.released > updatesUntil) { blocked.push(item); break; }
    chain.push(item);
    v = r.version;
  }
  return { chain, blocked };
}

// ---------- uç nokta ----------
export async function handleUpdateApi(request, env) {
  if (request.method === 'GET' || request.method === 'HEAD') return ok({ service: 'NİS PDKS güncelleme', time: now() });
  if (request.method !== 'POST') return no(405, 'Yöntem desteklenmiyor.');
  if (!env.DB || !env.FILES) return no(503, 'Güncelleme hizmeti hazır değil.');
  const t = now();
  const body = (await readJson(request)) || {};
  const a = String(body.a || '');
  if (!['check', 'download'].includes(a)) return no(404, 'Bu işlem henüz etkin değil.');
  const id = await identify(env, body, t);
  if (id.error) return no(403, id.error);
  const current = String(body.version || '').slice(0, 20);
  const until = id.kind === 'license' ? id.updatesUntil : null;
  const { chain, blocked } = buildChain(await releases(env), current, until);
  if (id.kind === 'odl' && current && current !== id.activationVersion) {
    await run(env, 'UPDATE activations SET app_version = ?, last_seen = ? WHERE id = ?', current, t, id.activationId);
  }
  if (a === 'check') {
    return ok({
      status: 'active', message: '', chain, blocked, latest: chain.length ? chain[chain.length - 1].version : current,
      auto_stop: String(env.PDKS_AUTO_STOP || '') === '1', server_time: t,
    });
  }
  const target = String(body.target || '');
  if (!chain.some((c) => c.version === target)) return no(403, 'Bu sürüm sizin için indirilebilir değil (güncelleme hakkı ya da sıra).');
  const rel = (await releases(env)).find((r) => r.version === target);
  const obj = rel ? await env.FILES.get(rel.r2_key) : null;
  if (!obj) return no(404, 'Paket dosyası bulunamadı.');
  return new Response(obj.body, {
    headers: {
      'content-type': 'application/zip', 'content-length': String(obj.size), 'cache-control': 'no-store',
      'content-disposition': `attachment; filename="PDKS_${target.replace(/[^A-Za-z0-9._-]/g, '')}_guncelleme.zip"`,
    },
  });
}
