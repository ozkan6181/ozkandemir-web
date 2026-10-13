// ozkandemir.net V3.13 — "7 gün ücretsiz demo iste" (sitedeki yazılım sayfaları → /demo.html)
//
// Site formu → POST /lisans/api/demo-talep {program, company, contact_name, email, phone, note, kvkk, website(bal tuzağı)}
//   Talep kaydedilir, info@ozkandemir.net'e bildirim gider (yanıt adresi firmanın e-postası). Firmaya otomatik bir şey
//   gitmez: demo YÖNETİCİ onayıyla gönderilir.
// Panel › Demo talepleri › "Demo gönder" (doğrulama kodu): o program için 7 günlük, 1 cihazlık deneme lisansı
//   (limits_json.deneme = 1, ürünün varsayılan sınırları) + yayındaki son sürüm için 7 günlük / 3 indirmelik bağlantı
//   oluşur; anahtar ve bağlantı firmaya e-postayla gider (e-posta kurulu değilse mesaj panelde gösterilir, WhatsApp ile
//   gönderilebilir). Satın alınca lisansta "Süreyi uzat" yeterlidir (deneme işareti kalkar).
import { json, fail, first, all, run, readJson, audit, fmtTR } from './common.js';
import { randomBytes, sha256hex, b64url, encryptText } from './security.js';
import { PRODUCTS, generateKey, keyHash, maskKey, event, installerVersion, dateTR } from './license.js';
import { mailTransport, SUPPORT } from './destek.js';

export const DEMO = { DAYS: 7, PER_IP_DAY: 5, PATH: '/lisans/api/demo-talep' };
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/;
const clip = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, n);
const one = (v, n) => clip(v, n).replace(/\s+/g, ' ');
const no = (status, message) => json({ ok: false, message }, status);
const fmt = (t) => new Date((t + 3 * 3600) * 1000).toISOString().slice(0, 16).replace('T', ' ');

export const programName = (slug) => (PRODUCTS[slug] ? PRODUCTS[slug].name : slug);

