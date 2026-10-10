// NİS PDKS bordro parametreleri — public/pdks/parametreler.json üretir.
// Temel değerler sitedeki public/params-2026.js dosyasından alınır (tek kaynak); bordroya özel ekler burada.
// Kullanım: node scripts/pdks-parametreler.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = createRequire(import.meta.url)(path.join(ROOT, 'public/params-2026.js'));
const r2 = (x) => Math.round((x + 1e-9) * 100) / 100;

// Ücret gelir vergisi tarifesi (kümülatif matrah) — Infinity JSON'a null yazılır
const dilimler = P.tax.wage.map(([ust, oran]) => ({ ust_sinir: Number.isFinite(ust) ? ust : null, oran }));
function vergi(kumulatif) {
  let kalan = kumulatif, alt = 0, t = 0;
  for (const { ust_sinir, oran } of dilimler) {
    const ust = ust_sinir ?? Infinity;
    const dilim = Math.min(kalan, ust - alt);
    if (dilim <= 0) break;
    t += dilim * oran; kalan -= dilim; alt = ust;
  }
  return t;
}

// Asgari ücret gelir vergisi istisnası: aylara göre (kümülatif matrah nedeniyle aydan aya değişir)
const asgariMatrah = r2(P.minGross * (1 - P.employeeSgkRate - P.employeeUnemploymentRate));
const ayAdlari = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const gvIstisna = ayAdlari.map((ad, i) => ({
  ay: i + 1, ad,
  matrah: asgariMatrah,
  kumulatif_matrah: r2(asgariMatrah * (i + 1)),
  istisna_tutari: r2(vergi(asgariMatrah * (i + 1)) - vergi(asgariMatrah * i)),
}));

const data = {
  sema: 'nis-pdks-bordro-parametreleri/1',
  yil: P.year,
  surum: `${P.year}.${P.verifiedAt.replaceAll('-', '')}`,
  guncelleme_tarihi: '2026-10-10',
  dogrulama_tarihi: P.verifiedAt,
  yayinlayan: 'Özkan Demir SMMM — ozkandemir.net',
  uyari: 'Mevzuat değişebilir. Bordro kesinleştirilmeden önce resmi kaynaklarla kontrol edilmelidir.',
  para_birimi: 'TRY',

  asgari_ucret: {
    aylik_brut: P.minGross,
    aylik_net: P.minNet,
    gunluk_brut: r2(P.minGross / 30),
    saatlik_brut: r2(P.minGross / 225),
  },

  sgk: {
    taban_aylik: P.minGross,
    tavan_aylik: P.sgkCeiling,
    taban_gunluk: r2(P.minGross / 30),
    tavan_gunluk: r2(P.sgkCeiling / 30),
    isci_prim_orani: P.employeeSgkRate,
    isci_issizlik_orani: P.employeeUnemploymentRate,
    isveren_prim_orani: {
      indirimsiz: P.employerSgkNoDiscount,
      indirimli_genel: P.employerSgkOther,
      indirimli_imalat: P.employerSgkManufacturing,
    },
    isveren_issizlik_orani: P.employerUnemploymentRate,
  },

  gelir_vergisi: {
    ucret_tarifesi: dilimler,
    asgari_ucret_istisnasi: {
      aciklama: 'Asgari ücrete isabet eden gelir vergisi istisnası; kümülatif matrah nedeniyle aya göre değişir.',
      aylik: gvIstisna,
    },
    engellilik_indirimi_aylik: { derece_1: 12000, derece_2: 7000, derece_3: 3000 },
  },

  damga_vergisi: {
    oran: P.stampRate,
    asgari_ucret_istisnasi_aylik: r2(P.minGross * P.stampRate),
  },

  istisnalar: {
    yemek: {
      gelir_vergisi_gunluk: 300,
      yemek_karti_kdv_dahil_gunluk: 330,
      sgk_gunluk: [
        { baslangic: '2026-01-01', bitis: '2026-04-16', yontem: 'gunluk_brut_asgari_ucret_orani', oran: 0.2365, tutar: r2((P.minGross / 30) * 0.2365) },
        { baslangic: '2026-04-17', bitis: null, yontem: 'sabit', tutar: 300 },
      ],
      aciklama: 'Fiilen çalışılan gün başına. SGK tutarı 2026/12 sayılı SGK Genelgesi ile 17.04.2026 itibarıyla günlük 300 TL.',
    },
    yol: {
      gelir_vergisi_gunluk: 158,
      aciklama: 'Toplu taşıma bileti/kartı veya bu amaçla ödenen bedel; fiilen çalışılan gün başına.',
    },
  },

  kidem_tazminati_tavani: [
    { baslangic: '2026-01-01', bitis: '2026-06-30', tutar: 64948.77 },
    { baslangic: '2026-07-01', bitis: '2026-12-31', tutar: P.severanceCeiling },
  ],

  calisma_suresi: {
    haftalik_saat: 45,
    gunluk_saat: 7.5,
    aylik_saat: 225,
    aylik_gun: 30,
    fazla_calisma_carpani: 1.5,
    fazla_surelerle_calisma_carpani: 1.25,
    genel_tatil_calisma_carpani: 2.0,
    yillik_fazla_calisma_ust_siniri_saat: 270,
    aciklama: '4857 sayılı İş Kanunu md. 41, 47, 63. Genel tatil çarpanı, çalışılan gün için toplam ödemeyi (1 + 1 günlük ek) ifade eder.',
  },

  kaynaklar: [
    'Asgari ücret, SGK taban/tavan ve prim oranları: SGK ve Çalışma ve Sosyal Güvenlik Bakanlığı duyuruları',
    'Gelir vergisi tarifesi, yemek/yol istisnası ve engellilik indirimi: 31.12.2025 tarihli Resmî Gazete (5. mükerrer) ile yayımlanan Gelir Vergisi Genel Tebliğleri',
    'SGK yemek bedeli istisnası: 2026/12 sayılı SGK Genelgesi',
    'Kıdem tazminatı tavanı: Hazine ve Maliye Bakanlığı memur maaş katsayısı genelgeleri',
  ],
};

const out = path.join(ROOT, 'public/pdks/parametreler.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(data, null, 2) + '\n');
console.log('yazıldı:', path.relative(ROOT, out));
