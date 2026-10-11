// ozkandemir.net V3.10 — NİS PDKS uzaktan erişim adresi (Cloudflare Tunnel): <ad>-pdks.ozkandemir.net
//
// Program (Ayarlar › Uzaktan Erişim) → POST /pdks-api/api.php
//   {a:'tunnel_create', name, port, + lisans kimliği}  → {ok, hostname, tunnel_id, token}
//   {a:'tunnel_delete', hostname, tunnel_id, + kimlik}  → {ok}
// Site Cloudflare API ile tüneli, yönlendirmeyi (http://localhost:<port>) ve DNS kaydını kurar. Programa yalnız o
// tünele ait çalıştırma anahtarı (token) döner; token sitede SAKLANMAZ. Cloudflare API anahtarı yalnız sitededir:
// panelde bir kez girilir (doğrulama koduyla), PANEL_ENC_KEY ile şifreli saklanır. İstenirse gizli değişkenler
// CF_TUNNEL_TOKEN (+ CF_ACCOUNT_ID, CF_ZONE_ID) panel ayarının yerine geçer.
// Gereken anahtar izinleri: Account › Cloudflare Tunnel › Edit, Zone › DNS › Edit (ozkandemir.net).
// Müşteri sunucusundaki diğer erişim yolları (Tailscale, yerel ağ) etkilenmez: tünel ayrı bir Windows servisidir.
import { json, fail, first, all, run, readJson, audit } from './common.js';
import { encryptText, decryptText } from './security.js';

const CF = 'https://api.cloudflare.com/client/v4';
export const TUN = {
  ZONE: 'ozkandemir.net',
  SUFFIX: '-pdks',
  PER_DAY: 5,
  NAME_RE: /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/,
  RESERVED: new Set(['www', 'mail', 'smtp', 'imap', 'pop', 'pop3', 'api', 'panel', 'admin', 'pdks', 'ftp', 'cpanel',
    'webmail', 'autodiscover', 'autoconfig', 'ns', 'ns1', 'ns2', 'mx', 'test', 'demo', 'destek', 'support', 'lisans',
    'indir', 'ozkandemir', 'nis', 'cf-bounce', 'status', 'static', 'cdn', 'root', 'localhost']),
};

export class TunnelError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- Cloudflare ----------
export async function cfConfig(env) {
  if (env.CF_TUNNEL_TOKEN) {
    return { token: env.CF_TUNNEL_TOKEN, account: env.CF_ACCOUNT_ID || '', zone: env.CF_ZONE_ID || '', from: 'env' };
  }
  const r = await first(env, "SELECT value FROM settings WHERE name = 'cf_tunnel'");
  if (!r) return null;
  let v;
  try { v = JSON.parse(r.value); } catch { return null; }
  try { v.token = await decryptText(env.PANEL_ENC_KEY, v.token_enc); } catch { return null; }
  return { ...v, from: 'panel' };
}

