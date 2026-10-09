# Özkan Demir Web V3.6.1

**Yeni:** Şifreli yönetim paneli (`/panel/`), program yükleme ve müşteriye süreli indirme bağlantısı, 6 program için online lisans yönetimi (anahtar üretimi, imzalı etkinleştirme, cihaz takibi, süre uzatma, askıya alma).

- Kurulum: **KURULUM-PANEL.md**
- Programlara lisans ekleme: **lisans-istemcisi/README.md**
- Test: `npm test` (hesaplama + yapılandırma + 41 panel + 33 lisans testi)

## Korunan çalışan mantıklar (V3.5.8'den)
BIST 100 özel kart (`/api/bist`, TradingView yok) · `txt()` Türkçe charset çözümü · `/api/tcmb` · `/api/news` · teklif e-posta seçici · `data-gallery` slider · profil görselleri. `src/index.js` içinde yalnızca panel yönlendirmesi eklendi (2 satır).

## Yapı
```
src/index.js            Worker giriş (mevcut API'ler + panel yönlendirmesi)
src/panel/security.js   PBKDF2, TOTP, AES-GCM, Cloudflare Access JWT
src/panel/common.js     ortak sunucu yardımcıları
src/panel/panel.js      panel API, oturum, yükleme, indirme bağlantıları
src/panel/license.js    lisans API'si (Ed25519 imzalı)
migrations/             D1 şeması (0001 panel, 0002 lisans)
public/panel/           panel ekranları (CSP: satır içi kod yok)
public/indir.css        müşteri indirme sayfası
scripts/                kurulum betikleri
lisans-istemcisi/       programlar için Python lisans istemcisi
tests/                  testler (Node 22+, node:sqlite ile D1/R2 taklidi)
```
