# ozkandemir.net V3.7 — Yönetim Paneli ve Online Lisans

## Otomatik kurulum (V3.7) — komut satırı gerekmez

1. GitHub'a gönderilen her sürümü Cloudflare otomatik yayınlar. Panel veritabanı (D1) ilk yayında **Cloudflare tarafından otomatik oluşturulur**.
2. Panel ilk açıldığında tabloları ve gizli anahtarları **kendisi kurar**.
3. **https://ozkandemir.net/panel/** adresini açın → "İlk kurulum" ekranı:
   - Size verilen **kurulum kodunu** girin, e-posta ve şifrenizi belirleyin.
   - Telefonda **Google Authenticator** ile ekrandaki **karekodu okutun**, 6 haneli kodu yazın.
   - **10 yedek kodu** kaydedin.
4. Kurulum bir kez yapılır; sonra bu ekran kalıcı olarak kapanır, giriş ekranı açılır.

Program yükleme için dosya deposu (R2) gerekir; Cloudflare hesabında R2 hizmeti bir kez etkinleştirildiğinde otomatik bağlanır.

Aşağıdaki bölümler, komut satırıyla elle kurulum isteyenler içindir (isteğe bağlı).

---


Bu kılavuz, V3.5.8 üzerinde çalışan siteye **şifreli yönetim panelini**, **program yükleme / müşteri indirme bağlantılarını** ve **online lisans yönetimini** ekler. Mevcut sayfalar, BIST kartı, TCMB, haberler, hesaplama araçları ve e-posta seçici **değişmez**.

Tahmini süre: 30–40 dakika (bir kez).

---

## 0. Ön koşullar

| Gerekli | Kontrol |
|---|---|
| Node.js 20 veya üzeri | `node -v` |
| Cloudflare hesabına giriş | `npx wrangler login` (tarayıcı açılır, onaylayın) |
| Telefonda doğrulama uygulaması | Google Authenticator veya Microsoft Authenticator |

> Cloudflare **Workers Paid** ($5/ay) önerilir. Ücretsiz planda da çalışır; kurulum betiği ücretsiz plan için ayar seçeneği sunar (5. adım).

---

## 1. Dosyaları yerleştirin

1. ZIP içindeki proje klasörünün içeriğini mevcut `ozkandemir-web` klasörünüzün (GitHub deposu) **üzerine** kopyalayın.
2. Komut satırını bu klasörde açıp çalıştırın:

```bash
npm install
npm test
```

`calculator tests: OK`, `config tests: OK (4 test)`, `panel tests: OK (41 test)` ve `license tests: OK (33 test)` görmelisiniz.

---

## 2. Panel altyapısı — tek komut (D1 veritabanı + R2 deposu)

> **Önemli:** Bu sürümde `wrangler.jsonc` panel kaynakları olmadan da yayınlanır. GitHub'a gönderdiğiniz anda site güncellenir; panel bu adım tamamlanana kadar "Panel kurulumu tamamlanmadı" der. (V3.6.0'da veritabanı kimliği yer tutucu olduğu için Cloudflare yayını reddediyordu — V3.6.1'de düzeltildi.)

1. İlk kez R2 kullanıyorsanız: Cloudflare paneli → **R2 Object Storage** → **Etkinleştir** (10 GB'a kadar ücretsiz; kart bilgisi istenebilir). Depoda "Public access" **açmayın**.
2. Proje klasöründe:

```bash
npm run panel:altyapi
```

Betik sırasıyla:
- `ozkandemir-panel` D1 veritabanını oluşturur (varsa kullanır),
- `ozkandemir-programlar` R2 deposunu oluşturur (varsa kullanır),
- veritabanı kimliğini **`wrangler.jsonc` dosyasına kendisi yazar** (elle kopyalama yok),
- tabloları kurar (onay sorulursa `y`).

Tekrar çalıştırmak güvenlidir.

---

## 3. Yayın

Değişen `wrangler.jsonc` dosyasını GitHub'a gönderin (GitHub Desktop: **Commit → Push**) ya da:

```bash
npx wrangler deploy
```

`npm test` içindeki yapılandırma testi, `wrangler.jsonc` içinde yer tutucu veya geçersiz kimlik kalmışsa sizi GitHub'a göndermeden önce uyarır.

---

## 4. Lisans imza anahtarı (bir kez)

```bash
npm run lisans:anahtar
```

- `LISANS-ACIK-ANAHTAR.txt` oluşur → içindeki değer **6 programa gömülür** (gizli değildir).
- Gizli anahtar Cloudflare'a `LICENSE_SIGNING_KEY` olarak kaydedilir.
- `LISANS-GIZLI-ANAHTAR-YEDEK.txt` oluşur → **şifreli USB'ye / parola yöneticisine yedekleyip klasörden silin.**

> ⚠️ Bu anahtarı **bir daha üretmeyin**. Yeniden üretilirse dağıtılmış programlar lisans doğrulayamaz.

---

## 5. Yönetici hesabı (şifre + iki adımlı doğrulama)

```bash
npm run panel:hesap
```

1. **1) İlk kurulum** seçin, Workers planınızı seçin.
2. E-posta ve en az 14 karakterlik şifre belirleyin (büyük harf, küçük harf ve rakam).
3. Ekrandaki anahtarı telefon uygulamasına ekleyin: **"+" → "Kurulum anahtarı girin" → Hesap: ozkandemir.net → Zamana dayalı**. Uygulamanın kodunu yazarak doğrulayın.
4. **10 yedek kodu** yazdırın veya parola yöneticisine kaydedin (telefon kaybolursa giriş için).
5. "Cloudflare'a yükleyeyim mi?" → **E**.
6. `PANEL-SIFRELEME-ANAHTARI-YEDEK.txt` dosyasını güvenli yere yedekleyip klasörden silin (hesap sıfırlamada gerekir).