async function cf(cfg, method, path, body) {
  let r;
  try {
    r = await fetch(CF + path, {
      method,
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new TunnelError(502, 'Cloudflare\'e bağlanılamadı; birkaç dakika sonra tekrar deneyin.');
  }
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok || data.success === false) {
    const e = new TunnelError(502, 'Cloudflare isteği başarısız: ' + ((data.errors && data.errors[0] && data.errors[0].message) || `HTTP ${r.status}`));
    e.cfStatus = r.status;
    e.cfCode = data.errors && data.errors[0] && data.errors[0].code;
    throw e;
  }
  return data.result;
}

async function ids(env, cfg) {
  if (cfg.account && cfg.zone) return cfg;
  const zones = await cf(cfg, 'GET', `/zones?name=${TUN.ZONE}`);
  const z = zones && zones[0];
  if (!z) throw new TunnelError(503, 'Cloudflare anahtarı ozkandemir.net alanına erişemiyor.');
  return { ...cfg, zone: z.id, account: (z.account && z.account.id) || cfg.account };
}

// Panel: anahtarı doğrula ve şifreli kaydet
export async function saveCfConfig(c) {
  const b = (await readJson(c.req)) || {};
  const token = String(b.token || '').trim();
  if (!/^[A-Za-z0-9_-]{30,200}$/.test(token)) return fail(400, 'Cloudflare API anahtarı geçersiz görünüyor.');
  let cfg = { token };
  try {
    cfg = await ids(c.env, cfg);
    await cf(cfg, 'GET', `/accounts/${cfg.account}/cfd_tunnel?per_page=1&is_deleted=false`);
    await cf(cfg, 'GET', `/zones/${cfg.zone}/dns_records?per_page=1`);
  } catch (e) {
    return fail(400, `Anahtar doğrulanamadı (${e.message}). İzinler: Account › Cloudflare Tunnel › Edit ve Zone › DNS › Edit.`);
  }
  const value = JSON.stringify({ token_enc: await encryptText(c.env.PANEL_ENC_KEY, token), account: cfg.account, zone: cfg.zone,
    mask: token.slice(0, 4) + '…' + token.slice(-4), saved_at: c.t });
  await run(c.env, 'INSERT INTO settings (name, value, updated_at) VALUES (\'cf_tunnel\', ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    value, c.t);
  await audit(c, 'Uzaktan erişim', 'Cloudflare tünel anahtarı kaydedildi');
  return json({ ok: true });
}

export async function deleteCfConfig(c) {
  await run(c.env, "DELETE FROM settings WHERE name = 'cf_tunnel'");
  await audit(c, 'Uzaktan erişim', 'Cloudflare tünel anahtarı silindi (mevcut adresler çalışmaya devam eder)');
  return json({ ok: true });
}

// ---------- yardımcılar ----------
export function ownerOf(ident) {
  return ident.kind === 'odl' ? `odl:${ident.lid}` : `lic:${ident.id || ident.customer}`;
}

function machineOf(ident, body) {
  return String(ident.kind === 'odl' ? ident.device : (body.machine || '')).toUpperCase().slice(0, 80);
}

export function validName(name) {
  return TUN.NAME_RE.test(name) && !name.includes('--') && !TUN.RESERVED.has(name);
}

async function findDns(cfg, hostname) {
  const r = await cf(cfg, 'GET', `/zones/${cfg.zone}/dns_records?name=${encodeURIComponent(hostname)}`);
  return (r && r[0]) || null;
}

async function putDns(cfg, hostname, tunnelId) {
  const content = `${tunnelId}.cfargotunnel.com`;
  const body = { type: 'CNAME', name: hostname, content, proxied: true, comment: 'NİS PDKS uzaktan erişim' };
  const ex = await findDns(cfg, hostname);
  if (ex) {
    // yalnız tünel kaydı (cfargotunnel) devralınır; başka bir kayıt asla ezilmez
    if (ex.type !== 'CNAME' || !String(ex.content || '').endsWith('.cfargotunnel.com')) {
      throw new TunnelError(409, 'Bu ad kullanımda; başka bir ad seçin.');
    }
    const r = await cf(cfg, 'PUT', `/zones/${cfg.zone}/dns_records/${ex.id}`, body);
    return r.id;
  }
  const r = await cf(cfg, 'POST', `/zones/${cfg.zone}/dns_records`, body);
  return r.id;
}

async function deleteDns(cfg, recordId, hostname) {
  try {
    if (recordId) { await cf(cfg, 'DELETE', `/zones/${cfg.zone}/dns_records/${recordId}`); return; }
  } catch (e) { if (e.cfStatus !== 404) throw e; }
  const ex = hostname ? await findDns(cfg, hostname).catch(() => null) : null;
  if (ex && String(ex.content || '').endsWith('.cfargotunnel.com')) await cf(cfg, 'DELETE', `/zones/${cfg.zone}/dns_records/${ex.id}`);
}

async function deleteTunnel(cfg, tunnelId) {
  try { await cf(cfg, 'DELETE', `/accounts/${cfg.account}/cfd_tunnel/${tunnelId}/connections`); } catch (e) { if (e.cfStatus !== 404) throw e; }
  try { await cf(cfg, 'DELETE', `/accounts/${cfg.account}/cfd_tunnel/${tunnelId}`); } catch (e) { if (e.cfStatus !== 404) throw e; }
}

async function configure(cfg, tunnelId, hostname, port) {
  await cf(cfg, 'PUT', `/accounts/${cfg.account}/cfd_tunnel/${tunnelId}/configurations`, {
    config: { ingress: [{ hostname, service: `http://localhost:${port}`, originRequest: {} }, { service: 'http_status:404' }] },
  });
}

// ---------- programdan gelen istekler ----------
export async function tunnelCreate(env, body, ident, t) {
  const owner = ownerOf(ident);
  const machine = machineOf(ident, body);
  if (!machine) throw new TunnelError(400, 'Sunucu kimliği gönderilmedi.');
  const name = String(body.name || '').trim().toLowerCase();
  if (!validName(name)) throw new TunnelError(400, 'Ad 3–30 karakter olmalı; yalnız küçük harf, rakam ve tire (örn. kitapsec).');
  const port = Number(body.port) || 8000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TunnelError(400, 'Port geçersiz.');
  const hostname = `${name}${TUN.SUFFIX}.${TUN.ZONE}`;

  const taken = await first(env, 'SELECT owner, machine FROM tunnels WHERE name = ?', name);
  if (taken && (taken.owner !== owner || taken.machine !== machine)) throw new TunnelError(409, 'Bu ad kullanımda; başka bir ad seçin.');
  const n = await first(env, "SELECT COUNT(*) AS n FROM tunnel_log WHERE owner = ? AND action = 'create' AND at > ?", owner, t - 86400);
  if (n && n.n >= TUN.PER_DAY) throw new TunnelError(429, 'Bugün için adres işlemi sınırına ulaşıldı; yarın tekrar deneyin.');
  let cfg = await cfConfig(env);
  if (!cfg) throw new TunnelError(503, 'Uzaktan erişim hizmeti henüz hazır değil. NİS destek: 0551 600 77 87.');
  cfg = await ids(env, cfg);
  await run(env, "INSERT INTO tunnel_log (owner, at, action, detail) VALUES (?, ?, 'create', ?)", owner, t, hostname);

  const row = await first(env, 'SELECT * FROM tunnels WHERE owner = ? AND machine = ?', owner, machine);
  let tunnelId = row ? row.tunnel_id : null;
  if (tunnelId) {
    try { await cf(cfg, 'GET', `/accounts/${cfg.account}/cfd_tunnel/${tunnelId}`); } catch (e) { if (e.cfStatus === 404) tunnelId = null; else throw e; }
  }
  let created = false;
  if (!tunnelId) {
    const slugOwner = owner.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40);
    const tn = await cf(cfg, 'POST', `/accounts/${cfg.account}/cfd_tunnel`,
      { name: `pdks-${slugOwner}-${machine.replace(/[^A-Z0-9]/g, '').slice(0, 8).toLowerCase()}-${t.toString(36)}`, config_src: 'cloudflare' });
    tunnelId = tn.id;
    created = true;
  }
  let dnsId, token;
  try {
    await configure(cfg, tunnelId, hostname, port);
    dnsId = await putDns(cfg, hostname, tunnelId);
    token = await cf(cfg, 'GET', `/accounts/${cfg.account}/cfd_tunnel/${tunnelId}/token`);
  } catch (e) {
    if (created) await deleteTunnel(cfg, tunnelId).catch(() => {});   // yarım kalan yeni tünel Cloudflare'de bırakılmaz
    throw e;
  }
  if (row && row.hostname !== hostname) await deleteDns(cfg, row.dns_record_id, row.hostname).catch(() => {});

  const vals = [ident.kind === 'odl' ? ident.lid : null, String(ident.customer || '').slice(0, 120), String(body.host || '').slice(0, 80),
    name, hostname, tunnelId, dnsId, port, t];
  if (row) {
    await run(env, 'UPDATE tunnels SET license_id = ?, customer = ?, host = ?, name = ?, hostname = ?, tunnel_id = ?, dns_record_id = ?, port = ?, updated_at = ? WHERE id = ?',
      ...vals, row.id);
  } else {
    await run(env, 'INSERT INTO tunnels (license_id, customer, host, name, hostname, tunnel_id, dns_record_id, port, updated_at, owner, machine, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ...vals, owner, machine, t);
  }
  return { ok: true, hostname, tunnel_id: tunnelId, token: String(token) };
}

export async function tunnelDelete(env, body, ident, t) {
  const owner = ownerOf(ident);
  const machine = machineOf(ident, body);
  const row = await first(env, 'SELECT * FROM tunnels WHERE owner = ? AND machine = ?', owner, machine);
  if (!row) return { ok: true, message: 'Kayıt zaten yok.' };
  if (body.hostname && String(body.hostname).toLowerCase() !== row.hostname) throw new TunnelError(403, 'Bu adres bu sunucuya ait değil.');
  await closeRow(env, row);
  await run(env, "INSERT INTO tunnel_log (owner, at, action, detail) VALUES (?, ?, 'delete', ?)", owner, t, row.hostname);
  return { ok: true };
}

async function closeRow(env, row) {
  let cfg = await cfConfig(env);
  if (!cfg) throw new TunnelError(503, 'Cloudflare anahtarı tanımlı değil; adres kapatılamadı.');
  cfg = await ids(env, cfg);
  await deleteDns(cfg, row.dns_record_id, row.hostname);
  await deleteTunnel(cfg, row.tunnel_id);
  await run(env, 'DELETE FROM tunnels WHERE id = ?', row.id);
}

export async function handleTunnelAction(env, a, body, ident, t) {
  try {
    const res = a === 'tunnel_create' ? await tunnelCreate(env, body, ident, t) : await tunnelDelete(env, body, ident, t);
    return json(res);
  } catch (e) {
    if (e instanceof TunnelError) return json({ ok: false, error: e.message }, e.status || 400);
    console.error('tünel', e);
    return json({ ok: false, error: 'Adres işlemi tamamlanamadı; birkaç dakika sonra tekrar deneyin.' }, 500);
  }
}

// ---------- panel ----------
export async function listTunnels(c) {
  const cfg = await cfConfig(c.env).catch(() => null);
  const rows = await all(c.env, 'SELECT id, owner, license_id, customer, host, name, hostname, port, created_at, updated_at FROM tunnels ORDER BY created_at DESC');
  const fmt = (x) => new Date((x + 3 * 3600) * 1000).toISOString().slice(0, 16).replace('T', ' ');
  return json({
    ready: Boolean(cfg), from: cfg ? cfg.from : null, mask: cfg && cfg.mask ? cfg.mask : (cfg ? 'gizli değişken' : ''),
    list: rows.map((r) => ({ ...r, created: fmt(r.created_at), updated: fmt(r.updated_at), legacy: r.owner.startsWith('lic:') })),
  });
}

export async function closeTunnel(c, [, id]) {
  const row = await first(c.env, 'SELECT * FROM tunnels WHERE id = ?', Number(id));
  if (!row) return fail(404, 'Adres bulunamadı.');
  try { await closeRow(c.env, row); } catch (e) { return fail(e.status || 502, e.message); }
  await run(c.env, "INSERT INTO tunnel_log (owner, at, action, detail) VALUES (?, ?, 'close', ?)", row.owner, c.t, row.hostname);
  await audit(c, 'Uzaktan erişim', `${row.customer} · ${row.hostname} kapatıldı`);
  return json({ ok: true });
}

// Panel lisansı iptal edilince o lisansın adresleri kapanır (hata lisans iptalini engellemez)
export async function closeTunnelsOfLicense(env, licenseId) {
  const rows = await all(env, 'SELECT * FROM tunnels WHERE license_id = ?', Number(licenseId));
  let n = 0;
  for (const r of rows) { try { await closeRow(env, r); n++; } catch (e) { console.error('tünel kapatma', e); } }
  return n;
}
