# V3.5 QA Raporu

Kontrol tarihi: 02.10.2026

## Otomatik kontroller
- `public/params-2026.js`: Node syntax OK
- `public/calc-core.js`: Node syntax OK
- `public/script.js`: Node syntax OK
- `src/index.js`: Node syntax OK
- 15 HTML sayfasındaki yerel bağlantılar ve statik dosya referansları: eksik yok
- 15 hesaplama aracının `data-tool` eşlemesi: eksik handler yok
- Tüm HTML sayfalarında sürüm etiketi: V3.5
- Yerel HTTP sunucusunda ana sayfa, hizmetler, muhasebe merkezi, hesaplama araçları, yazılımlar, yazılım detayı, canlı veriler, mevzuat, hakkımda ve iletişim: HTTP 200

## Hesaplama testleri
- 2026 brüt asgari ücret 33.030,00 TL -> net 28.075,50 TL: OK
- Diğer sektör 2 puan indirimli asgari ücret işveren maliyeti 40.214,03 TL: OK
- İmalat 5 puan indirimli asgari ücret işveren maliyeti 39.223,13 TL: OK
- İndirimsiz asgari ücret işveren maliyeti 40.874,63 TL: OK
- 2026 gelir vergisi tarife eşikleri: OK
- Kıdem tazminatı 2026 II. dönem tavanı 73.729,87 TL: OK
- KDV dahil/hariç testleri: OK
- İhbar süresi kademeleri: OK
- Yıllık izin asgari gün kademeleri: OK

## Resmi kaynak doğrulaması
- ÇSGB 2026 asgari ücret / işveren maliyeti
- SGK 2026 prime esas kazanç alt-üst sınırları ve prim oranları
- GİB GVK 103 / 2026 gelir vergisi tarifesi
- ÇSGB 01.07.2026-31.12.2026 kıdem tazminatı tavanı
- GİB 2026 vergi takvimi (Ekim-Kasım-Aralık kritik tarihler)
- SGK işveren prim ödeme süresi

Not: Canlı TCMB / GİB / SGK / Resmi Gazete ve TradingView verileri yayın ortamında harici kaynak erişimine bağlıdır; hata durumları için fallback bağlantıları bırakılmıştır.
