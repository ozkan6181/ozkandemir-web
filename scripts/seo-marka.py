# ozkandemir.net — SEO etiketleri ve NİS marka adları (tekrar çalıştırılabilir)
import json, re, urllib.parse as up, pathlib
ROOT = pathlib.Path(__file__).resolve().parent.parent / "public"
SITE = "https://www.ozkandemir.net"
TODAY = "2026-10-10"
ORG = {"@type": "AccountingService", "@id": SITE + "/#isletme", "name": "Özkan Demir SMMM",
       "alternateName": "Özkan Demir Serbest Muhasebeci Mali Müşavir", "url": SITE + "/",
       "image": SITE + "/assets/ozkan-demir-hero.jpg", "telephone": "+90 551 600 77 87",
       "email": "info@ozkandemir.net", "areaServed": "TR",
       "address": {"@type": "PostalAddress", "addressLocality": "Ankara", "addressCountry": "TR"},
       "founder": {"@id": SITE + "/#ozkan-demir"}}
PERSON = {"@type": "Person", "@id": SITE + "/#ozkan-demir", "name": "Özkan Demir",
          "jobTitle": "Serbest Muhasebeci Mali Müşavir", "url": SITE + "/hakkimda.html",
          "image": SITE + "/assets/ozkan-demir-hero.jpg", "worksFor": {"@id": SITE + "/#isletme"}}
BRAND = {"@type": "Brand", "name": "NİS"}

# eski ad -> (yeni ad, alt başlık, slug, sayfa, logo, video, işletim sistemi, açıklama)
PRODUCTS = [
    ("Personel Devam Takip", "NİS PDKS", "Personel Devam Kontrol Sistemi", "yazilim-personel.html", "nis-pdks", "personel", "Web, Android, iOS",
     "NİS PDKS: telefondan giriş-çıkış, mesai planı, izin ve rapor talepleri, anlık bildirim ve puantaj tek ekranda."),
    ("Cari Mutabakat", "NİS Cari Mutabakat", "Cari Hesap Mutabakat Sistemi", "yazilim-cari-mutabakat.html", "nis-cari-mutabakat", "cari-mutabakat", "Web, Windows",
     "NİS Cari Mutabakat: Logo ERP bakiyelerinden uçtan uca dijital cari mutabakat akışı."),
    ("Banka Ekstre → Logo", "NİS Banka XML", "Logo Uyumlu Banka Aktarım Sistemi", "yazilim-banka-logo.html", "nis-banka-xml", "banka-xml", "Web, Windows",
     "NİS Banka XML: banka ekstrelerini Logo uyumlu XML'e çevirir; otomatik sınıflandırma, cari ve muhasebe kodu kontrolü, mükerrer kayıt engeli."),
    ("Yıllık İzin Yönetimi", "NİS İzin Takip", "Personel Yıllık İzin Takip Programı", "yazilim-yillik-izin.html", "nis-izin-takip", "yillik-izin", "Web, Windows Server",
     "NİS İzin Takip: personel yıllık izin haklarını, kalan günleri ve izin taleplerini tek yerde, hatasız takip edin."),
    ("Satınalma Denetim", "NİS Satınalma Denetim", "Satınalma Denetim Sistemi", "yazilim-satinalma-denetim.html", "nis-satinalma-denetim", "satinalma-denetim", "Web",
     "NİS Satınalma Denetim: faturaları fiyat ve iskonto açısından denetler, tedarikçileri karşılaştırır, farkları kanıtlı raporlar."),
    ("Cari360", "NİS Cari 360", "Cari ve Finans Takip Sistemi", "yazilim-cari360.html", "nis-cari360", "cari360", "Web",
     "NİS Cari 360: Logo SQL ve e-Fatura verilerini birleştiren cari ve finans takip sistemi; gerçek bakiye ve cari hareket detayı tek ekranda."),
]
OLD_EXTRA = {"Yıllık İzin Yönetimi": ["Yıllık İzin Takip"], "Banka Ekstre → Logo": ["Banka Ekstre Logo"]}  # ana sayfadaki kart adı

