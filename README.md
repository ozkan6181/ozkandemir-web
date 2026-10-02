# ozkandemir.net V3.5

V3.4 çalışan ana referans sürüm korunarak hazırlanmıştır.

## V3.5 yenilikleri
- GİB/SGK doğrulamalı 2026 son çeyrek Mali Takvim
- Merkezi `params-2026.js` parametre katmanı
- 15 çalışan hesaplama aracı
- 6 yazılım için ayrı detay sayfası
- İletişimde konu seçmeli hazır WhatsApp mesajı
- V3.4 sabit menü ve çok sayfalı mimarinin korunması

## 2026 doğrulanan temel parametreler
- Brüt asgari ücret: 33.030,00 TL
- Net asgari ücret: 28.075,50 TL
- SGK prime esas aylık üst sınır: 297.270,00 TL
- Kıdem tazminatı tavanı (01.07–31.12.2026): 73.729,87 TL
- Gelir vergisi tarifesi: GVK 103 / 332 Seri No.lu GVK Genel Tebliği

## Test
`node tests/test-calculators.js`
`node --check public/script.js`
`node --check public/calc-core.js`
`node --check src/index.js`

Son kontrol: 02.10.2026

## V3.5.1 Türkçe karakter düzeltmesi
- Güncel Mevzuat & Haberler API yanıtlarında kaynak sayfanın charset bilgisi okunur.
- ISO-8859-9 / Windows-1254 Türkçe kaynaklar doğru çözümlenir.
- HTML entity biçimindeki Türkçe karakterler Unicode'a çevrilir.
