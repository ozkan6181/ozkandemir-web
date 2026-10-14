// ozkandemir.net V3.14 — NİS PDKS kurulum sağlık raporu
//
// Program (V1.46.0+) saatte bir:  POST /pdks-api/api.php {a:'saglik', machine, version, host, odl | license, saglik:{...}}
//   Kimlik check/download ile aynı (pdks-updates.js identify). Kimliği doğrulanmayan istek kaydedilmez; süresi dolmuş /
//   askıdaki lisansın raporu kaydedilir (durumu görünsün), iptal edilmiş lisansınki reddedilir.
//   Kurulum (lisans sahibi + makine) başına yalnız SON rapor tutulur; aynı kurulumdan dakikada en fazla 1 kayıt.
//   Kişisel veri gelmez (personel yalnız sayı).
// Panel › Programlar › "NİS PDKS kurulumları": son sinyal (yeşil < 2 sa, sarı 2–6 sa, kırmızı > 6 sa), sürüm, son yedek,
//   en düşük boş disk, yol kontrolü, lisans kalan gün, sorunlar.
// Zamanlanmış görev (30 dakikada bir): sorun varsa info@ozkandemir.net'e e-posta — aynı kurulum ve aynı sorun için
//   günde en fazla bir kez; sorun düzelince sayaç sıfırlanır (yeniden çıkarsa yine bildirilir).
import { json, fail, first, all, run, readJson, audit, fmtTR } from './common.js';
import { mailTransport, SUPPORT } from './destek.js';

export const HEALTH = { MIN_GAP: 60, MAX_BYTES: 16 * 1024, STALE: 6 * 3600, LATE: 2 * 3600, REALERT: 86400 };
const ok = (data) => json({ ok: true, ...data });
const no = (status, error) => json({ ok: false, error }, status);
const clip = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

// "2026-10-14 10:00:00" (programın yerel saati, Türkiye) ya da ISO → unix saniye
export function parseTs(s) {
  const v = String(s || '').trim();
  if (!v) return null;
  const local = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v);
  const ms = Date.parse(local ? v.replace(' ', 'T') + '+03:00' : v);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}
const hours = (sec) => (sec < 3600 ? `${Math.max(1, Math.round(sec / 60))} dk` : `${Math.round(sec / 360) / 10} sa`);

// ---------- programdan gelen rapor ----------
export async function receiveHealth(env, body, ident, t) {
  const s = body.saglik;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return no(400, 'Geçersiz istek: sağlık bilgisi yok.');
  const payload = JSON.stringify(s);
  if (payload.length > HEALTH.MAX_BYTES) return no(413, 'Sağlık raporu çok büyük.');
  const owner = ident.kind === 'odl' ? `odl:${ident.lid}` : `lic:${ident.id || ident.customer}`;
  const machine = String(ident.kind === 'odl' ? ident.device : (body.machine || '')).toUpperCase().slice(0, 80);
  if (!machine) return no(400, 'Geçersiz istek: makine kodu yok.');
  const prev = await first(env, 'SELECT received_at FROM pdks_health WHERE owner = ? AND machine = ?', owner, machine);
  if (prev && t - prev.received_at < HEALTH.MIN_GAP) return ok({ message: 'Rapor az önce alındı.' });
  const version = clip(body.version || s.surum, 20);
  await run(env,
    `INSERT INTO pdks_health (owner, machine, license_id, customer, host, version, license_state, payload_json, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner, machine) DO UPDATE SET license_id = excluded.license_id, customer = excluded.customer, host = excluded.host,
       version = excluded.version, license_state = excluded.license_state, payload_json = excluded.payload_json, received_at = excluded.received_at`,
    owner, machine, ident.kind === 'odl' ? ident.lid : null, clip(ident.customer, 120), clip(body.host, 80), version,
    ident.status || 'active', payload, t);
  return ok({ message: 'Sağlık raporu alındı.' });
}