PAGES = {
    "index.html": ("Özkan Demir | Serbest Muhasebeci Mali Müşavir · Ankara", None, "ozkan-demir", "1.0"),
    "hizmetler.html": (None, None, "ozkan-demir", "0.8"),
    "yazilimlar.html": ("NİS Yazılımları | Özkan Demir SMMM",
                        "NİS yazılım ailesi: PDKS, Banka XML, Satınalma Denetim, İzin Takip, Cari 360 ve Cari Mutabakat. Logo ERP uyumlu, mali müşavir gözüyle geliştirildi.",
                        "ozkan-demir", "0.9"),
    "muhasebe-merkezi.html": (None, None, "ozkan-demir", "0.7"),
    "canli-veriler.html": (None, None, "ozkan-demir", "0.6"),
    "mevzuat.html": (None, None, "ozkan-demir", "0.7"),
    "hesaplama-araclari.html": (None, None, "ozkan-demir", "0.8"),
    "hakkimda.html": (None, None, "ozkan-demir", "0.7"),
    "iletisim.html": (None, None, "ozkan-demir", "0.7"),
}

def rename(h, old, new):
    # düz ve URL kodlu biçim; zaten "NİS ..." olanlara dokunma
    h = re.sub(r"(?<!NİS )" + re.escape(old), new, h)
    eo, en = up.quote(old), up.quote(new)
    h = re.sub(r"(?<!" + re.escape(up.quote("NİS ")) + r")" + re.escape(eo), en, h)
    return h

def ld(obj):
    return '<script type="application/ld+json">' + json.dumps({"@context": "https://schema.org", **obj}, ensure_ascii=False, separators=(",", ":")) + "</script>"

def head_block(path, title, desc, og, ldobjs, otype="website"):
    url = SITE + ("/" if path == "index.html" else "/" + path)
    e = lambda s: s.replace("&", "&amp;").replace('"', "&quot;")
    tags = [f'<link rel="canonical" href="{url}">',
            '<meta property="og:site_name" content="Özkan Demir SMMM">', '<meta property="og:locale" content="tr_TR">',
            f'<meta property="og:type" content="{otype}">', f'<meta property="og:title" content="{e(title)}">',
            f'<meta property="og:description" content="{e(desc)}">', f'<meta property="og:url" content="{url}">',
            f'<meta property="og:image" content="{SITE}/assets/og/{og}.jpg">', '<meta property="og:image:width" content="1200">',
            '<meta property="og:image:height" content="630">', '<meta name="twitter:card" content="summary_large_image">']
    return "<!--seo-->" + "".join(tags) + "".join(ld(o) for o in ldobjs) + "<!--/seo-->"

def apply_head(h, path, title, desc, og, ldobjs):
    h = re.sub(r"<!--seo-->.*?<!--/seo-->", "", h, flags=re.S)
    if title: h = re.sub(r"<title>[^<]*</title>", f"<title>{title}</title>", h, count=1)
    if desc: h = re.sub(r'<meta name="description" content="[^"]*">', f'<meta name="description" content="{desc}">', h, count=1)
    t = re.search(r"<title>([^<]*)</title>", h).group(1)
    d = re.search(r'<meta name="description" content="([^"]*)">', h).group(1)
    blk = head_block(path, t, d, og, ldobjs)
    return h.replace('<meta name="theme-color"', blk + '<meta name="theme-color"', 1)

def crumbs(items):
    return {"@type": "BreadcrumbList", "itemListElement": [
        {"@type": "ListItem", "position": i + 1, "name": n, "item": SITE + u} for i, (n, u) in enumerate(items)]}

files = {p.name: p.read_text(encoding="utf-8") for p in ROOT.glob("*.html")}

# 1) Ürün adları her yerde NİS
for old, new, *_ in PRODUCTS:
    for name in list(files):
        for o in [old] + OLD_EXTRA.get(old, []):
            files[name] = rename(files[name], o, new)

