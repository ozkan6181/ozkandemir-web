# ozkandemir.net — PROJE DEVİR DOKÜMANI

**Proje:** Özkan Demir kişisel / profesyonel web sitesi  
**Canlı alan adı:** `https://ozkandemir.net`  
**GitHub deposu:** `ozkan6181/ozkandemir-web`  
**Güncel paket:** **V3.5.8**  
**Altyapı:** Cloudflare Workers + Static Assets + GitHub  
**Dil:** Türkçe  
**Son devir tarihi:** 08.10.2026

---

## 1. Projenin amacı

Site, Özkan Demir'in SMMM kimliğini, muhasebe/finans uzmanlığını, dijital çözüm yaklaşımını ve geliştirilen muhasebe/iş yazılımlarını tanıtmak için hazırlanmıştır. Yapı; kurumsal tanıtım, canlı finans verileri, mevzuat/haber içerikleri, hesaplama araçları, yazılım ürün tanıtımları ve iletişim/teklif akışlarını tek sitede birleştirir.

### Profil bilgileri

- **Ad Soyad:** Özkan Demir
- **Meslek:** Serbest Muhasebeci Mali Müşavir (SMMM)
- **Konum:** Ankara
- **Telefon / WhatsApp:** 0551 600 77 87
- **Sitedeki e-posta:** `info@ozkandemir.net` (10.10.2026 itibarıyla tüm iletişim ve teklif bağlantıları)
- **Önceki e-posta:** `ozkan6181@hotmail.com` (panel giriş hesabı olarak kullanılmaya devam ediyor)
- **Instagram:** `ozkan6181`
- **Deneyim ifadesi:** `20+ yıllık mesleki deneyim`

### Kullanılması onaylanmış içerik dili

- Mesleki Deneyim
- Dijital Çözümler
- Güncel Mevzuat
- Sürekli Destek

Kullanılmaması gereken ifade: `2004'ten beri`. Belgelenen ilk iş deneyimi 2005 olduğundan güvenli/uygun ifade `20+ yıllık mesleki deneyim` olarak korunmalıdır.

### Hakkımda ana anlatısı

> Muhasebeden finansal kontrole, mevzuattan dijital dönüşüme uzanan 20 yılı aşkın mesleki deneyim.

> Muhasebenin yalnızca geçmişi kaydeden değil, işletmenin gelecekte daha doğru kararlar vermesini sağlayan bir yönetim aracı olduğuna inanıyorum.

> Doğru Muhasebe → Güçlü Kontrol → Dijital ve Verimli Süreçler

---

## 2. Güncel teknik mimari

### Cloudflare Worker

Ana Worker dosyası:

`src/index.js`

Worker iki görevi birlikte yapar:

1. `/api/*` istekleri için dinamik API sağlar.
2. Diğer tüm istekleri `public/` altındaki statik dosyalara yönlendirir.

### Wrangler yapılandırması

Dosya: `wrangler.jsonc`

Temel yapı:

```json
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "ozkandemir-web",
  "main": "./src/index.js",
  "compatibility_date": "2026-10-01",
  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "run_worker_first": ["/api/*"]
  }
}
```

### NPM komutları

```bash
npm install
npm run dev
npm test
npm run deploy
```

Gerçek deploy komutu:

```bash
npx wrangler deploy
```

---

## 3. Kritik çalışan mantıklar — MUTLAKA KORUNMALI

Bu bölüm projeyi devralacak geliştirici için en önemli bölümdür. Aşağıdaki çalışan mantıklar geçmişte sorun çıkarıp düzeltilmiş, kullanıcı tarafından onaylanmıştır.

### 3.1 BIST 100 — TradingView kullanılmayacak

BIST 100 için TradingView widget kullanımı başarısız oldu ve ekranda `This symbol is only available on TradingView` benzeri hata verdi.

Bu nedenle BIST 100 tamamen özel karta alınmıştır.

**Frontend:**

- `public/script.js`
- `#bistCard`
- `/api/bist`
- özel sparkline çizimi

**Backend:**

- `src/index.js`
- Yahoo Finance chart endpoint'i üzerinden `XU100.IS`
- yaklaşık kaynak URL mantığı:
  `https://query1.finance.yahoo.com/v8/finance/chart/XU100.IS?range=5d&interval=15m`