// ---------- değerlendirme ----------
// Uyarı (e-posta) gerektiren sorunlar: {key, text}; yalnız gösterilen durumlar: warnings
export function evaluate(row, t) {
  const issues = [], warnings = [];
  const age = t - row.received_at;
  if (age > HEALTH.STALE) issues.push({ key: 'sinyal', text: `${hours(age)} süredir sinyal yok (sunucu kapalı, internet yok ya da program çalışmıyor)` });
  let s = {};
  try { s = JSON.parse(row.payload_json || '{}') || {}; } catch { s = {}; }
  const ref = row.received_at;
  const y = s.yedek || {};
  const db = y.db || {};
  const dbAt = parseTs(db.bitis);
  if (db.durum && db.durum !== 'ok') issues.push({ key: 'yedek_db', text: `Veritabanı yedeği hatalı (${clip(db.durum, 40)})` });
  else if (dbAt && ref - dbAt > 2 * 3600) issues.push({ key: 'yedek_db', text: `Son veritabanı yedeği ${hours(ref - dbAt)} önce` });
  if (s.sifreli_yedek_acik && y.secure) {
    const at = parseTs(y.secure.bitis);
    if (y.secure.durum && y.secure.durum !== 'ok') issues.push({ key: 'yedek_secure', text: `Şifreli yedek hatalı (${clip(y.secure.durum, 40)})` });
    else if (at && ref - at > 26 * 3600) issues.push({ key: 'yedek_secure', text: `Son şifreli yedek ${hours(ref - at)} önce` });
  }
  const ik = s.ikinci_yedek || {};
  if (ik.acik) {
    const at = parseTs(ik.bitis);
    if (ik.durum && ik.durum !== 'ok') issues.push({ key: 'ikinci_yedek', text: `İkinci yedek hatalı (${clip(ik.durum, 40)})` });
    else if (at && ref - at > 26 * 3600) issues.push({ key: 'ikinci_yedek', text: `Son ikinci yedek ${hours(ref - at)} önce` });
  }
  const disks = Array.isArray(s.disk) ? s.disk : [];
  const crit = disks.filter((d) => d && d.seviye === 'kritik');
  if (crit.length) issues.push({ key: 'disk', text: `Disk alanı kritik: ${crit.map((d) => `${clip(d.surucu, 10)} ${Number(d.bos_gb) || 0} GB boş`).join(', ')}` });
  for (const d of disks.filter((d) => d && d.seviye === 'uyari')) warnings.push(`Disk alanı azalıyor: ${clip(d.surucu, 10)} ${Number(d.bos_gb) || 0} GB boş`);
  const yol = s.yol_kontrolu || {};
  if (Number(yol.hata) > 0) issues.push({ key: 'yol', text: `Yol kontrolünde ${Number(yol.hata)} hata (sunucu yeniden başlarsa program açılmayabilir)` });
  else if (Number(yol.uyari) > 0) warnings.push(`Yol kontrolünde ${Number(yol.uyari)} uyarı`);
  const isler = s.isler || {};
  if (Number(isler.dead) > 0) issues.push({ key: 'isler', text: `${Number(isler.dead)} arka plan işi başarısız oldu` });
  if (s.arka_plan === false) issues.push({ key: 'arka_plan', text: 'Arka plan servisi çalışmıyor' });
  if (s.sema && s.sema.mevcut && s.sema.beklenen && s.sema.mevcut !== s.sema.beklenen) warnings.push(`Veritabanı şeması ${clip(s.sema.mevcut, 10)} (beklenen ${clip(s.sema.beklenen, 10)})`);
  const lk = s.lisans || {};
  if (Number.isFinite(Number(lk.kalan_gun)) && lk.kalan_gun !== null && Number(lk.kalan_gun) <= 30) warnings.push(`Lisansın bitmesine ${Number(lk.kalan_gun)} gün`);
  if (row.license_state && row.license_state !== 'active') warnings.push(`Lisans durumu: ${row.license_state}`);
  const minDisk = disks.reduce((m, d) => (d && Number.isFinite(Number(d.bos_gb)) && (!m || Number(d.bos_gb) < m.gb) ? { gb: Number(d.bos_gb), drive: clip(d.surucu, 10) } : m), null);
  return {
    issues, warnings, signal: age > HEALTH.STALE ? 'red' : age > HEALTH.LATE ? 'yellow' : 'green', age,
    backupAt: dbAt, minDisk, pathErrors: Number(yol.hata) || 0, licenseDays: Number.isFinite(Number(lk.kalan_gun)) ? Number(lk.kalan_gun) : null,
    staff: Number.isFinite(Number(s.aktif_personel)) ? Number(s.aktif_personel) : null, db: clip(s.veritabani, 20) || null,
  };
}

