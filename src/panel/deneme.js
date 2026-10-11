// ozkandemir.net V3.11 — 7 günlük deneme lisansı (programın ilk kurulum ekranındaki "7 gün dene")
//
// Program → POST /lisans/api/trial {product, email, company, phone?, contact_name?, device_id, device_name, app_version}
// Site normal bir panel lisansı oluşturur (7 gün, 1 cihaz, ürünün varsayılan sınırları; limits_json'da "deneme": 1)
// ve anahtarı YALNIZ e-postayla gönderir (yanıtta anahtar yok → e-posta doğrulanmış olur). Kullanıcı e-postadaki
// anahtarı aynı ekrana yazar; etkinleştirme bilinen yoldan (/lisans/api/activate) yapılır.
// Kurallar: aynı e-posta ya da aynı sunucu (cihaz kimliği) ikinci kez deneme alamaz; anahtar henüz kullanılmadıysa
// aynı e-postaya en fazla 3 kez yeniden gönderilir; aynı IP'den günde en fazla 5 deneme isteği.
// Süre bitince program kilitlenir, veriler silinmez. Satın alınca panelde "Süreyi uzat" yeterlidir (deneme işareti
// kalkar); program Ayarlar › Lisans › "Şimdi doğrula" ile ya da 7 günlük doğrulamada açılır.
// Her yeni denemede info@ozkandemir.net'e bildirim gider.
import { json, first, run, readJson } from './common.js';
import { encryptText, decryptText } from './security.js';
import { PRODUCTS, BY_PREFIX, generateKey, keyHash, maskKey, event, isTrial, TRIAL_EXPIRED_MSG } from './license.js';

export { isTrial, TRIAL_EXPIRED_MSG };
import { mailTransport, SUPPORT } from './destek.js';

export const TRIAL = { DAYS: 7, PER_IP_DAY: 5, MAX_SENDS: 3, PRODUCTS: ['NPDK'] };
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/;
const no = (status, message, code = 'error') => json({ ok: false, code, message }, status);

const fmt = (t) => new Date((t + 3 * 3600) * 1000).toISOString().slice(0, 16).replace('T', ' ');

function keyMail(env, to, company, key, endsAt, program) {
  return {
    from: { email: env.SUPPORT_FROM || SUPPORT.FROM, name: 'NİS Lisans' },
    to,
    subject: `${program} 7 günlük deneme anahtarınız`,
    text: [
      `Merhaba,`,
      ``,
      `${company} için ${program} deneme anahtarınız:`,
      ``,
      `    ${key}`,
      ``,
      `Programın ilk kurulum ekranında "Lisans anahtarı" alanına yazıp "Kurulumu Tamamla"ya basın.`,
      `Deneme ${fmt(endsAt)} tarihine kadar geçerlidir (7 gün). Süre bitince program kilitlenir ama verileriniz silinmez;`,
      `satın aldığınızda kaldığınız yerden devam edersiniz.`,
      ``,
      `Bu e-postayı siz istemediyseniz dikkate almayın.`,
      ``,
      `Özkan Demir — NİS Yazılım`,
      `0551 600 77 87 · info@ozkandemir.net`,
    ].join('\n'),
  };
}

function ownerMail(env, d) {
  return {
    from: { email: env.SUPPORT_FROM || SUPPORT.FROM, name: 'NİS Lisans' },
    to: env.SUPPORT_EMAIL || SUPPORT.TO,
    subject: `[Yeni deneme] ${d.company} — ${d.program}`,
    text: [
      `Yeni 7 günlük deneme başladı (anahtar e-postayla gönderildi).`,
      ``,
      `Firma   : ${d.company}`,
      `Yetkili : ${d.name || '-'}`,
      `E-posta : ${d.email}`,
      `Telefon : ${d.phone || '-'}`,
      `Sunucu  : ${d.deviceName}`,
      `Bitiş   : ${fmt(d.endsAt)}`,
      ``,
      `Panel › Lisanslar'da "Deneme" olarak görünür. Satın alırsa "Süreyi uzat" yeterli.`,
    ].join('\n'),
    ...(EMAIL_RE.test(d.email) ? { replyTo: d.email } : {}),
  };
}

