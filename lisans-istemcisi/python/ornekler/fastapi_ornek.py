# -*- coding: utf-8 -*-
"""
FastAPI tabanlı programlar için örnek (NİS PDKS, Yıllık İzin, Satınalma Denetim, Cari Mutabakat, Cari360).

Ne yapar?
  * Açılışta lisansı kontrol eder, arka planda 6 saatte bir doğrular (asıl kontrol 7 günde bir).
  * Lisans etkin değilse /lisans dışındaki her isteği "Program kilitli" sayfasına yönlendirir.
  * /lisans sayfasında anahtar girilerek etkinleştirme ve çevrimdışı etkinleştirme yapılır.

Programınıza eklerken:
  1. odlisans.py dosyasını programın içine kopyalayın.
  2. PRODUCT ve ACIK_ANAHTAR değerlerini doldurun (LISANS-ACIK-ANAHTAR.txt).
  3. kur_lisans(app) çağrısını FastAPI uygulamanız oluşturulduktan hemen sonra ekleyin.
"""
from html import escape
from urllib.parse import quote

from fastapi import FastAPI, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from odlisans import LicenseClient, LicenseError

PRODUCT = "NPDK"                      # NPDK, IZIN, SATD, CRMT, C360
ACIK_ANAHTAR = "BURAYA_LISANS_ACIK_ANAHTARI"
UYGULAMA_SURUMU = "2.0.0"


def personel_sayisi() -> dict:
    # Programın gerçek kullanımını bildirin (panelde "112 / 150 personel" olarak görünür)
    # ör. return {"personel": db.query(Personel).filter_by(aktif=True).count()}
    return {}


lisans = LicenseClient(PRODUCT, ACIK_ANAHTAR, UYGULAMA_SURUMU, usage_provider=personel_sayisi)


def _sayfa(baslik: str, govde: str) -> HTMLResponse:
    return HTMLResponse(f"""<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>{escape(baslik)}</title>
<style>body{{font-family:Segoe UI,Arial,sans-serif;background:#f6f9fc;color:#0b2545;margin:0}}
.k{{max-width:520px;margin:8vh auto;background:#fff;border:1px solid #dfe7f0;border-radius:14px;padding:28px}}
input{{width:100%;box-sizing:border-box;height:46px;border:1px solid #c9d6e3;border-radius:9px;padding:0 12px;font:700 17px Consolas,monospace}}
button{{height:46px;border:0;border-radius:9px;background:#08263f;color:#fff;font-weight:700;padding:0 18px;margin-top:12px;cursor:pointer}}
.h{{background:#fdecec;color:#a12a2a;padding:12px;border-radius:9px}} .u{{background:#fff3dc;color:#7a5200;padding:12px;border-radius:9px}}
textarea{{width:100%;box-sizing:border-box;font:12px Consolas,monospace}}</style></head><body><div class="k">{govde}</div></body></html>""")


def kur_lisans(app: FastAPI) -> None:
    lisans.state()                     # açılışta kontrol (gerekirse çevrimiçi)
    lisans.start_background_checks(6)  # sunucu sürekli açıksa

    @app.middleware("http")
    async def lisans_kontrol(request: Request, call_next):
        yol = request.url.path
        if yol.startswith("/lisans") or yol.startswith("/static"):
            return await call_next(request)
        st = lisans.cached_state()
        if not st.ok:
            if yol.startswith("/api/"):
                from fastapi.responses import JSONResponse
                return JSONResponse({"detail": st.message, "lisans": st.code}, status_code=403)
            return RedirectResponse("/lisans", status_code=303)
        # st.warning doluysa (süre yaklaşıyor / uzun süredir doğrulanamadı) arayüzde bant olarak gösterin
        request.state.lisans_uyari = st.warning
        return await call_next(request)

    @app.get("/lisans", response_class=HTMLResponse)
    def lisans_sayfasi(hata: str = ""):
        st = lisans.state()
        if st.ok:
            uyari = f'<p class="u">{escape(st.warning)}</p>' if st.warning else ""
            return _sayfa("Lisans", f"<h2>Lisans etkin</h2><p><b>{escape(st.customer)}</b><br>Geçerlilik: {st.expires} ({st.days_left} gün)</p>{uyari}<p><a href='/'>Programa dön →</a></p>")
        return _sayfa("Lisans gerekli", f"""
<h2>Program kilitli</h2><p class="h">{escape(st.message)}</p>{f'<p class="h">{escape(hata)}</p>' if hata else ''}
<form method="post" action="/lisans/etkinlestir"><label>Lisans anahtarı<input name="anahtar" placeholder="{PRODUCT}-XXXX-XXXX-XXXX-XXXX" required></label>
<button>İnternet ile etkinleştir</button></form>
<details><summary>İnternet yok mu? Çevrimdışı etkinleştirme</summary>
<form method="post" action="/lisans/istek"><input name="anahtar" placeholder="Lisans anahtarı" required><button>İstek kodu üret</button></form>
<form method="post" action="/lisans/kur"><textarea name="kod" rows="4" placeholder="Özkan Demir'in verdiği lisans kodu"></textarea><button>Lisans kodunu kur</button></form></details>
<p>Destek: 0551 600 77 87</p>""")

    @app.post("/lisans/etkinlestir")
    def etkinlestir(anahtar: str = Form(...)):
        try:
            lisans.activate(anahtar)
            return RedirectResponse("/", status_code=303)
        except LicenseError as e:
            return RedirectResponse("/lisans?hata=" + quote(e.message), status_code=303)

    @app.post("/lisans/istek", response_class=HTMLResponse)
    def istek(anahtar: str = Form(...)):
        kod = lisans.offline_request_code(anahtar)
        return _sayfa("İstek kodu", f"<h2>İstek kodu</h2><p>Bu kodu Özkan Demir'e gönderin:</p><textarea rows='6' readonly>{escape(kod)}</textarea><p><a href='/lisans'>← Geri</a></p>")

    @app.post("/lisans/kur")
    def kur(kod: str = Form(...)):
        try:
            lisans.install_offline_token(kod)
            return RedirectResponse("/", status_code=303)
        except LicenseError as e:
            return RedirectResponse("/lisans?hata=" + quote(e.message), status_code=303)


# Örnek:
# app = FastAPI()
# kur_lisans(app)
# Personel sınırı gibi kuralları uygulamak için: lisans.cached_state().limit("personel")
