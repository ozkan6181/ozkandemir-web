// ozkandemir.net V3.8 — Resmi kaynak takibi (günde bir kez, Cloudflare zamanlanmış görevi)
// Sitenin "Güncel Mevzuat" bölümünün zaten okuduğu GİB, SGK ve Resmî Gazete sayfalarını tarar;
// bordro parametrelerini etkileyebilecek başlıkları panelde uyarı olarak gösterir.
// Değerleri KENDİSİ DEĞİŞTİRMEZ: kararı ve yayını yönetici verir.
import { run, first } from './common.js';
import { now } from './security.js';

export const SOURCES = [
  { key: 'GİB', url: 'https://www.gib.gov.tr/mevzuat', base: 'https://www.gib.gov.tr/' },
  { key: 'SGK', url: 'https://www.sgk.gov.tr/duyuru', base: 'https://www.sgk.gov.tr/' },
  { key: 'Resmî Gazete', url: 'https://www.resmigazete.gov.tr/', base: 'https://www.resmigazete.gov.tr/' },
];

// Türkçe büyük/küçük harf duyarsız karşılaştırma için
export const trLower = (s) => String(s || '').replace(/İ/g, 'i').replace(/I/g, 'ı').toLowerCase();

export const KEYWORDS = [
  ['asgari ücret', 'Asgari ücret'],
  ['gelir vergisi genel tebliğ', 'Gelir vergisi tebliği'],
  ['gelir vergisi kanunu', 'Gelir Vergisi Kanunu'],
  ['damga vergisi', 'Damga vergisi'],
  ['prime esas kazanç', 'SGK prime esas kazanç'],
  ['prim oran', 'SGK prim oranı'],
  ['sigorta prim', 'SGK primi'],
  ['yemek bedel', 'Yemek bedeli'],
  ['yemek yardım', 'Yemek bedeli'],
  ['kıdem tazminat', 'Kıdem tazminatı'],
  ['maaş katsayı', 'Memur maaş katsayısı'],
  ['engellilik indirim', 'Engellilik indirimi'],
  ['yol bedel', 'Yol bedeli'],
  ['toplu taşıma', 'Yol bedeli'],
  ['5510 sayılı', '5510 sayılı Kanun'],
  ['4857 sayılı', 'İş Kanunu'],
  ['193 sayılı', 'Gelir Vergisi Kanunu'],
  ['işveren hissesi', 'İşveren primi'],
  ['prim desteğ', 'Prim desteği'],
  ['prim teşvik', 'Prim teşviki'],
];

const cp = (n) => (Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ');
const decode = (s) => String(s || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => cp(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => cp(Number(d)))
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ').trim();

export function findMatches(html, src) {
  const out = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 40) {
    const title = decode(m[2]);
    if (title.length < 12 || title.length > 300) continue;
    const low = trLower(title);
    const hit = KEYWORDS.find(([k]) => low.includes(k));
    if (!hit || out.some((x) => x.title === title)) continue;
    let url;
    try { url = new URL(m[1], src.base).toString(); } catch { continue; }
    if (!/^https:\/\//.test(url)) continue;
    out.push({ source: src.key, title, url, keyword: hit[1] });
  }
  return out;
}

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; ozkandemir.net mevzuat takibi)', accept: 'text/html,*/*' }, cf: { cacheTtl: 600 } });
  if (!r.ok) throw new Error(`${r.status}`);
  const buf = await r.arrayBuffer();
  const ct = r.headers.get('content-type') || '';
  const cs = (ct.match(/charset=([\w-]+)/i) || [])[1] || 'utf-8';
  try { return new TextDecoder(cs).decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}

// fetcher test için değiştirilebilir
export async function runWatch(env, fetcher = fetchText) {
  const t = now();
  // Bir kaynak ilk kez okunduğunda sayfada zaten duran eski başlıklar uyarı sayılmaz (yalnızca kayda alınır)
  const prev = await watchStatus(env);
  const seen = new Set((prev && (prev.seen || prev.checked)) || []);
  const firstRun = !prev;
  const result = { checked: [], failed: [], found: 0, firstRun, seen: [] };
  for (const src of SOURCES) {
    try {
      const html = await fetcher(src.url);
      const hits = findMatches(html, src);
      const baseline = !seen.has(src.key);
      for (const h of hits) {
        const r = await run(env, 'INSERT OR IGNORE INTO source_alerts (source, title, url, keyword, found_at, dismissed_at) VALUES (?, ?, ?, ?, ?, ?)',
          h.source, h.title.slice(0, 300), h.url.slice(0, 500), h.keyword, t, baseline ? t : null);
        if (r.meta && r.meta.changes && !baseline) result.found++;
      }
      result.checked.push(src.key);
      seen.add(src.key);
    } catch (e) {
      result.failed.push(`${src.key} (${String(e && e.message || e).slice(0, 60)})`);
    }
  }
  result.seen = [...seen];
  await run(env, 'INSERT INTO settings (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    'watch_status', JSON.stringify(result), t);
  // Eski (400 günden eski ve kapatılmış) uyarıları temizle
  await run(env, 'DELETE FROM source_alerts WHERE dismissed_at IS NOT NULL AND found_at < ?', t - 400 * 86400);
  return result;
}

export async function watchStatus(env) {
  const r = await first(env, "SELECT value, updated_at FROM settings WHERE name = 'watch_status'");
  return r ? { ...JSON.parse(r.value), at: r.updated_at } : null;
}
