// NİS PDKS bordro parametreleri — public/pdks/parametreler.json (varsayılan, statik) dosyasını üretir.
// Panelden yayın yapılınca site bu dosya yerine veritabanındaki güncel değerleri sunar.
// Temel değerler public/params-2026.js dosyasından alınır; hesaplama src/panel/bordro.js ile ortaktır.
// Kullanım: node scripts/pdks-parametreler.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { cleanBase, buildPayroll } from '../src/panel/bordro.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = createRequire(import.meta.url)(path.join(ROOT, 'public/params-2026.js'));
const tarife = (list) => list.map(([ust, oran]) => [Number.isFinite(ust) ? ust : null, oran]);

export const DEFAULT_BASE = cleanBase({
  yil: P.year,
  dogrulama_tarihi: P.verifiedAt,
  asgari_brut: P.minGross,
  sgk_tavan_kat: Math.round((P.sgkCeiling / P.minGross) * 100) / 100,
  isci_sgk: P.employeeSgkRate,
  isci_issizlik: P.employeeUnemploymentRate,
  isveren_sgk_indirimsiz: P.employerSgkNoDiscount,
  isveren_sgk_genel: P.employerSgkOther,
  isveren_sgk_imalat: P.employerSgkManufacturing,
  isveren_issizlik: P.employerUnemploymentRate,
  damga_orani: P.stampRate,
  ucret_dilimleri: tarife(P.tax.wage),
  genel_dilimleri: tarife(P.tax.general),
  engelli: [12000, 7000, 3000],
  yemek_gv: 300,
  yemek_karti: 330,
  yemek_sgk: [
    { baslangic: '2026-01-01', bitis: '2026-04-16', yontem: 'gunluk_brut_asgari_ucret_orani', oran: 0.2365 },
    { baslangic: '2026-04-17', bitis: null, yontem: 'sabit', tutar: 300 },
  ],
  yol_gv: 158,
  kidem: [
    { baslangic: '2026-01-01', bitis: '2026-06-30', tutar: 64948.77 },
    { baslangic: '2026-07-01', bitis: '2026-12-31', tutar: P.severanceCeiling },
  ],
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const data = buildPayroll(DEFAULT_BASE, { guncelleme_tarihi: '2026-10-10', surum_tarihi: P.verifiedAt });
  const out = path.join(ROOT, 'public/pdks/parametreler.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(data, null, 2) + '\n');
  console.log('yazıldı:', path.relative(ROOT, out));
}
