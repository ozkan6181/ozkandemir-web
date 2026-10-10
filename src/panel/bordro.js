// ozkandemir.net V3.8 — Bordro parametreleri
// Tek kaynak: "temel değerler" (base) panelden girilir; SGK tabanı/tavanı, günlük/saatlik ücret,
// asgari ücret gelir ve damga vergisi istisnaları gibi türetilen değerler burada hesaplanır.
// Çıktılar: /pdks/parametreler.json (NİS PDKS) ve sitedeki hesaplama araçlarının PARAM2026 nesnesi.

export const SCHEMA_NAME = 'nis-pdks-bordro-parametreleri/1';

const r2 = (x) => Math.round((x + 1e-9) * 100) / 100;
const AYLAR = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];

export const CALISMA = {
  haftalik_saat: 45,
  gunluk_saat: 7.5,
  aylik_saat: 225,
  aylik_gun: 30,
  fazla_calisma_carpani: 1.5,
  fazla_surelerle_calisma_carpani: 1.25,
  genel_tatil_calisma_carpani: 2.0,
  yillik_fazla_calisma_ust_siniri_saat: 270,
  aciklama: '4857 sayılı İş Kanunu md. 41, 47, 63. Genel tatil çarpanı, çalışılan gün için toplam ödemeyi (1 + 1 günlük ek) ifade eder.',
};

export const KAYNAKLAR = [
  'Asgari ücret, SGK taban/tavan ve prim oranları: SGK ve Çalışma ve Sosyal Güvenlik Bakanlığı duyuruları',
  'Gelir vergisi tarifesi, yemek/yol istisnası ve engellilik indirimi: 31.12.2025 tarihli Resmî Gazete (5. mükerrer) ile yayımlanan Gelir Vergisi Genel Tebliğleri',
  'SGK yemek bedeli istisnası: 2026/12 sayılı SGK Genelgesi',
  'Kıdem tazminatı tavanı: Hazine ve Maliye Bakanlığı memur maaş katsayısı genelgeleri',
];

// ---------- Vergi ----------
function vergi(dilimler, kumulatif) {
  let kalan = kumulatif, alt = 0, t = 0;
  for (const [ust_sinir, oran] of dilimler) {
    const ust = ust_sinir ?? Infinity;
    const dilim = Math.min(kalan, ust - alt);
    if (dilim <= 0) break;
    t += dilim * oran; kalan -= dilim; alt = ust;
  }
  return t;
}