Dönen başlıca alanlar:

- price
- previousClose
- change
- changePercent
- dayHigh
- dayLow
- marketTime
- points
- delayed

**Kural:** BIST 100 tekrar TradingView widget içine alınmamalı.

Global piyasa göstergelerinde TradingView kullanılabilir; yasak yalnızca BIST 100 widget'ı içindir.

### 3.2 Türkçe karakter / charset düzeltmesi — MUTLAKA KORUNMALI

`Güncel Mevzuat & Haberler` alanında dış sitelerden içerik çekerken Türkçe karakterler bozuluyordu.

Çalışan çözüm `src/index.js` içindeki `txt()` fonksiyonundadır.

Desteklenen kodlamalar:

- UTF-8
- ISO-8859-9
- Windows-1254
- Windows-1252
- ISO-8859-1 fallback

Ayrıca HTML entity çözümlemesi vardır:

- ü / Ü
- ö / Ö
- ç / Ç
- ş / Ş
- ğ / Ğ
- İ / ı

Bu çözüm kullanıcı tarafından canlıda doğrulanmıştır. Basitleştirilmemeli veya eski `response.text()` mantığına dönülmemelidir.

### 3.3 TCMB canlı döviz verileri

API:

`/api/tcmb`

Kaynak:

`https://www.tcmb.gov.tr/kurlar/today.xml`

Gösterilen kurlar:

- USD
- EUR
- GBP
- CHF

Ana sayfada TCMB kartının altında **Hızlı Döviz Çevirici** bulunmaktadır. Bu boş alanı doldurmak için özellikle eklenmiştir ve korunması tercih edilir.

### 3.4 Güncel mevzuat / haber API'si

API:

`/api/news`

Kaynaklar:

- GİB
- SGK
- Resmî Gazete

Worker, kaynaklar başarısız olduğunda kullanıcıya boş ekran vermemek için resmi kaynak bağlantılarından oluşan fallback döndürür.

### 3.5 Yazılım teklif e-posta seçici

İlk sürümde doğrudan `mailto:` kullanıldı. Bazı bilgisayarlarda varsayılan posta programı tanımlı olmadığı için e-posta tuşu çalışmadı.

V3.5.7 ile `public/script.js` içinde `.offer-mail` tıklaması yakalanır ve bir seçim penceresi açılır:

- Gmail ile aç
- Outlook / Hotmail ile aç
- Varsayılan e-posta uygulaması

Gmail compose bağlantısı ve Outlook deeplink kullanılır.

Bu mantık V3.5.8'de de korunmuştur.

### 3.6 V3.5.8 yazılım galeri / slider

`public/script.js` içinde `data-gallery` tabanlı vanilla JavaScript galeri bulunur.

Özellikler:

- büyük aktif görsel
- küçük thumbnail görseller
- önceki / sonraki butonu
- aktif thumbnail durumu
- responsive kullanım

Harici slider kütüphanesi kullanılmaz.

---

## 4. Sayfa yapısı

Güncel ana sayfalar:

- `public/index.html` — Ana sayfa
- `public/hizmetler.html` — Hizmetler
- `public/muhasebe-merkezi.html` — Muhasebe Merkezi
- `public/yazilimlar.html` — Yazılımlar
- `public/canli-veriler.html` — Canlı veriler
- `public/mevzuat.html` — Mevzuat / haberler
- `public/hesaplama-araclari.html` — Hesaplama araçları
- `public/hakkimda.html` — Hakkımda
- `public/iletisim.html` — İletişim

Yazılım detay sayfaları:

- `public/yazilim-personel.html`
- `public/yazilim-cari-mutabakat.html`
- `public/yazilim-banka-logo.html`
- `public/yazilim-yillik-izin.html`
- `public/yazilim-satinalma-denetim.html`
- `public/yazilim-cari360.html`

Ortak frontend dosyaları:

- `public/styles.css`
- `public/script.js`
- `public/calc-core.js`
- `public/params-2026.js`
- `public/favicon.svg`

---

## 5. Yazılım ürünleri ve tanıtım metinleri

