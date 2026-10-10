// Mali takvim abonelik dosyası: public/params-2026.js içindeki tarihlerden public/mali-takvim.ics üretir.
// Google / Outlook / iPhone takvimine "abone olunan takvim" olarak eklenir; dosya güncellenince takvimler kendiliğinden yenilenir.
// Kullanım: node scripts/takvim-ics.mjs   (tests/test-pdks-params.mjs dosyanın güncel olduğunu denetler)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CAT = { tax: 'Vergi', sgk: 'SGK', ebook: 'e-Defter' };

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// RFC 5545: satırlar en fazla 75 bayt; devam satırı boşlukla başlar (UTF-8 karakter bölünmez)
function fold(line) {
  const out = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export function buildIcs(P) {
  const stamp = P.verifiedAt.replaceAll('-', '') + 'T000000Z';
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ozkandemir.net//Mali Takvim//TR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:Mali Takvim — Özkan Demir SMMM', 'X-WR-TIMEZONE:Europe/Istanbul',
    'X-WR-CALDESC:GİB ve SGK kaynaklı beyan ve ödeme tarihleri. Her yükümlülük her mükellefi kapsamayabilir.',
    'REFRESH-INTERVAL;VALUE=DURATION:P1D', 'X-PUBLISHED-TTL:P1D',
  ];
  for (const d of [...P.deadlines].sort((a, b) => a.date.localeCompare(b.date))) {
    const day = d.date.replaceAll('-', '');
    const next = new Date(Date.parse(d.date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10).replaceAll('-', '');
    const uid = crypto.createHash('sha1').update(d.date + '|' + d.title).digest('hex').slice(0, 20) + '@ozkandemir.net';
    lines.push('BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${next}`,
      `SUMMARY:${esc(`${CAT[d.cat] || 'Mali takvim'}: ${d.title}`)}`,
      `DESCRIPTION:${esc(`${d.detail}\nKaynak: ${d.source}\nGüncel takvim: https://www.ozkandemir.net/muhasebe-merkezi.html#mali-takvim`)}`,
      `CATEGORIES:${esc(CAT[d.cat] || 'Mali takvim')}`, 'TRANSP:TRANSPARENT', 'URL:https://www.ozkandemir.net/muhasebe-merkezi.html#mali-takvim',
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc('Yarın: ' + d.title)}`, 'TRIGGER:-PT15H', 'END:VALARM',
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const P = createRequire(import.meta.url)(path.join(ROOT, 'public/params-2026.js'));
  fs.writeFileSync(path.join(ROOT, 'public/mali-takvim.ics'), buildIcs(P));
  console.log('yazıldı: public/mali-takvim.ics', P.deadlines.length, 'tarih');
}