// ---------- Doğrulama ----------
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
function num(v, name, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} geçersiz (${min} – ${max} arası olmalı).`);
  return n;
}
function brackets(list, name) {
  if (!Array.isArray(list) || list.length < 2 || list.length > 8) throw new Error(`${name}: 2–8 dilim olmalı.`);
  let prev = 0;
  return list.map(([ust, oran], i) => {
    const last = i === list.length - 1;
    const u = last ? null : num(ust, `${name} ${i + 1}. dilim üst sınırı`, 1, 1e9);
    if (!last && u <= prev) throw new Error(`${name}: dilim üst sınırları artan olmalı.`);
    if (!last) prev = u;
    return [u, num(oran, `${name} ${i + 1}. dilim oranı`, 0, 0.6)];
  });
}
function periods(list, name, valueKey, max) {
  if (!Array.isArray(list) || !list.length || list.length > 6) throw new Error(`${name}: 1–6 dönem olmalı.`);
  return list.map((p, i) => {
    if (!isDate(p.baslangic)) throw new Error(`${name} ${i + 1}. dönem başlangıç tarihi geçersiz.`);
    if (p.bitis !== null && p.bitis !== undefined && p.bitis !== '' && !isDate(p.bitis)) throw new Error(`${name} ${i + 1}. dönem bitiş tarihi geçersiz.`);
    const out = { baslangic: p.baslangic, bitis: p.bitis || null };
    if (valueKey === 'yemek_sgk') {
      if (p.yontem === 'gunluk_brut_asgari_ucret_orani') { out.yontem = p.yontem; out.oran = num(p.oran, `${name} oranı`, 0, 1); }
      else { out.yontem = 'sabit'; out.tutar = num(p.tutar, `${name} tutarı`, 0, max); }
    } else {
      out.tutar = num(p.tutar, `${name} tutarı`, 0, max);
    }
    return out;
  });
}

// Panelden gelen temel değerleri temizler (hatalıysa açıklamalı hata fırlatır)
export function cleanBase(b) {
  if (!b || typeof b !== 'object') throw new Error('Parametreler okunamadı.');
  const yil = num(b.yil, 'Yıl', 2024, 2100);
  const base = {
    yil,
    dogrulama_tarihi: isDate(b.dogrulama_tarihi) ? b.dogrulama_tarihi : null,
    asgari_brut: num(b.asgari_brut, 'Brüt asgari ücret', 1000, 10000000),
    sgk_tavan_kat: num(b.sgk_tavan_kat, 'SGK tavan katsayısı', 1, 20),
    isci_sgk: num(b.isci_sgk, 'İşçi SGK oranı', 0, 0.5),
    isci_issizlik: num(b.isci_issizlik, 'İşçi işsizlik oranı', 0, 0.1),
    isveren_sgk_indirimsiz: num(b.isveren_sgk_indirimsiz, 'İşveren SGK (indirimsiz)', 0, 0.5),
    isveren_sgk_genel: num(b.isveren_sgk_genel, 'İşveren SGK (genel indirimli)', 0, 0.5),
    isveren_sgk_imalat: num(b.isveren_sgk_imalat, 'İşveren SGK (imalat indirimli)', 0, 0.5),
    isveren_issizlik: num(b.isveren_issizlik, 'İşveren işsizlik oranı', 0, 0.1),
    damga_orani: num(b.damga_orani, 'Damga vergisi oranı', 0, 0.05),
    ucret_dilimleri: brackets(b.ucret_dilimleri, 'Ücret tarifesi'),
    genel_dilimleri: brackets(b.genel_dilimleri, 'Genel tarife'),
    engelli: [0, 1, 2].map((i) => num((b.engelli || [])[i], `${i + 1}. derece engellilik indirimi`, 0, 1000000)),
    yemek_gv: num(b.yemek_gv, 'Yemek istisnası (gelir vergisi)', 0, 100000),
    yemek_karti: num(b.yemek_karti, 'Yemek kartı tutarı', 0, 100000),
    yemek_sgk: periods(b.yemek_sgk, 'SGK yemek istisnası', 'yemek_sgk', 100000),
    yol_gv: num(b.yol_gv, 'Yol istisnası', 0, 100000),
    kidem: periods(b.kidem, 'Kıdem tazminatı tavanı', 'kidem', 100000000),
  };
  if (base.ucret_dilimleri.length !== base.genel_dilimleri.length) throw new Error('Ücret ve genel tarife aynı sayıda dilimden oluşmalı.');
  return base;
}

// ---------- Türetme ----------
export function derived(base) {
  const asgariNet = r2(base.asgari_brut * (1 - base.isci_sgk - base.isci_issizlik));
  return {
    asgari_net: asgariNet,
    gunluk_brut: r2(base.asgari_brut / 30),
    saatlik_brut: r2(base.asgari_brut / 225),
    sgk_taban: base.asgari_brut,
    sgk_tavan: r2(base.asgari_brut * base.sgk_tavan_kat),
    damga_istisnasi: r2(base.asgari_brut * base.damga_orani),
    gv_istisnasi: AYLAR.map((ad, i) => ({
      ay: i + 1, ad,
      matrah: asgariNet,
      kumulatif_matrah: r2(asgariNet * (i + 1)),
      istisna_tutari: r2(vergi(base.ucret_dilimleri, asgariNet * (i + 1)) - vergi(base.ucret_dilimleri, asgariNet * i)),
    })),
  };
}

// NİS PDKS'nin okuduğu dosya
export function buildPayroll(base, meta = {}) {
  const d = derived(base);
  const dogrulama = base.dogrulama_tarihi || meta.guncelleme_tarihi || '';
  return {
    sema: SCHEMA_NAME,
    yil: base.yil,
    surum: `${base.yil}.${String(meta.surum_tarihi || dogrulama).replaceAll('-', '')}`,
    guncelleme_tarihi: meta.guncelleme_tarihi || dogrulama,
    dogrulama_tarihi: dogrulama,
    yayinlayan: 'Özkan Demir SMMM — ozkandemir.net',
    uyari: 'Mevzuat değişebilir. Bordro kesinleştirilmeden önce resmi kaynaklarla kontrol edilmelidir.',
    para_birimi: 'TRY',
    asgari_ucret: {
      aylik_brut: base.asgari_brut,
      aylik_net: d.asgari_net,
      gunluk_brut: d.gunluk_brut,
      saatlik_brut: d.saatlik_brut,
    },
    sgk: {
      taban_aylik: d.sgk_taban,
      tavan_aylik: d.sgk_tavan,
      taban_gunluk: r2(d.sgk_taban / 30),
      tavan_gunluk: r2(d.sgk_tavan / 30),
      isci_prim_orani: base.isci_sgk,
      isci_issizlik_orani: base.isci_issizlik,
      isveren_prim_orani: {
        indirimsiz: base.isveren_sgk_indirimsiz,
        indirimli_genel: base.isveren_sgk_genel,
        indirimli_imalat: base.isveren_sgk_imalat,
      },
      isveren_issizlik_orani: base.isveren_issizlik,
    },
    gelir_vergisi: {
      ucret_tarifesi: base.ucret_dilimleri.map(([ust_sinir, oran]) => ({ ust_sinir, oran })),
      genel_tarife: base.genel_dilimleri.map(([ust_sinir, oran]) => ({ ust_sinir, oran })),
      asgari_ucret_istisnasi: {
        aciklama: 'Asgari ücrete isabet eden gelir vergisi istisnası; kümülatif matrah nedeniyle aya göre değişir.',
        aylik: d.gv_istisnasi,
      },
      engellilik_indirimi_aylik: { derece_1: base.engelli[0], derece_2: base.engelli[1], derece_3: base.engelli[2] },
    },
    damga_vergisi: {
      oran: base.damga_orani,
      asgari_ucret_istisnasi_aylik: d.damga_istisnasi,
    },
    istisnalar: {
      yemek: {
        gelir_vergisi_gunluk: base.yemek_gv,
        yemek_karti_kdv_dahil_gunluk: base.yemek_karti,
        sgk_gunluk: base.yemek_sgk.map((p) => (p.yontem === 'gunluk_brut_asgari_ucret_orani'
          ? { ...p, tutar: r2(d.gunluk_brut * p.oran) }
          : { ...p })),
        aciklama: 'Fiilen çalışılan gün başına. SGK tutarı 2026/12 sayılı SGK Genelgesi ile 17.04.2026 itibarıyla günlük 300 TL.',
      },
      yol: {
        gelir_vergisi_gunluk: base.yol_gv,
        aciklama: 'Toplu taşıma bileti/kartı veya bu amaçla ödenen bedel; fiilen çalışılan gün başına.',
      },
    },
    kidem_tazminati_tavani: base.kidem.map((p) => ({ baslangic: p.baslangic, bitis: p.bitis, tutar: p.tutar })),
    calisma_suresi: { ...CALISMA },
    kaynaklar: [...KAYNAKLAR],
  };
}

// Parametre dosyasından temel değerleri geri çıkarır (veritabanında kayıt yokken panelin başlangıç değerleri)
export function baseFromPayroll(p) {
  const tarife = (list) => list.map((x) => [x.ust_sinir, x.oran]);
  return cleanBase({
    yil: p.yil,
    dogrulama_tarihi: p.dogrulama_tarihi,
    asgari_brut: p.asgari_ucret.aylik_brut,
    sgk_tavan_kat: Math.round((p.sgk.tavan_aylik / p.asgari_ucret.aylik_brut) * 100) / 100,
    isci_sgk: p.sgk.isci_prim_orani,
    isci_issizlik: p.sgk.isci_issizlik_orani,
    isveren_sgk_indirimsiz: p.sgk.isveren_prim_orani.indirimsiz,
    isveren_sgk_genel: p.sgk.isveren_prim_orani.indirimli_genel,
    isveren_sgk_imalat: p.sgk.isveren_prim_orani.indirimli_imalat,
    isveren_issizlik: p.sgk.isveren_issizlik_orani,
    damga_orani: p.damga_vergisi.oran,
    ucret_dilimleri: tarife(p.gelir_vergisi.ucret_tarifesi),
    genel_dilimleri: tarife(p.gelir_vergisi.genel_tarife || p.gelir_vergisi.ucret_tarifesi),
    engelli: [p.gelir_vergisi.engellilik_indirimi_aylik.derece_1, p.gelir_vergisi.engellilik_indirimi_aylik.derece_2, p.gelir_vergisi.engellilik_indirimi_aylik.derece_3],
    yemek_gv: p.istisnalar.yemek.gelir_vergisi_gunluk,
    yemek_karti: p.istisnalar.yemek.yemek_karti_kdv_dahil_gunluk,
    yemek_sgk: p.istisnalar.yemek.sgk_gunluk.map(({ tutar, ...rest }) => (rest.yontem === 'gunluk_brut_asgari_ucret_orani' ? rest : { ...rest, tutar })),
    yol_gv: p.istisnalar.yol.gelir_vergisi_gunluk,
    kidem: p.kidem_tazminati_tavani,
  });
}

// Sitedeki hesaplama araçlarının kullandığı PARAM2026 alanları (verilen tarihteki geçerli kıdem tavanıyla)
export function siteOverride(base, isoToday) {
  const d = derived(base);
  const kidem = [...base.kidem].reverse().find((p) => p.baslangic <= isoToday && (!p.bitis || p.bitis >= isoToday)) || base.kidem[base.kidem.length - 1];
  return {
    verifiedAt: base.dogrulama_tarihi || isoToday,
    year: base.yil,
    minGross: base.asgari_brut,
    minNet: d.asgari_net,
    sgkCeiling: d.sgk_tavan,
    employeeSgkRate: base.isci_sgk,
    employeeUnemploymentRate: base.isci_issizlik,
    stampRate: base.damga_orani,
    employerSgkNoDiscount: base.isveren_sgk_indirimsiz,
    employerSgkOther: base.isveren_sgk_genel,
    employerSgkManufacturing: base.isveren_sgk_imalat,
    employerUnemploymentRate: base.isveren_issizlik,
    severanceCeiling: kidem.tutar,
    tax: { general: base.genel_dilimleri, wage: base.ucret_dilimleri },
  };
}

// Paneldeki "ne değişecek" özeti için insanca alan adları
export const LABELS = {
  yil: 'Yıl', dogrulama_tarihi: 'Doğrulama tarihi', asgari_brut: 'Brüt asgari ücret', sgk_tavan_kat: 'SGK tavan katsayısı',
  isci_sgk: 'İşçi SGK oranı', isci_issizlik: 'İşçi işsizlik oranı', isveren_sgk_indirimsiz: 'İşveren SGK (indirimsiz)',
  isveren_sgk_genel: 'İşveren SGK (genel indirimli)', isveren_sgk_imalat: 'İşveren SGK (imalat)', isveren_issizlik: 'İşveren işsizlik oranı',
  damga_orani: 'Damga vergisi oranı', ucret_dilimleri: 'Ücret gelir vergisi tarifesi', genel_dilimleri: 'Genel gelir vergisi tarifesi',
  engelli: 'Engellilik indirimi', yemek_gv: 'Yemek istisnası (GV)', yemek_karti: 'Yemek kartı (KDV dahil)', yemek_sgk: 'SGK yemek istisnası',
  yol_gv: 'Yol istisnası', kidem: 'Kıdem tazminatı tavanı',
};
export function diffBase(a, b) {
  if (!a) return Object.keys(LABELS).map((k) => LABELS[k]);
  return Object.keys(LABELS).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map((k) => LABELS[k]);
}
