# odlisans — Programlar için online lisans istemcisi

Tek dosya: `python/odlisans.py` · Python 3.8+ · **ek paket gerektirmez** (imza doğrulaması saf Python).

| Program | Ürün kodu | Anahtar örneği | Sınırlar (panelde) |
|---|---|---|---|
| NİS PDKS | `NPDK` | NPDK-7K2Q-M9XD-4TRE-H8WC | personel, sube |
| Banka XML Aktarım | `BNKX` | BNKX-… | firma, banka_hesap |
| Satınalma Denetim | `SATD` | SATD-… | kullanici |
| Cari Mutabakat | `CRMT` | CRMT-… | firma |
| Yıllık İzin | `IZIN` | IZIN-… | personel |
| Cari360 | `C360` | C360-… | kullanici |

## Kurallar

- Anahtar **bir kez** "İnternet ile etkinleştir" ile o bilgisayara bağlanır (cihaz parmak izi: Windows MachineGuid).
- Program **7 günde bir** çevrimiçi doğrular; internet yoksa son doğrulamadan itibaren **30 gün** çalışır.
- **Süre biter, askıya alınır, iptal edilir veya cihaz kaldırılırsa program kilitlenir.**
- Lisans dosyası ozkandemir.net tarafından **Ed25519 ile imzalıdır**: değiştirilirse, başka bilgisayara kopyalanırsa veya saat geri alınırsa geçersiz olur.
- Lisans dosyası: `C:\ProgramData\OzkanDemir\Lisans\<KOD>\lisans.json`

## Programa ekleme (3 adım)

1. `odlisans.py` dosyasını programın kaynak klasörüne kopyalayın.
2. `LISANS-ACIK-ANAHTAR.txt` içindeki değeri programa sabit olarak yazın.
3. Açılışta kontrol edin:

```python
from odlisans import LicenseClient, LicenseError

lisans = LicenseClient(
    product="NPDK",
    public_key="LISANS-ACIK-ANAHTAR.txt içindeki değer",
    app_version="2.0.0",
    usage_provider=lambda: {"personel": aktif_personel_sayisi()},  # panelde "112 / 150" görünür
)

durum = lisans.state()          # gerekiyorsa sunucuya sorar
if not durum.ok:
    # Lisans ekranını göster → lisans.activate(girilen_anahtar)
    print(durum.message)
else:
    if durum.warning:           # "Lisans süresi 12 gün sonra doluyor" vb.
        print(durum.warning)
    sinir = durum.limit("personel")
    if durum.has_module("mobil"):
        ...
```

Sürekli açık sunucu uygulamalarında (FastAPI): `lisans.start_background_checks(6)` ve her istekte `lisans.cached_state()`.

Hazır örnekler:
- `python/ornekler/fastapi_ornek.py` — NİS PDKS, Yıllık İzin, Satınalma Denetim, Cari Mutabakat, Cari360 (web tabanlı). Kilitliyken tüm sayfaları `/lisans` ekranına yönlendirir.
- `python/ornekler/tkinter_ornek.py` — Banka XML Aktarım (masaüstü). Açılışta lisans penceresi.

## Güncelleme (V1.1)

Panelde bir sürüm "Güncelleme olarak yayınla" ile müşterilere açılır. Programda:

```python
yeni = lic.check_update()          # yeni sürüm yoksa None
if yeni:
    # Yöneticiye göster: yeni.version, yeni.notes, yeni.mandatory
    if yonetici_onayladi:
        dosya = lic.download_update(yeni, progress=lambda a, t: ...)
        # dosya: SHA-256'sı imzalı bildirimle doğrulanmış kurulum paketi → kurulumu başlat
```

- Bildirim ozkandemir.net imzalıdır; başka bir sunucu veya değiştirilmiş bildirim kabul edilmez.
- İndirme izni 1 saat geçerlidir; kesilirse tekrar çağrıldığında kaldığı yerden devam eder.
- Parmak izi tutmazsa dosya silinir ve `LicenseError(code="checksum")` fırlatılır.
- Komut satırı: `python odlisans.py --product NPDK --public-key … update-check` / `update-download --dir C:\Guncelleme`

## Çevrimdışı etkinleştirme

İnternete çıkamayan sunucular için:
1. Program: `lisans.offline_request_code(anahtar)` → `ODR1.…` istek kodu.
2. Panel → Lisans detayı → **Çevrimdışı etkinleştir** → istek kodunu yapıştır → lisans kodu.
3. Program: `lisans.install_offline_token(lisans_kodu)`.

Çevrimdışı lisans internetsiz bitiş tarihine kadar geçerlidir. Askıya alma bu cihaza yansımaz.

## Destek için komut satırı

```bash
python odlisans.py --product NPDK --public-key <AÇIK_ANAHTAR> status
python odlisans.py --product NPDK --public-key <AÇIK_ANAHTAR> activate NPDK-XXXX-XXXX-XXXX-XXXX
python odlisans.py --product NPDK --public-key <AÇIK_ANAHTAR> check
python odlisans.py --product NPDK --public-key <AÇIK_ANAHTAR> device
```

## Durum kodları

`active` · `no_license` · `expired` · `suspended` · `revoked` · `device_removed` · `offline_too_long` · `tampered` (saat geri alınmış) · `invalid` (dosya bozuk / başka cihaza ait)

## Önemli not

Bu istemci lisans **mekanizmasını** sağlar. Her programın kendi koduna eklenmesi (ekran tasarımı, hangi işlemlerin sınırlara bağlanacağı, kurulum sihirbazına adım eklenmesi) o programın ayrı bir sürüm çalışmasıdır. Önerilen sıra: NİS PDKS → Yıllık İzin → diğerleri.