# 2) Ürün sayfaları: başlık, açıklama, logo, yapısal veri
for old, new, sub, page, logo, video, osys, desc in PRODUCTS:
    h = files[page]
    h = re.sub(r'<img class="product-logo"[^>]*>', "", h)
    if logo:
        from PIL import Image
        w, hh = Image.open(ROOT / "assets/brand" / f"{logo}.webp").size
        h = h.replace('<div><span class="eyebrow">ÖZEL İŞ YAZILIMI</span>',
                      f'<div><img class="product-logo" src="/assets/brand/{logo}.webp" alt="{new} logosu" width="{w}" height="{hh}"><span class="eyebrow">ÖZEL İŞ YAZILIMI</span>', 1)
    url = SITE + "/" + page
    app = {"@type": "SoftwareApplication", "name": new, "alternateName": f"{new} – {sub}", "description": desc,
           "applicationCategory": "BusinessApplication", "operatingSystem": osys, "url": url, "inLanguage": "tr",
           "brand": BRAND, "author": {"@id": SITE + "/#ozkan-demir"}, "publisher": {"@id": SITE + "/#isletme"},
           "screenshot": SITE + re.search(r'src="(/assets/software/[^"]+/01\.webp)"', h).group(1)}
    objs = [app, crumbs([("Ana Sayfa", "/"), ("Yazılımlar", "/yazilimlar.html"), (new, "/" + page)])]
    if video:
        objs.append({"@type": "VideoObject", "name": f"{new} Tanıtım Filmi", "description": desc,
                     "thumbnailUrl": f"{SITE}/assets/video/{video}-poster.webp", "uploadDate": TODAY + "T00:00:00+03:00",
                     "duration": "PT1M", "contentUrl": f"{SITE}/assets/video/{video}.mp4", "inLanguage": "tr"})
    files[page] = apply_head(h, page, f"{new} – {sub} | Özkan Demir SMMM", desc, logo or "nis-cari-mutabakat", objs)

# 3) Diğer sayfalar
for page, (title, desc, og, _) in PAGES.items():
    h = files[page]
    objs = []
    if page == "index.html": objs = [ORG, PERSON, {"@type": "WebSite", "name": "Özkan Demir SMMM", "url": SITE + "/", "inLanguage": "tr"}]
    elif page in ("hakkimda.html", "iletisim.html"): objs = [PERSON, ORG]
    elif page == "yazilimlar.html":
        objs = [{"@type": "ItemList", "name": "NİS Yazılımları", "itemListElement": [
                    {"@type": "ListItem", "position": i + 1, "name": p[1], "url": SITE + "/" + p[3]} for i, p in enumerate(PRODUCTS)]},
                {"@type": "VideoObject", "name": "NİS Yazılımları Tanıtım Filmi",
                 "description": "Mali müşavir Özkan Demir'in geliştirdiği NİS yazılımlarının tanıtım filmi.",
                 "thumbnailUrl": SITE + "/assets/video/nis-tanitim-poster.webp", "uploadDate": TODAY + "T00:00:00+03:00",
                 "duration": "PT1M11S", "contentUrl": SITE + "/assets/video/nis-tanitim.mp4", "inLanguage": "tr"},
                crumbs([("Ana Sayfa", "/"), ("Yazılımlar", "/yazilimlar.html")])]
    else:
        name = re.search(r"<h1>([^<]*)</h1>", h).group(1)
        objs = [crumbs([("Ana Sayfa", "/"), (name, "/" + page)])]
    files[page] = apply_head(h, page, title, desc, og, objs)

# mailto / WhatsApp bağlantılarında kodlanmamış karakter kalmasın
def fix_href(m):
    u = m.group(2)
    return m.group(1) + up.quote(u, safe=":/?&=%#@+,;~-._!*'()") + '"'
for name in files:
    files[name] = re.sub(r'(href=")((?:mailto:|https://wa\.me/)[^"]*)"', fix_href, files[name])

for name, h in files.items():
    (ROOT / name).write_text(h, encoding="utf-8")

# 4) robots.txt ve sitemap.xml
(ROOT / "robots.txt").write_text(
    "User-agent: *\nAllow: /\nDisallow: /panel\nDisallow: /indir/\nDisallow: /lisans/\nDisallow: /api/\n\nSitemap: " + SITE + "/sitemap.xml\n", encoding="utf-8")
prio = {p: v[3] for p, v in PAGES.items()} | {p[3]: "0.9" for p in PRODUCTS}
urls = "".join(f"<url><loc>{SITE}{'/' if p == 'index.html' else '/' + p}</loc><lastmod>{TODAY}</lastmod><priority>{prio[p]}</priority></url>\n"
               for p in list(PAGES) + [p[3] for p in PRODUCTS])
(ROOT / "sitemap.xml").write_text('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + urls + "</urlset>\n", encoding="utf-8")
print("tamam:", len(files), "sayfa")
