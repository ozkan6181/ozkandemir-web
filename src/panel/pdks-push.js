// NİS PDKS Android uygulaması anlık bildirim aracısı (Firebase Cloud Messaging HTTP v1).
// Müşteri sunucuları Firebase'e doğrudan bağlanmaz; lisans kimliğiyle /pdks-api/api.php'ye { a: 'app_push', messages: [...] }
// gönderir, bu modül Firebase'e iletir. Firebase hizmet hesabı anahtarı YALNIZ Cloudflare gizli değişkeninde durur:
//   FCM_SERVICE_ACCOUNT = Firebase Console › Proje ayarları › Hizmet hesapları › "Yeni özel anahtar oluştur" JSON'unun tamamı
// Yanıt: { ok: true, results: [{ status: 'ok' | 'invalid' | 'error' }] }  (sıra = gelen mesaj sırası)

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const MAX = 100;
let cached = { key: '', token: '', exp: 0 };

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlStr = (s) => b64url(new TextEncoder().encode(s));

function pemToDer(pem) {
  const body = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0)).buffer;
}

async function accessToken(sa) {
  const nowS = Math.floor(Date.now() / 1000);
  if (cached.key === sa.client_email && cached.exp - 120 > nowS) return cached.token;
  const header = b64urlStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64urlStr(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: nowS, exp: nowS + 3600 }));
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claim}`));
  const r = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${header}.${claim}.${b64url(sig)}`,
  });
  if (!r.ok) throw new Error(`Firebase oturumu alınamadı (${r.status})`);
  const j = await r.json();
  cached = { key: sa.client_email, token: j.access_token, exp: nowS + Number(j.expires_in || 3600) };
  return cached.token;
}

const clip = (v, n) => String(v ?? '').slice(0, n);

async function sendOne(projectId, bearer, m) {
  const token = clip(m && m.token, 4096);
  if (!/^[A-Za-z0-9:_\-]{20,4096}$/.test(token)) return { status: 'invalid' };
  const body = {
    message: {
      token,
      data: { title: clip(m.title, 200), body: clip(m.body, 900), url: clip(m.url || '/dashboard', 500), tag: clip(m.tag || 'pdks', 64) },
      android: { priority: 'high', ttl: '86400s' },
    },
  };
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (r.ok) return { status: 'ok' };
  let code = '';
  try { const j = await r.json(); code = (j.error && (j.error.details || []).map((d) => d.errorCode).find(Boolean)) || j.error?.status || ''; } catch { /* yok */ }
  if (r.status === 404 || code === 'UNREGISTERED' || code === 'INVALID_ARGUMENT') return { status: 'invalid' };
  return { status: 'error' };
}

/** who: identify() sonucu (lisans doğrulandı). */
export async function handleAppPush(env, body, who) {
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  if (!env.FCM_SERVICE_ACCOUNT) return json({ ok: false, error: 'Anlık bildirim hizmeti henüz kurulmadı.' }, 503);
  let sa;
  try { sa = JSON.parse(env.FCM_SERVICE_ACCOUNT); } catch { return json({ ok: false, error: 'Bildirim hizmeti ayarı bozuk.' }, 503); }
  const msgs = Array.isArray(body.messages) ? body.messages.slice(0, MAX) : [];
  if (!msgs.length) return json({ ok: true, results: [] });
  let bearer;
  try { bearer = await accessToken(sa); } catch (e) { return json({ ok: false, error: String(e.message || e) }, 502); }
  const results = new Array(msgs.length);
  let i = 0;
  const worker = async () => { while (i < msgs.length) { const k = i++; try { results[k] = await sendOne(sa.project_id, bearer, msgs[k]); } catch { results[k] = { status: 'error' }; } } };
  await Promise.all(Array.from({ length: Math.min(8, msgs.length) }, worker));
  return json({ ok: true, results });
}