// ---------- zamanlanmış görev ----------
export async function runHealthAlerts(env, t) {
  const tr = mailTransport(env);
  const rows = await all(env, 'SELECT * FROM pdks_health');
  let sent = 0;
  for (const row of rows) {
    const ev = evaluate(row, t);
    let alerts = {};
    try { alerts = JSON.parse(row.alerts_json || '{}') || {}; } catch { alerts = {}; }
    const fresh = ev.issues.filter((i) => !alerts[i.key] || t - alerts[i.key] >= HEALTH.REALERT);
    const next = {};
    for (const i of ev.issues) if (alerts[i.key]) next[i.key] = alerts[i.key];   // düzelen sorunun sayacı silinir
    if (fresh.length && tr) {
      try {
        await tr.send({
          from: { email: env.SUPPORT_FROM || SUPPORT.FROM, name: 'NİS PDKS İzleme' },
          to: env.SUPPORT_EMAIL || SUPPORT.TO,
          subject: `[PDKS uyarı] ${row.customer || row.owner} — ${row.host || row.machine}: ${fresh.map((i) => i.text).join('; ').slice(0, 90)}`,
          text: [
            `Kurulum : ${row.customer || '-'} · ${row.host || '-'} (${row.machine})`,
            `Sürüm   : ${row.version || '-'}`,
            `Son rapor: ${fmtTR(row.received_at)}`,
            ``,
            `Sorunlar:`,
            ...ev.issues.map((i) => `- ${i.text}${fresh.includes(i) ? '' : ' (daha önce bildirildi)'}`),
            ...(ev.warnings.length ? ['', 'Uyarılar:', ...ev.warnings.map((w) => `- ${w}`)] : []),
            ``,
            `Panel › Programlar › NİS PDKS kurulumları. Aynı sorun için günde en fazla bir e-posta gönderilir.`,
          ].join('\n'),
        });
        for (const i of fresh) next[i.key] = t;
        sent++;
      } catch (e) { console.error('sağlık uyarısı', e); }
    }
    const json_ = JSON.stringify(next);
    if (json_ !== (row.alerts_json || '{}')) await run(env, 'UPDATE pdks_health SET alerts_json = ? WHERE owner = ? AND machine = ?', json_, row.owner, row.machine);
  }
  return sent;
}

// ---------- panel ----------
export async function listHealth(c) {
  const rows = await all(c.env, 'SELECT * FROM pdks_health ORDER BY received_at DESC');
  const list = rows.map((r) => {
    const ev = evaluate(r, c.t);
    return {
      owner: r.owner, machine: r.machine, licenseId: r.license_id, customer: r.customer, host: r.host, version: r.version,
      licenseState: r.license_state, last: fmtTR(r.received_at), ago: hours(ev.age), signal: ev.signal,
      backup: ev.backupAt ? fmtTR(ev.backupAt) : null, minDisk: ev.minDisk, pathErrors: ev.pathErrors, licenseDays: ev.licenseDays,
      staff: ev.staff, db: ev.db, issues: ev.issues.map((i) => i.text), warnings: ev.warnings,
    };
  });
  return json({ list, problems: list.filter((x) => x.issues.length).length, mailReady: Boolean(mailTransport(c.env)) });
}

export async function removeHealth(c) {
  const b = (await readJson(c.req)) || {};
  const r = await first(c.env, 'SELECT customer, host FROM pdks_health WHERE owner = ? AND machine = ?', String(b.owner || ''), String(b.machine || ''));
  if (!r) return fail(404, 'Kurulum bulunamadı.');
  await run(c.env, 'DELETE FROM pdks_health WHERE owner = ? AND machine = ?', String(b.owner), String(b.machine));
  await audit(c, 'Sağlık', `${r.customer || ''} · ${r.host || ''} kurulumu izlemeden kaldırıldı (yeni rapor gelirse yeniden görünür)`);
  return json({ ok: true });
}