### Personel Devam Takip

Kısa açıklama:

`Mesai planı, giriş/çıkış, izin/rapor talepleri, PWA ve gerçek push bildirimleri.`

Vurgular:

- aktif personel takibi
- izin yönetimi
- raporlama
- mobil / PWA
- bildirim sistemi

### Cari Mutabakat

Kısa açıklama:

`Logo cari bakiyesinden PDF mutabakat, e-posta, yanıt linki ve fark analizi.`

Vurgular:

- toplu mutabakat
- cari arama / filtre
- PDF mutabakat mektubu
- e-posta gönderimi
- Mutabıkız / Mutabık Değiliz akışı
- ekstre yükleme
- fark analizi

Tanıtım ekranlarında gerçek şirket/cari adları kullanılmamalı; `Örnek Şirket`, `Cari A`, `Cari B` gibi anonim örnekler kullanılmalıdır.

### Banka Ekstre → Logo

Kısa açıklama:

`Banka hareketlerinin okunması, sınıflandırılması ve Logo aktarım verisine dönüştürülmesi.`

Vurgular:

- çoklu banka
- ekstre yükleme
- eşleştirme / kontrol
- XML üretimi
- Logo uyumu

### Yıllık İzin Yönetimi

Kısa açıklama:

`Hakediş, kullanılan/kalan izin, talepler ve personel ekstreleri.`

Vurgular:

- hakediş
- kalan izin
- talep / onay
- takvim
- personel bazlı rapor

### Satınalma Denetim

Kısa açıklama:

`Fatura/irsaliye, VKN, belge no, tutar, barkod ve miktar kontrolleri.`

Vurgular:

- fatura karşılaştırma
- VKN/TCKN kontrolü
- belge no kontrolü
- tutar farkı
- hata filtreleri
- Excel raporu

### Cari360

Kısa açıklama:

`Cari hesaplar, faturalar, ekstreler ve finansal kontrol/raporlama.`

Vurgular:

- cari hesap görünümü
- finansal özetler
- kontrol / karşılaştırma
- detay analiz
- yönetim raporları

---

## 6. V3.5.8 görsel yapısı

V3.5.8 ile yazılım ürünlerine ekran görselleri eklenmiştir.

Ana yazılım kartlarında küçük önizleme, detay sayfalarında galeri/slider kullanılır.

Optimize görseller:

`public/assets/software/<slug>/01.webp` vb.

Klasörler:

- `public/assets/software/personel/`
- `public/assets/software/cari-mutabakat/`
- `public/assets/software/banka-logo/`
- `public/assets/software/yillik-izin/`
- `public/assets/software/satinalma-denetim/`
- `public/assets/software/cari360/`

Personel ürününde 5 görsel, diğerlerinde 4'er görsel vardır.

Devir paketinde ayrıca bu WebP'lerin üretildiği büyük kaynak PNG'ler `KAYNAK_GORSELLER/` altında verilmiştir.

---

## 7. Profil görselleri — kritik kullanıcı tercihi

Kullanıcının ham siyah tişörtlü selfie fotoğrafı sitede kullanılmamalıdır.

AI ile yüzü yeniden üretme denemeleri kullanıcı tarafından uygun bulunmadı. Kullanıcının açık isteği:

`Yüzüm aynı kalacak, sadece takım elbise.`

Son onaylanan görseller doğrudan onaylı tasarım ekran görüntüsünden crop edilmiştir:

- `public/assets/ozkan-demir-hero.jpg`
- `public/assets/ozkan-demir-profile.jpg`

Bunlar korunmalıdır.

Kaynakları devir paketinde `KAYNAK_GORSELLER/` altında da bulunmaktadır.

---

## 8. Hesaplama merkezi

Hesaplama merkezi V3.5 ile genişletilmiştir.

Araçlar:

1. Brütten Nete
2. Netten Brüte
3. İşveren Maliyeti
4. Kıdem
5. İhbar
6. KDV
7. Tevkifatlı KDV
8. Gelir Vergisi
9. Fazla Mesai
10. Yıllık İzin
11. Serbest Meslek Makbuzu
12. Kira Stopajı
13. Amortisman
14. Gecikme
15. Döviz / TL

