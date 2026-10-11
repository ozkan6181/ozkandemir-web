// ozkandemir.net V3.9 — Program içi destek soruları ("Cevabımı bulamadım")
//
// NİS PDKS → POST /pdks-api/api.php {a:'support_question', question, contact, page, user_type, lang, search,
//                                     asked_at, app_version, + lisans kimliği}
// Soru önce veritabanına yazılır (kaybolmaz), sonra destek adresine e-posta olarak gider.
// E-posta: Resend (gizli değişken RESEND_API_KEY, ücretsiz paket) varsa onunla; yoksa Cloudflare Email Service
// bağlaması SUPPORT_MAIL (Workers Paid gerektirir). Alıcı SUPPORT_EMAIL
// (varsayılan info@ozkandemir.net), gönderen SUPPORT_FROM (varsayılan destek@ozkandemir.net).
// Gönderilemeyen e-postalar her yeni soruda ve günlük zamanlanmış görevde yeniden denenir; panelde "Destek soruları"
// kartında her durumda görünür.
// Personel / puantaj verisi gelmez: yalnız soru metni, isteğe bağlı iletişim bilgisi ve hangi ekrandan sorulduğu.
import { json, fail, first, all, run, readJson, audit } from './common.js';

export const SUPPORT = {
  TO: 'info@ozkandemir.net',
  FROM: 'destek@ozkandemir.net',
  MIN: 10, MAX: 1500, MAX_CONTACT: 150,
  PER_MACHINE_DAY: 30,      // programın kendi sınırı kurulum başına 50/gün; site tarafında makine başına 30
  MAX_TRIES: 8,
};

const clip = (v, n) => String(v ?? '').replace(/\u0000/g, '').trim().slice(0, n);
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const USER_TYPE = { personel: 'Personel', yonetici: 'Yönetici' };

async function sha(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const fmt = (t) => new Date((t + 3 * 3600) * 1000).toISOString().slice(0, 16).replace('T', ' ');

// ---------- e-posta ----------
export function mailFor(q, env) {
  const contact = q.contact || '';
  const lines = [
    `Müşteri: ${q.customer}${q.license_state && q.license_state !== 'active' ? ` (lisans: ${q.license_state})` : ''}`,
    `Program: ${q.program} ${q.app_version || ''}`.trim(),
    `Soran: ${USER_TYPE[q.user_type] || q.user_type || '-'}  ·  Dil: ${q.lang || 'tr'}`,
    `Ekran: ${q.page || '-'}`,
    q.search ? `Yardımda aranan: ${q.search}` : null,
    `İletişim: ${contact || '(yazılmadı)'}`,
    `Soru zamanı: ${q.asked_at || fmt(q.received_at)}  ·  Sunucu: ${q.host || '-'}`,
    '',
    'Soru:',
    q.question,
    '',
    '—',
    `Panel › Programlar › Destek soruları (#${q.id}). Yanıtı müşterinin iletişim bilgisine verin;` +
      ' bu e-postayı yanıtlarsanız' + (EMAIL_RE.test(contact) ? ' doğrudan soran kişiye gider.' : ' müşteriye gitmez (iletişim e-posta değil).'),
  ].filter((x) => x !== null);
  const msg = {
    from: { email: env.SUPPORT_FROM || SUPPORT.FROM, name: 'NİS PDKS Destek' },
    to: env.SUPPORT_EMAIL || SUPPORT.TO,
    subject: `[NİS PDKS Destek #${q.id}] ${q.customer} — ${q.question.replace(/\s+/g, ' ').slice(0, 60)}`,
    text: lines.join('\n'),
  };
  if (EMAIL_RE.test(contact)) msg.replyTo = contact;
  return msg;
}

// Resend HTTP API: yalnızca gönderme yetkili anahtar; posta kutusu şifresi gerekmez
async function resendSend(key, m) {
  let r;
  try {
    r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: `${m.from.name} <${m.from.email}>`, to: [m.to], subject: m.subject, text: m.text,
        ...(m.replyTo ? { reply_to: m.replyTo } : {}),
      }),
    });
  } catch (e) {
    const err = new Error('Resend sunucusuna bağlanılamadı'); err.code = 'RESEND_NETWORK'; throw err;
  }
  if (!r.ok) {
    let d = {};
    try { d = await r.json(); } catch {}
    const err = new Error(d.message || `HTTP ${r.status}`); err.code = d.name || `HTTP_${r.status}`; throw err;
  }
}