// ---------- herkese açık form ----------
export async function receiveDemoRequest(request, env, cl, t) {
  if (request.method !== 'POST') return no(405, 'Yalnız POST.');
  const b = (await readJson(request).catch(() => null)) || {};
  // Bal tuzağı: insan görmez, bot doldurur → sessizce "alındı" de
  if (clip(b.website, 200)) return json({ ok: true, message: 'Talebiniz alındı.' });
  const slug = String(b.program || '');
  if (!PRODUCTS[slug]) return no(400, 'Lütfen bir yazılım seçin.');
  const company = one(b.company, 120);
  if (company.length < 2) return no(400, 'Firma adını yazın.');
  const name = one(b.contact_name, 80);
  if (name.length < 3) return no(400, 'Adınızı ve soyadınızı yazın.');
  const email = one(b.email, 160).toLowerCase();
  if (!EMAIL_RE.test(email)) return no(400, 'Geçerli bir e-posta adresi yazın; demo bilgileri bu adrese gönderilecek.');
  const phone = String(b.phone || '').replace(/[^\d+ ()-]/g, '').trim().slice(0, 30);
  if (phone.replace(/\D/g, '').length < 10) return no(400, 'Telefon numaranızı yazın.');
  const note = clip(b.note, 800);
  if (b.kvkk !== true) return no(400, 'Devam etmek için KVKK aydınlatma metnini onaylayın.');

  const ip = cl.ip || '';
  const n = await first(env, 'SELECT COUNT(*) AS n FROM demo_requests WHERE ip = ? AND created_at > ?', ip, t - 86400);
  if (n && n.n >= DEMO.PER_IP_DAY) return no(429, 'Bugün bu bağlantıdan çok fazla talep gönderildi. Lütfen 0551 600 77 87 numarasından ulaşın.');
  const dup = await first(env, "SELECT id FROM demo_requests WHERE email = ? AND program_slug = ? AND created_at > ? AND state <> 'closed'", email, slug, t - 7 * 86400);
  if (dup) return json({ ok: true, duplicate: true, message: 'Bu yazılım için talebiniz zaten elimizde. En kısa sürede dönüş yapacağız.' });

  const ins = await run(env,
    'INSERT INTO demo_requests (program_slug, company, contact_name, email, phone, note, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    slug, company, name, email, phone, note || null, ip, t);
  const id = ins.meta.last_row_id;
  const tr = mailTransport(env);
  if (tr) {
    try {
      await tr.send({
        from: { email: env.SUPPORT_FROM || SUPPORT.FROM, name: 'NİS Demo Talebi' },
        to: env.SUPPORT_EMAIL || SUPPORT.TO,
        subject: `[Demo talebi #${id}] ${company} — ${programName(slug)}`,
        text: [
          `Siteden 7 günlük demo talebi geldi.`,
          ``,
          `Yazılım : ${programName(slug)}`,
          `Firma   : ${company}`,
          `Yetkili : ${name}`,
          `E-posta : ${email}`,
          `Telefon : ${phone}`,
          `Konum   : ${cl.location || '-'}`,
          `Zaman   : ${fmt(t)}`,
          note ? `\nNot:\n${note}` : null,
          ``,
          `Panel › Demo talepleri › "Demo gönder" ile 7 günlük deneme lisansı ve indirme bağlantısı firmaya e-postayla gider.`,
        ].filter((x) => x !== null).join('\n'),
        replyTo: email,
      });
      await run(env, "UPDATE demo_requests SET mail_state = 'sent' WHERE id = ?", id);
    } catch (e) { console.error('demo bildirimi', e); }
  }
  return json({ ok: true, id, message: 'Talebiniz alındı. Demo bilgileri onaylandıktan sonra e-posta adresinize gönderilecek.' });
}

// ---------- panel ----------
export async function listDemo(c) {
  const all_ = new URL(c.req.url).searchParams.get('hepsi') === '1';
  const rows = await all(c.env,
    `SELECT d.*, l.key_mask, l.ends_at, l.status AS lic_status FROM demo_requests d LEFT JOIN licenses l ON l.id = d.license_id
      ${all_ ? '' : "WHERE d.state = 'new'"} ORDER BY d.created_at DESC LIMIT 100`);
  const open = await first(c.env, "SELECT COUNT(*) AS n FROM demo_requests WHERE state = 'new'");
  return json({
    open: open ? open.n : 0,
    mailReady: Boolean(mailTransport(c.env)),
    list: rows.map((r) => ({
      id: r.id, program: programName(r.program_slug), slug: r.program_slug, company: r.company, name: r.contact_name,
      email: r.email, phone: r.phone, note: r.note, state: r.state, at: fmtTR(r.created_at),
      sent: r.sent_at ? fmtTR(r.sent_at) : null, licenseId: r.license_id, key: r.key_mask || null,
      ends: r.ends_at ? dateTR(r.ends_at) : null,
    })),
  });
}

function demoMail(env, d) {
  const lines = [
    `Merhaba ${d.name},`,
    ``,
    `${d.company} için ${d.program} 7 günlük demo bilgileriniz:`,
    ``,
    `Lisans anahtarı: ${d.key}`,
    `Geçerlilik: ${d.starts} – ${d.ends} (1 bilgisayar/sunucu)`,
  ];
  if (d.download) {
    lines.push('', `Kurulum dosyası (${d.program} ${d.download.version}):`, d.download.url,
      `Bu bağlantı size özeldir; ${d.download.expires} tarihine kadar 3 kez kullanılabilir.`);
  } else {
    lines.push('', 'Kurulum dosyasını ayrıca ileteceğiz.');
  }
  lines.push('', 'Kurulumdan sonra programın Lisans ekranında anahtarı girip "İnternet ile etkinleştir"e tıklayın.',
    'Demo süresi bitince program kilitlenir ama verileriniz silinmez; satın aldığınızda kaldığınız yerden devam edersiniz.',
    '', 'Sorularınız için bu e-postayı yanıtlayabilirsiniz.', '', 'Özkan Demir — NİS Yazılım', '0551 600 77 87 · info@ozkandemir.net');
  return lines.join('\n');
}

// withCode ile sarılır (değer veren işlem)
export async function sendDemo(c, [, id]) {
  const { env, t } = c;
  const d = await first(env, 'SELECT * FROM demo_requests WHERE id = ?', Number(id));
  if (!d) return fail(404, 'Talep bulunamadı.');
  if (d.state === 'sent') return fail(400, 'Bu talebe demo zaten gönderildi.');
  const cfg = PRODUCTS[d.program_slug];
  const prog = cfg && await first(env, 'SELECT id, name FROM programs WHERE slug = ?', d.program_slug);
  if (!prog) return fail(400, 'Program tanımlı değil.');
  if (!env.PANEL_ENC_KEY) return fail(503, 'PANEL_ENC_KEY tanımlı değil.');
  const limits = Object.fromEntries(cfg.limits.map((l) => [l.key, l.def]));
  limits.deneme = 1;
  const modules = cfg.modules.filter((m) => m.def).map((m) => m.key);
  let key, hash;
  for (let i = 0; i < 5; i++) {
    key = generateKey(cfg.prefix);
    hash = await keyHash(key);
    if (!(await first(env, 'SELECT id FROM licenses WHERE key_hash = ?', hash))) break;
  }
  const endsAt = t + DEMO.DAYS * 86400;
  const ins = await run(env,
    "INSERT INTO licenses (program_id, key_hash, key_enc, key_mask, customer, email, phone, starts_at, ends_at, max_devices, limits_json, modules_json, note, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'active', ?, ?)",
    prog.id, hash, await encryptText(env.PANEL_ENC_KEY, key), maskKey(key), d.company, d.email, d.phone,
    t, endsAt, JSON.stringify(limits), JSON.stringify(modules), `7 günlük demo (site talebi #${d.id}) · ${d.contact_name}`, t, t);
  const licenseId = ins.meta.last_row_id;
  await event(env, licenseId, 'Oluşturuldu', `7 günlük demo · site talebi #${d.id} · ${d.email}`, c.cl);

  let download = null;
  const v = await installerVersion(env, prog.id);
  if (v) {
    const token = b64url(randomBytes(32));
    await run(env, 'INSERT INTO links (token_hash, version_id, customer, expires_at, max_downloads, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      await sha256hex(token), v.id, d.company, endsAt, 3, t);
    download = { url: `${c.url.origin}/indir/${token}`, version: v.version, expires: fmtTR(endsAt) };
  }
  const info = { name: d.contact_name, company: d.company, program: prog.name, key, starts: dateTR(t), ends: dateTR(endsAt), download };
  const text = demoMail(env, info);
  let mailed = false, mailError = null;
  const tr = mailTransport(env);
  if (tr) {
    try {
      await tr.send({
        from: { email: env.SUPPORT_FROM || SUPPORT.FROM, name: 'NİS Yazılım' },
        to: d.email,
        subject: `${prog.name} 7 günlük demo bilgileriniz`,
        text,
        replyTo: env.SUPPORT_EMAIL || SUPPORT.TO,
      });
      mailed = true;
    } catch (e) { mailError = String(e && e.message || e).slice(0, 200); }
  }
  await run(env, "UPDATE demo_requests SET state = 'sent', license_id = ?, sent_at = ? WHERE id = ?", licenseId, t, d.id);
  await audit(c, 'Demo', `${d.company} · ${prog.name} 7 günlük demo ${mailed ? `${d.email} adresine gönderildi` : 'oluşturuldu (e-posta gitmedi)'} (${maskKey(key)})`);
  return json({ ok: true, mailed, mailError, licenseId, email: d.email, phone: d.phone, text, download: Boolean(download) });
}

export async function closeDemo(c, [, id]) {
  const b = (await readJson(c.req)) || {};
  const d = await first(c.env, 'SELECT id, state FROM demo_requests WHERE id = ?', Number(id));
  if (!d) return fail(404, 'Talep bulunamadı.');
  if (d.state === 'sent') return fail(400, 'Demo gönderilmiş talep kapatılamaz.');
  const reopen = b.reopen === true;
  await run(c.env, 'UPDATE demo_requests SET state = ?, closed_at = ? WHERE id = ?', reopen ? 'new' : 'closed', reopen ? null : c.t, d.id);
  return json({ ok: true });
}