Giriş: **https://ozkandemir.net/panel/**

---

## 6. Cloudflare Access — ek güvenlik kapısı (önerilir, ücretsiz)

Access açıldığında panel adresi, şifre ekranı dahil, **onaylı e-postanıza gelen kod girilmeden hiç görünmez**.

1. Cloudflare paneli → **Zero Trust** (ilk kez ise takım adı seçin, **Free** planı seçin).
2. **Access → Applications → Add an application → Self-hosted**.
3. Application name: `ozkandemir panel` · Session duration: `24 hours`.
4. Public hostname: Domain **ozkandemir.net**, Path **`panel`** (yalnızca bu yol — `/indir` ve `/lisans` **eklenmez**; müşteriler ve programlar onları kullanır).
5. Policy: **Allow** → Include → **Emails** → `ozkan6181@hotmail.com`. Login method: **One-time PIN**.
6. Kaydedin. Uygulamanın **Application Audience (AUD) Tag** değerini ve **Settings → Team domain** (ör. `ozkan.cloudflareaccess.com`) değerini kopyalayın.
7. `wrangler.jsonc` içinde:

```jsonc
"vars": {
  "ACCESS_TEAM_DOMAIN": "ozkan.cloudflareaccess.com",
  "ACCESS_AUD": "buraya-aud-tag"
}
```

8. `npx wrangler deploy`. Panel → **Güvenlik ve kayıtlar** ekranında "Cloudflare Access kapısı" yeşil olmalı.

> Worker, Access imzasını ayrıca kendisi doğrular. Access yanlış yapılandırılırsa panel "Erişim reddedildi" der; `vars` alanını boşaltıp yayınlayarak eski haline dönebilirsiniz.

---

## 7. Kontrol listesi

- [ ] `https://ozkandemir.net/` ana sayfa, BIST, TCMB, haberler eskisi gibi çalışıyor
- [ ] `/panel/` → şifre → 6 haneli kod → panel açıldı
- [ ] Bir programın kurulum dosyası yüklendi (Programlar → Yeni sürüm yükle)
- [ ] Lisanslar → Yeni lisans → anahtar üretildi, WhatsApp mesajı hazırlandı
- [ ] `https://ozkandemir.net/lisans/api/public-key` → `{"alg":"Ed25519","x":"…"}` (x, LISANS-ACIK-ANAHTAR.txt ile aynı)
- [ ] Güvenlik ekranında 6 katmanın durumu görülüyor

---

## 8. Acil durumlar

| Durum | Çözüm |
|---|---|
| Telefon yanımda değil | Girişte "Telefonum yanımda değil" → yedek kod |
| Telefon kayboldu | Yedek kodla girin → Güvenlik → Doğrulama uygulaması → **Yeniden kur** |
| Şifre unutuldu / yedek kod da yok | `npm run panel:hesap` → **2) Hesabı sıfırla** (`PANEL-SIFRELEME-ANAHTARI-YEDEK.txt` gerekir). Lisanslar ve dosyalar korunur. |
| "Çok fazla hatalı deneme" | 15 dakika bekleyin |
| Şüpheli giriş uyarısı | Güvenlik → **Diğer tüm oturumları kapat** + şifre değiştir |
| Müşteri sunucu değiştirdi | Lisans detayı → eski cihazda **Cihazı kaldır** → müşteri yeni sunucuda etkinleştirir |
| Müşterinin sunucusu internete çıkamıyor | Lisans detayı → **Çevrimdışı etkinleştir** |

---

## 9. Teknik özet

| Yol | Ne | Koruma |
|---|---|---|
| `/panel/`, `/panel/api/*` | Yönetim paneli | Access (ops.) + şifre + TOTP + oturum çerezi + CSRF + CSP |
| `/indir/<bağlantı>` | Müşteri indirme sayfası | 256-bit tek kullanımlık bağlantı, süre + indirme sayısı sınırı |
| `/lisans/api/activate`, `/check`, `/public-key` | Programların lisans API'si | Anahtar + cihaz parmak izi, IP başına deneme sınırı, Ed25519 imzalı yanıt |

Cloudflare kaynakları: Worker `ozkandemir-web` · D1 `ozkandemir-panel` · R2 `ozkandemir-programlar` · secrets `PANEL_ENC_KEY`, `LICENSE_SIGNING_KEY`.

Programlara lisans ekleme: `lisans-istemcisi/README.md`.