export function mailTransport(env) {
  if (env.RESEND_API_KEY) return { name: 'Resend', send: (m) => resendSend(env.RESEND_API_KEY, m) };
  if (env.SUPPORT_MAIL && typeof env.SUPPORT_MAIL.send === 'function') return { name: 'Cloudflare', send: (m) => env.SUPPORT_MAIL.send(m) };
  return null;
}

async function deliver(env, q) {
  const tr = mailTransport(env);
  if (!tr) {
    await run(env, "UPDATE support_questions SET mail_error = ? WHERE id = ?", 'E-posta gönderimi kurulmadı (RESEND_API_KEY veya SUPPORT_MAIL yok)', q.id);
    return false;
  }
  try {
    await tr.send(mailFor(q, env));
    await run(env, "UPDATE support_questions SET mail_state = 'sent', mail_error = NULL, mail_tries = mail_tries + 1 WHERE id = ?", q.id);
    return true;
  } catch (e) {
    const err = clip(`${e && e.code ? e.code + ': ' : ''}${e && e.message ? e.message : e}`, 300);
    await run(env, "UPDATE support_questions SET mail_state = CASE WHEN mail_tries + 1 >= ? THEN 'failed' ELSE 'pending' END, mail_error = ?, mail_tries = mail_tries + 1 WHERE id = ?",
      SUPPORT.MAX_TRIES, err, q.id);
    return false;
  }
}

// Bekleyen e-postaları yeniden dener (yeni soru geldiğinde ve günlük zamanlanmış görevde)
export async function retrySupportMail(env, limit = 20) {
  if (!env.DB || !mailTransport(env)) return 0;
  const rows = await all(env, "SELECT * FROM support_questions WHERE mail_state = 'pending' ORDER BY id LIMIT ?", limit);
  let sent = 0;
  for (const q of rows) if (await deliver(env, q)) sent++;
  return sent;
}

// ---------- programdan gelen soru ----------
// ident: pdks-updates.js kimlik sonucu {kind, customer, id|lid, licenseState}
export async function receiveSupportQuestion(env, body, ident, t) {
  const question = clip(body.question, SUPPORT.MAX + 10);
  if (question.length < SUPPORT.MIN) return json({ ok: false, error: 'Soru çok kısa.' }, 400);
  if (question.length > SUPPORT.MAX) return json({ ok: false, error: 'Soru çok uzun.' }, 400);
  const contact = clip(body.contact, SUPPORT.MAX_CONTACT + 10);
  if (contact.length > SUPPORT.MAX_CONTACT) return json({ ok: false, error: 'İletişim bilgisi çok uzun.' }, 400);
  const machine = clip(body.machine, 80);
  const askedAt = clip(body.asked_at, 25);
  const dedupe = await sha([ident.kind, ident.id || ident.lid || '', machine, askedAt, question].join('\u0001'));
  const dup = await first(env, 'SELECT id FROM support_questions WHERE dedupe = ?', dedupe);
  if (dup) return json({ ok: true, id: dup.id, duplicate: true, message: 'Sorunuz daha önce alınmış.' });
  const today = await first(env, 'SELECT COUNT(*) AS n FROM support_questions WHERE machine = ? AND received_at > ?', machine, t - 86400);
  if (today && today.n >= SUPPORT.PER_MACHINE_DAY) return json({ ok: false, error: 'Bugün için soru sınırına ulaşıldı.' }, 429);
  const userType = body.user_type === 'yonetici' ? 'yonetici' : 'personel';
  await run(env,
    `INSERT OR IGNORE INTO support_questions (program, customer, license_ref, license_state, machine, host, app_version, user_type, lang, page, search,
       question, contact, asked_at, dedupe, received_at) VALUES ('NİS PDKS', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    clip(ident.customer, 120), String(ident.kind === 'odl' ? `panel #${ident.lid}` : `lic ${ident.id || '-'}`).slice(0, 60),
    ident.licenseState || 'active', machine, clip(body.host, 80), clip(body.app_version || body.version, 20), userType,
    clip(body.lang, 5) || 'tr', clip(body.page, 120), clip(body.search, 200), question, contact, askedAt, dedupe, t);
  const q = await first(env, 'SELECT * FROM support_questions WHERE dedupe = ?', dedupe);
  // E-posta hatası soruyu düşürmez: kayıt panelde durur, e-posta sonra yeniden denenir
  try { await deliver(env, q); await retrySupportMail(env, 5); } catch { /* panelde görünür */ }
  return json({ ok: true, id: q ? q.id : null, message: 'Sorunuz NİS destek ekibine iletildi.' });
}