export async function handleTrial(request, env, cl, t) {
  let b;
  try { b = (await readJson(request)) || {}; } catch { return no(400, 'İstek okunamadı.'); }
  const product = String(b.product || '').toUpperCase().slice(0, 4);
  if (!TRIAL.PRODUCTS.includes(product) || !BY_PREFIX[product]) return no(400, 'Bu program için deneme verilmiyor.');
  const email = String(b.email || '').trim().toLowerCase().slice(0, 160);
  if (!EMAIL_RE.test(email)) return no(400, 'Geçerli bir e-posta adresi girin.');
  const company = String(b.company || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120);
  if (company.length < 2) return no(400, 'Şirket adını girin.');
  const phone = String(b.phone || '').replace(/[^\d+ ()-]/g, '').trim().slice(0, 30);
  const name = String(b.contact_name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80);
  const deviceId = String(b.device_id || '').toLowerCase();
  if (!/^[a-f0-9]{32,128}$/.test(deviceId)) return no(400, 'Cihaz kimliği geçersiz.');
  const deviceName = String(b.device_name || '').replace(/[\u0000-\u001f]/g, '').slice(0, 100) || 'Bilinmeyen cihaz';
  const tr = mailTransport(env);
  if (!tr) return no(503, 'Deneme şu an verilemiyor (e-posta gönderimi kapalı). NİS destek: 0551 600 77 87.', 'unavailable');
  if (!env.PANEL_ENC_KEY) return no(503, 'Lisans hizmeti hazır değil.', 'unavailable');

  const ipCount = await first(env, 'SELECT COUNT(*) AS n FROM trials WHERE ip = ? AND last_sent_at > ?', cl.ip || '', t - 86400);
  if (ipCount && ipCount.n >= TRIAL.PER_IP_DAY) return no(429, 'Bugün bu bağlantıdan çok fazla deneme istendi. Yarın tekrar deneyin.', 'rate_limited');

  const byEmail = await first(env, 'SELECT tr.*, l.key_enc, l.ends_at, l.status, (SELECT COUNT(*) FROM activations a WHERE a.license_id = l.id) AS used FROM trials tr JOIN licenses l ON l.id = tr.license_id WHERE tr.product = ? AND tr.email = ?', product, email);
  if (byEmail) {
    // Anahtar henüz hiçbir cihazda kullanılmadıysa aynı e-postaya yeniden gönderilir (aynı sunucu, süre dolmamış)
    if (!byEmail.used && byEmail.device_id === deviceId && byEmail.ends_at > t && byEmail.sent_count < TRIAL.MAX_SENDS) {
      const key = await decryptText(env.PANEL_ENC_KEY, byEmail.key_enc);
      try { await tr.send(keyMail(env, email, byEmail.company, key, byEmail.ends_at, BY_PREFIX[product].name)); }
      catch { return no(502, 'E-posta gönderilemedi; birkaç dakika sonra tekrar deneyin.', 'mail_failed'); }
      await run(env, 'UPDATE trials SET sent_count = sent_count + 1, last_sent_at = ?, ip = ? WHERE id = ?', t, cl.ip || '', byEmail.id);
      return json({ ok: true, resent: true, message: `Deneme anahtarınız ${email} adresine yeniden gönderildi.` });
    }
    return no(409, 'Bu e-posta adresiyle deneme daha önce alınmış. Satın almak için: 0551 600 77 87 · info@ozkandemir.net', 'trial_used');
  }
  const byDevice = await first(env, 'SELECT tr.*, l.key_enc, l.ends_at, (SELECT COUNT(*) FROM activations a WHERE a.license_id = l.id) AS used FROM trials tr JOIN licenses l ON l.id = tr.license_id WHERE tr.product = ? AND tr.device_id = ?', product, deviceId);
  if (byDevice && !byDevice.used && byDevice.ends_at > t && byDevice.sent_count < TRIAL.MAX_SENDS) {
    // E-posta yanlış yazıldıysa: anahtar henüz kullanılmadı → aynı sunucunun düzeltilmiş adresine gönderilir (eski adres geçersiz)
    const key = await decryptText(env.PANEL_ENC_KEY, byDevice.key_enc);
    try { await tr.send(keyMail(env, email, byDevice.company, key, byDevice.ends_at, BY_PREFIX[product].name)); }
    catch { return no(502, 'E-posta gönderilemedi. Adresi kontrol edip tekrar deneyin.', 'mail_failed'); }
    await run(env, 'UPDATE trials SET email = ?, sent_count = sent_count + 1, last_sent_at = ?, ip = ? WHERE id = ?', email, t, cl.ip || '', byDevice.id);
    await run(env, 'UPDATE licenses SET email = ?, updated_at = ? WHERE id = ?', email, t, byDevice.license_id);
    await event(env, byDevice.license_id, 'Düzenlendi', `Deneme e-postası düzeltildi: ${byDevice.email} → ${email}`, cl);
    return json({ ok: true, resent: true, message: `Deneme anahtarınız ${email} adresine gönderildi.` });
  }
  if (byDevice) {
    return no(409, 'Bu sunucuda deneme daha önce kullanılmış. Satın almak için: 0551 600 77 87 · info@ozkandemir.net', 'trial_used');
  }

  const slug = Object.keys(PRODUCTS).find((s) => PRODUCTS[s].prefix === product);
  const prog = await first(env, 'SELECT id, name FROM programs WHERE slug = ?', slug);
  if (!prog) return no(503, 'Lisans hizmeti hazır değil.', 'unavailable');
  const cfg = PRODUCTS[slug];
  const limits = Object.fromEntries(cfg.limits.map((l) => [l.key, l.def]));
  limits.deneme = 1;
  const modules = cfg.modules.filter((m) => m.def).map((m) => m.key);
  let key, hash;
  for (let i = 0; i < 5; i++) {
    key = generateKey(product);
    hash = await keyHash(key);
    if (!(await first(env, 'SELECT id FROM licenses WHERE key_hash = ?', hash))) break;
  }
  const endsAt = t + TRIAL.DAYS * 86400;
  const ins = await run(env,
    "INSERT INTO licenses (program_id, key_hash, key_enc, key_mask, customer, email, phone, starts_at, ends_at, max_devices, limits_json, modules_json, note, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'active', ?, ?)",
    prog.id, hash, await encryptText(env.PANEL_ENC_KEY, key), maskKey(key), company, email, phone || null,
    t, endsAt, JSON.stringify(limits), JSON.stringify(modules), `7 günlük deneme (siteden)${name ? ' · ' + name : ''}`, t, t);
  const licenseId = ins.meta.last_row_id;
  try {
    await run(env, 'INSERT INTO trials (product, email, device_id, device_name, company, contact_name, phone, license_id, ip, sent_count, created_at, last_sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
      product, email, deviceId, deviceName, company, name || null, phone || null, licenseId, cl.ip || '', t, t);
  } catch {
    // aynı anda iki istek: ikincisi geri alınır
    await run(env, 'DELETE FROM licenses WHERE id = ?', licenseId);
    return no(409, 'Bu e-posta adresiyle deneme daha önce alınmış.', 'trial_used');
  }
  await event(env, licenseId, 'Oluşturuldu', `7 günlük deneme · ${email} · ${deviceName}`, cl);
  try {
    await tr.send(keyMail(env, email, company, key, endsAt, prog.name));
  } catch {
    await run(env, 'DELETE FROM trials WHERE license_id = ?', licenseId);
    await run(env, 'DELETE FROM license_events WHERE license_id = ?', licenseId);
    await run(env, 'DELETE FROM licenses WHERE id = ?', licenseId);
    return no(502, 'E-posta gönderilemedi. Adresi kontrol edip tekrar deneyin.', 'mail_failed');
  }
  try { await tr.send(ownerMail(env, { company, name, email, phone, deviceName, endsAt, program: prog.name })); } catch { /* bildirim gitmese de deneme geçerli */ }
  return json({ ok: true, message: `Deneme anahtarınız ${email} adresine gönderildi. E-postadaki NPDK-… anahtarını lisans alanına yazın.` });
}