Kod:

- `public/calc-core.js`
- `public/params-2026.js`
- `public/script.js`

Test:

- `tests/test-calculators.js`

### 2026 parametreleri

Parametreler oluşturuldukları tarihte resmi kaynaklar üzerinden kontrol edilmiştir. Ancak mevzuat değişebileceğinden her yeni mali yılda veya resmi değişiklikte tekrar doğrulanmalıdır.

Mevcut referans değerler arasında:

- 2026 brüt asgari ücret: 33.030 TL
- 2026 net asgari ücret: 28.075,50 TL
- SGK tavanı: 297.270 TL
- 2026 Temmuz-Aralık kıdem tavanı: 73.729,87 TL

Gelir vergisi dilimleri `params-2026.js` içindedir.

---

## 9. İletişim ve teklif akışı

Telefon / WhatsApp:

`0551 600 77 87`

WhatsApp bağlantılarında raw format:

`5516007787`

Yazılım kartlarında ve detay sayfalarında hazır teklif mesajları vardır.

Örnek:

`Merhaba Özkan Bey, Cari Mutabakat yazılımı için teklif almak istiyorum. Kurulum, lisanslama, kapsam ve fiyatlandırma hakkında bilgi verebilir misiniz?`

E-posta konu örneği:

`Cari Mutabakat - Teklif Talebi`

Body alanları:

- Firma / Ad Soyad
- Telefon
- Not

### Kurumsal e-posta planı

08.10.2026 itibarıyla `info@ozkandemir.net` için Google Workspace düşünülmektedir.

10.10.2026 itibarıyla sitedeki tüm iletişim ve teklif e-posta bağlantıları `info@ozkandemir.net` adresine çevrildi.

Workspace kurulursa site içindeki teklif/iletişim e-posta hedeflerinin `info@ozkandemir.net` olarak güncellenmesi önerilir.

DNS Cloudflare üzerindedir. Web sitesi DNS kayıtları ile e-posta MX/TXT kayıtları ayrı yönetilmelidir.

---

## 10. GitHub ve Cloudflare

GitHub deposu:

`ozkan6181/ozkandemir-web`

Branch:

`main`

Cloudflare Worker projesi:

`ozkandemir-web`

Alan adı:

`ozkandemir.net`

Cloudflare nameserver geçmiş referansı:

- `peyton.ns.cloudflare.com`
- `vivienne.ns.cloudflare.com`

Deploy akışı:

GitHub → Cloudflare otomatik deploy veya lokal `npx wrangler deploy`

Not: Önceki ChatGPT GitHub entegrasyonunda repo okuma mümkünken yazma çağrısı `403 Resource not accessible by integration` döndürmüştür. Bu nedenle teslimatlar ZIP paketleri halinde verilmiştir.

---

## 11. Sürüm özeti

### V1

İlk statik temel.

### V2

Worker/API ve canlı veri altyapısına geçiş.

### V3 / V3.x

Tasarım ve çok sayfalı yapı geliştirildi.

### V3.4

Kullanıcı tarafından kabul edilmiş önemli stabil çok sayfalı referans.

### V3.5

Mali Takvim, geniş hesaplama merkezi, merkezi 2026 parametreleri, ayrı yazılım detay sayfaları ve gelişmiş iletişim akışı.

### V3.5.1

Türkçe charset / entity sorununun çalışan çözümü.

### V3.5.2–V3.5.5

BIST 100 sorunları üzerinde düzeltmeler. **V3.5.5 BIST custom API + özel kart yaklaşımının kullanıcı tarafından doğrulandığı referanstır.**

### V3.5.6

6 yazılım kartı ve 6 detay sayfasına Teklif İste / WhatsApp / e-posta aksiyonları.

### V3.5.7

`mailto:` sorununa karşı Gmail / Outlook / varsayılan e-posta seçici.

### V3.5.8

Yazılım görsel önizlemeleri ve detay galeri / slider.

**Güncel ana sürüm: V3.5.8**

---

## 12. Yeni geliştirme yapılırken korunacak tasarım dili

Kullanıcı tarafından onaylanmış görsel yaklaşım:

- beyaz üst navigasyon
- ince piyasa ticker alanı
- lacivert hero
- solda takım elbiseli portre
- merkezde tanıtım metni
- sağda deneyim kartı
- yetkinlik / değer satırı
- TCMB + piyasa kartları
- hesaplama araçları
- Mali Takvim / Güncel Mevzuat & Haberler / Hızlı Bağlantılar üçlü alanı
- yazılım ürün kartları
- profil / yetkinlik alanı

Büyük redesign yapılmadan önce kullanıcıya görsel/mockup gösterilip onay alınması tercih edilir.

---

## 13. Güvenlik / gizlilik notları

Tanıtım görsellerinde ve demo ekranlarda:

- gerçek müşteri / cari adı
- gerçek çalışan adı
- telefon
- e-posta
- VKN / TCKN
- özel finansal bakiye

gösterilmemelidir.

Anonim veya tamamen örnek veri kullanılmalıdır.

Cari Mutabakat ekranında kullanıcı özellikle büyük `ADRES7` ifadesinin kaldırılmasını ve `Örnek Şirket` kullanılmasını istemiştir.

---

## 14. Dosya ağacı — güncel kaynak

```text
CURRENT_V3.5.8/
├── README.md
├── QA-REPORT.md
├── package.json
├── wrangler.jsonc
├── src/
│   └── index.js
├── tests/
│   └── test-calculators.js
└── public/
    ├── index.html
    ├── hizmetler.html
    ├── muhasebe-merkezi.html
    ├── yazilimlar.html
    ├── canli-veriler.html
    ├── mevzuat.html
    ├── hesaplama-araclari.html
    ├── hakkimda.html
    ├── iletisim.html
    ├── yazilim-personel.html
    ├── yazilim-cari-mutabakat.html
    ├── yazilim-banka-logo.html
    ├── yazilim-yillik-izin.html
    ├── yazilim-satinalma-denetim.html
    ├── yazilim-cari360.html
    ├── styles.css
    ├── script.js
    ├── calc-core.js
    ├── params-2026.js
    ├── favicon.svg
    └── assets/
        ├── ozkan-demir-hero.jpg
        ├── ozkan-demir-profile.jpg
        └── software/
```

---

## 15. Devir paketinin içeriği

Bu teslim paketi aşağıdaki klasörlerden oluşur:

### `CURRENT_V3.5.8/`

Canlıya alınabilir güncel kaynak kodun tamamı.

### `ARSIV_SURUMLER/`

ChatGPT çalışma alanında mevcut eski sürüm ZIP'leri ve patch paketleri.

### `KAYNAK_GORSELLER/`

Site tasarımında ve yazılım tanıtımında kullanılan büyük kaynak görseller.

### `KAYNAK_BELGELER/`

Site içeriğinin hazırlanmasında kullanılan kullanıcıya ait kaynak belge(ler), ör. CV.

### `proje_devir.md`

Bu dosya.

### `DOSYA-MANIFESTI-SHA256.txt`

Paket içindeki dosyaların SHA-256 doğrulama listesi.

---

## 16. İlk yapılacak kontrol listesi

Projeyi başka bir geliştirici / Claude Code / Codex devraldığında:

1. `CURRENT_V3.5.8` klasörünü ana kaynak kabul et.
2. `npm install` çalıştır.
3. `npm test` çalıştır.
4. `npx wrangler dev` ile lokal kontrol et.
5. `/api/tcmb`, `/api/news`, `/api/bist` uçlarını test et.
6. BIST'i TradingView'a geri alma.
7. Türkçe charset çözümünü bozma.
8. Profil görsellerini değiştirme.
9. Yazılım slider'ını koru.
10. Teklif e-posta seçiciyi koru.
11. Canlı mali parametreleri değiştirirken resmi kaynak doğrulaması yap.
12. Büyük UI değişikliklerinde önce mockup / ekran görüntüsü ile kullanıcı onayı al.

---

## 17. Claude Code / başka AI için kısa başlangıç prompt'u