// ---------- panel ----------
export async function listSupport(c) {
  const url = new URL(c.req.url);
  const showAll = url.searchParams.get('hepsi') === '1';
  const rows = await all(c.env,
    `SELECT id, customer, license_state, app_version, user_type, lang, page, search, question, contact, asked_at, received_at,
            mail_state, mail_error, answered_at FROM support_questions ${showAll ? '' : 'WHERE answered_at IS NULL'}
     ORDER BY received_at DESC LIMIT 100`);
  const open = await first(c.env, 'SELECT COUNT(*) AS n FROM support_questions WHERE answered_at IS NULL');
  return json({
    open: open ? open.n : 0,
    mailReady: Boolean(mailTransport(c.env)),
    mailVia: mailTransport(c.env) ? mailTransport(c.env).name : null,
    to: c.env.SUPPORT_EMAIL || SUPPORT.TO,
    list: rows.map((r) => ({ ...r, received: fmt(r.received_at), answered: r.answered_at ? fmt(r.answered_at) : null,
      contactIsEmail: EMAIL_RE.test(r.contact || '') })),
  });
}

export async function answerSupport(c, [, id]) {
  const b = (await readJson(c.req)) || {};
  const q = await first(c.env, 'SELECT id, answered_at FROM support_questions WHERE id = ?', Number(id));
  if (!q) return fail(404, 'Soru bulunamadı.');
  const reopen = b.reopen === true;
  await run(c.env, 'UPDATE support_questions SET answered_at = ? WHERE id = ?', reopen ? null : c.t, q.id);
  return json({ ok: true });
}

// Panel: deneme e-postası (alıcı sabit; dakikada en fazla bir kez). Bekleyen soruları da hemen yeniden dener.
export async function testSupportMail(c) {
  const tr = mailTransport(c.env);
  if (!tr) return fail(400, 'E-posta gönderimi kurulmadı: Cloudflare\'de RESEND_API_KEY gizli değişkeni yok.');
  const last = await first(c.env, "SELECT value FROM settings WHERE name = 'support_test_at'");
  if (last && c.t - Number(last.value) < 60) return fail(429, 'Bir dakika içinde tekrar deneyin.');
  await run(c.env, "INSERT INTO settings (name, value, updated_at) VALUES ('support_test_at', ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", String(c.t), c.t);
  const to = c.env.SUPPORT_EMAIL || SUPPORT.TO;
  try {
    await tr.send({
      from: { email: c.env.SUPPORT_FROM || SUPPORT.FROM, name: 'NİS PDKS Destek' },
      to,
      subject: '[NİS PDKS Destek] Deneme e-postası',
      text: `Bu bir deneme e-postasıdır (${fmt(c.t)}).\n\nozkandemir.net panelinden gönderildi. Bu e-posta geldiyse programlardan gelen destek soruları da ${to} adresine gelecek.\n\nGönderim: ${tr.name}`,
    });
  } catch (e) {
    return fail(502, `Gönderilemedi: ${clip(`${e && e.code ? e.code + ' — ' : ''}${e && e.message ? e.message : e}`, 200)}`);
  }
  let retried = 0;
  try { retried = await retrySupportMail(c.env, 20); } catch { /* yok say */ }
  await audit(c, 'Destek', `Deneme e-postası gönderildi (${tr.name} → ${to})`);
  return json({ ok: true, to, via: tr.name, retried });
}
