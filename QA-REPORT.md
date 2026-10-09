# V3.6.1 QA

Otomatik testler (`npm test`): hepsi geçti
- Hesaplama araçları: OK
- Panel: 41 test — TOTP RFC 6238 vektörleri, PBKDF2, AES-GCM, Access JWT (geçerli/yanlış aud/süresi dolmuş/değiştirilmiş), CSRF, oturumsuz erişim, IP ve hesap kilidi, kod tekrar kullanım engeli, yedek kod, 30 dk hareketsizlik ve 8 saat mutlak oturum, güvenilir cihaz, çok parçalı yükleme + SHA-256, müşteri linki (önizleme botu sayacı tüketmez, hak bitince 410), Excel formül enjeksiyonu, değiştirilemez denetim kaydı, CSP uyumu (satır içi script/style yok)
- Lisans: 33 test — anahtar biçimi, oluşturma doğrulamaları, anahtarın DB'de açık saklanmaması, imza sahteciliği, cihaz sınırı, haftalık doğrulama ve kullanım bildirimi, cihaz kaldırma, askı/yeniden açma, süre uzatma, koşul düzenleme, süre bitimi kilidi, kalıcı iptal, çevrimdışı etkinleştirme, deneme sınırı, Access açıkken lisans API erişimi
- Python istemcisi uçtan uca (9 test): eski lisans dosyasının geri yüklenmesi, etkinleştirme, yanlış ürün, dosya kurcalama ve kopyalama, saat geri alma, 7 gün doğrulama + askı kilidi, 30 gün çevrimdışı sınırı, çevrimdışı etkinleştirme, komut satırı

Tarayıcı testleri (Chromium, 1440 px ve 390 px): giriş → kod → panel → 25 MB yükleme → link → müşteri indirmesi (SHA-256 birebir) → lisans oluşturma → Python ile etkinleştirme → 2. cihaz reddi → askıya alma → programın kilitlenmesi. JS hatası yok, mobilde yatay taşma yok.

Mevcut site: 15 sayfa açılıyor; ana sayfaya panel başlıkları eklenmiyor; V3.5.8 API'leri değişmedi.

Bilinen sınırlar: e-posta bildirimi yok (hatırlatma WhatsApp/e-posta düğmesiyle); yüklenen dosyalarda virüs taraması yok; Workers ücretsiz planında şifre özeti 10.000 tur (kurulumda seçilir).

Bağımsız güvenlik incelemesi (09.10.2026) bulguları ve düzeltmeleri:
- Deneme sınırları paralel isteklerle aşılabiliyordu → atomik "önce say" sayaçları; 40 paralel şifre denemesinden en fazla 5'i, tek doğrulama adımında en fazla 5 kod değerlendirilir (testli).
- Hesap kilidiyle yöneticiyi dışarıda bırakma → güvenilir cihaz hesap kilidinden etkilenmez (testli); kalıcı çözüm Cloudflare Access.
- Cihaz sınırı yarış durumu → tek SQL ifadesiyle atomik etkinleştirme (10 paralel istekten tam 2'si kabul, testli).
- 2FA yalnızca şifreyle değiştirilebiliyordu → mevcut kod veya yedek kod da gerekir (testli).
- Geçersiz başlangıç tarihi 500 → 400. Doğrulama kayıtları 6 saatte bir, 180 günden eskiler silinir.
- Python istemcisi: eski lisans dosyasının geri yüklenmesi ikinci kayıt yeriyle (Windows kayıt defteri) yakalanır.

## V3.6.1 — GitHub → Cloudflare yayın hatası (09.10.2026)
- Neden: `wrangler.jsonc` içinde D1 `database_id` yer tutucusu (`BURAYA_D1_DATABASE_ID_YAPISTIRIN`) ve henüz oluşturulmamış R2 deposu vardı; kılavuzun altyapı adımları tamamlanmadan GitHub'a gönderilince Cloudflare yayını reddetti, site V3.5.8'de kaldı.
- Düzeltme: D1/R2 bağlantıları varsayılan yapılandırmadan çıkarıldı; site panel kaynakları olmadan yayınlanır (panel "kurulum tamamlanmadı" der). `npm run panel:altyapi` veritabanını ve depoyu oluşturup kimliği `wrangler.jsonc` dosyasına kendisi yazar.
- Koruma: `tests/test-config.mjs` — yer tutucu / geçersiz kimlik / bozuk JSONC varsa `npm test` başarısız olur; kaynaksız çalışma ve yamanın tekrar çalıştırılabilirliği test edilir.
- Panel, lisans ve giriş kodunda değişiklik gerekmedi (GitHub'daki kod paketle birebir aynıydı).