```text
Bu repo ozkandemir.net V3.5.8 çalışan ana sürümdür. Önce proje_devir.md dosyasını tamamen oku. Mevcut görünümü ve çalışan özellikleri bozma. Özellikle src/index.js içindeki charset çözümünü, /api/bist özel BIST kartını, /api/tcmb, /api/news, public/script.js içindeki teklif mail sağlayıcı seçicisini ve V3.5.8 data-gallery slider yapısını koru. BIST için TradingView kullanma. Profil fotoğraflarını değiştirme. Demo yazılım ekranlarında gerçek cari/şirket/personel bilgisi kullanma. Her geliştirmede mevcut testleri çalıştır ve değişiklik kapsamı dışında refactor yapma.
```

---

**Devir durumu:** Projenin ChatGPT çalışma alanında mevcut olan güncel kaynakları, sürüm arşivleri ve ilgili içerik/görseller bu paket içinde teslim edilmiştir.

---

## 18. V3.6.0 — Yönetim paneli ve online lisans (09.10.2026)

**Güncel ana sürüm: V3.6.0.** Kurulum adımları `KURULUM-PANEL.md`, programlara lisans ekleme `lisans-istemcisi/README.md`.

### Eklenenler
- `/panel/` — şifre + TOTP (Google/Microsoft Authenticator) + yedek kodlar, isteğe bağlı Cloudflare Access kapısı. Oturum: `__Host-od_sess` çerezi, 30 dk hareketsizlik / 8 saat mutlak.
- Program yükleme: R2 (`ozkandemir-programlar`, herkese kapalı), 20 MB parçalı yükleme, en fazla 2 GB, tarayıcıda SHA-256.
- Müşteri indirme bağlantısı: `/indir/<256-bit>` — süreli (24 sa / 3 gün / 7 gün), sayılı (1/3/5). GET yalnızca sayfayı gösterir (WhatsApp önizlemesi hakkı tüketmez), indirme POST ile.
- Online lisans: 6 program — NİS PDKS `NPDK`, Banka XML Aktarım `BNKX`, Satınalma Denetim `SATD`, Cari Mutabakat `CRMT`, Yıllık İzin `IZIN`, Cari360 `C360`.
  - Yalnızca **yıllık abonelik**. Süre bitince / askı / iptal / cihaz kaldırma → program **tamamen kilitlenir**.
  - Program 7 günde bir doğrular, internetsiz 30 gün çalışır. Çevrimdışı etkinleştirme panelden.
  - Lisans belgeleri **Ed25519** ile imzalı (`LICENSE_SIGNING_KEY` secret). Açık anahtar `LISANS-ACIK-ANAHTAR.txt` → programlara gömülür. **İmza anahtarı yeniden üretilmemeli.**
  - Anahtarlar DB'de SHA-256 (arama) + AES-256-GCM (panelde gösterme, `PANEL_ENC_KEY`) olarak saklanır.
- Denetim kaydı: değiştirilemez (SQLite trigger), 1 yıl, Excel (CSV) dışa aktarım.

### Kritik kurallar (V3.6)
- `/panel` dışındaki yollar (`/indir`, `/lisans/api`) Cloudflare Access'e **eklenmez**.
- `src/index.js` içinde V3.5.8 kodu değişmedi; yalnızca `isPanelPath` yönlendirmesi eklendi.
- Panel sayfalarında satır içi script/style yok (CSP `script-src 'self'`). Yeni ekranlarda da `innerHTML` kullanılmaz; DOM `OD.h()` ile kurulur.
- Deneme sınırları atomik SQL ile "önce say, sonra kontrol et" düzenindedir; değiştirirken paralel testleri (`npm test`) çalıştırın.
- `PANEL_ENC_KEY` hesap sıfırlamada gerekir (`PANEL-SIFRELEME-ANAHTARI-YEDEK.txt`); kaybolursa panelde lisans anahtarlarının tamamı görüntülenemez (maskeli görünür), lisanslar çalışmaya devam eder.

### Test
`npm test` → hesaplama + 41 panel + 33 lisans testi (Python istemcisiyle uçtan uca dahil). Node 22+ gerekir (`node:sqlite`).

### Sıradaki iş
Python lisans istemcisinin (`lisans-istemcisi/python/odlisans.py`) programlara eklenmesi — önerilen sıra NİS PDKS → Yıllık İzin → diğerleri. Her program kendi sürüm çalışmasıdır.
