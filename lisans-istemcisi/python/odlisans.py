# -*- coding: utf-8 -*-
"""
odlisans — ozkandemir.net online lisans istemcisi (V1.0)

NİS PDKS, Banka XML Aktarım, Satınalma Denetim, Cari Mutabakat, Yıllık İzin ve
Cari360 programlarına eklenmek üzere tek dosyalık, bağımlılıksız (yalnızca Python
standart kütüphanesi) lisans modülü. Python 3.8+.

Kurallar (ozkandemir.net paneliyle aynı):
  * Anahtar bir kez "İnternet ile etkinleştir" ile bu cihaza bağlanır.
  * Program 7 günde bir lisansı çevrimiçi doğrular.
  * İnternet yoksa son başarılı doğrulamadan itibaren 30 gün çalışır.
  * Süre biter, lisans askıya alınır / iptal edilir / cihaz kaldırılırsa program KİLİTLENİR.
  * Lisans dosyası ozkandemir.net tarafından Ed25519 ile imzalıdır; değiştirilemez,
    başka bilgisayara kopyalanamaz (cihaz parmak izine bağlıdır).

Hızlı kullanım:
    from odlisans import LicenseClient
    lic = LicenseClient(product="NPDK", public_key=ACIK_ANAHTAR, app_version="2.0.0")
    durum = lic.state()          # açılışta
    if not durum.ok:
        ... lisans ekranını göster; lic.activate(anahtar) ...
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import platform
import socket
import ssl
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Callable, Dict, List, Optional

__version__ = "1.0.0"

DEFAULT_SERVER = "https://ozkandemir.net"
PRODUCTS = {
    "NPDK": "NİS PDKS",
    "BNKX": "Banka XML Aktarım",
    "SATD": "Satınalma Denetim",
    "CRMT": "Cari Mutabakat",
    "IZIN": "Yıllık İzin",
    "C360": "Cari360",
}
TR_TZ = timezone(timedelta(hours=3))

# ---------------------------------------------------------------------------
# Ed25519 doğrulama (RFC 8032 referans algoritması, saf Python)
# ---------------------------------------------------------------------------
_P = 2 ** 255 - 19
_L = 2 ** 252 + 27742317777372353535851937790883648493
_D = -121665 * pow(121666, _P - 2, _P) % _P
_I = pow(2, (_P - 1) // 4, _P)


def _inv(x: int) -> int:
    return pow(x, _P - 2, _P)


def _recover_x(y: int, sign: int) -> Optional[int]:
    if y >= _P:
        return None
    x2 = (y * y - 1) * _inv(_D * y * y + 1)
    if x2 == 0:
        return None if sign else 0
    x = pow(x2, (_P + 3) // 8, _P)
    if (x * x - x2) % _P != 0:
        x = x * _I % _P
    if (x * x - x2) % _P != 0:
        return None
    if (x & 1) != sign:
        x = _P - x
    return x


def _add(a, b):
    A = (a[1] - a[0]) * (b[1] - b[0]) % _P
    B = (a[1] + a[0]) * (b[1] + b[0]) % _P
    C = 2 * a[3] * b[3] * _D % _P
    D = 2 * a[2] * b[2] % _P
    E, F, G, H = B - A, D - C, D + C, B + A
    return (E * F % _P, G * H % _P, F * G % _P, E * H % _P)


def _mul(s: int, pt):
    q = (0, 1, 1, 0)
    while s > 0:
        if s & 1:
            q = _add(q, pt)
        pt = _add(pt, pt)
        s >>= 1
    return q


def _equal(a, b) -> bool:
    return (a[0] * b[2] - b[0] * a[2]) % _P == 0 and (a[1] * b[2] - b[1] * a[2]) % _P == 0


_GY = 4 * _inv(5) % _P
_GX = _recover_x(_GY, 0)
_G = (_GX, _GY, 1, _GX * _GY % _P)


def _decompress(s: bytes):
    if len(s) != 32:
        return None
    y = int.from_bytes(s, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    x = _recover_x(y, sign)
    if x is None:
        return None
    return (x, y, 1, x * y % _P)


def ed25519_verify(public_key: bytes, message: bytes, signature: bytes) -> bool:
    if len(public_key) != 32 or len(signature) != 64:
        return False
    a = _decompress(public_key)
    r = _decompress(signature[:32])
    if a is None or r is None:
        return False
    s = int.from_bytes(signature[32:], "little")
    if s >= _L:
        return False
    h = int.from_bytes(hashlib.sha512(signature[:32] + public_key + message).digest(), "little") % _L
    return _equal(_mul(s, _G), _add(r, _mul(h, a)))


# ---------------------------------------------------------------------------
# Yardımcılar
# ---------------------------------------------------------------------------
def _b64url_decode(s: str) -> bytes:
    s = s.strip()
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _b64url_encode(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")


def verify_token(public_key_x: str, token: str) -> Optional[dict]:
    """İmzalı lisans belgesini doğrular; geçerliyse içeriğini, değilse None döndürür."""
    try:
        tag, body, sig = str(token).strip().split(".")
        if tag != "ODL1":
            return None
        if not ed25519_verify(_b64url_decode(public_key_x), body.encode("ascii"), _b64url_decode(sig)):
            return None
        payload = json.loads(_b64url_decode(body).decode("utf-8"))
        return payload if payload.get("typ") == "od-license" else None
    except Exception:
        return None


def normalize_key(key: str) -> str:
    raw = "".join(ch for ch in str(key).upper() if ch.isalnum())
    if len(raw) != 20:
        return str(key).strip().upper()
    return "-".join([raw[0:4], raw[4:8], raw[8:12], raw[12:16], raw[16:20]])


def _machine_guid() -> str:
    """Bilgisayara özgü, yeniden kurulumda değişmeyen kimlik."""
    try:
        if sys.platform.startswith("win"):
            import winreg  # type: ignore
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Cryptography", 0,
                                winreg.KEY_READ | getattr(winreg, "KEY_WOW64_64KEY", 0)) as k:
                return str(winreg.QueryValueEx(k, "MachineGuid")[0])
        for p in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
            if os.path.exists(p):
                with open(p, "r", encoding="ascii", errors="ignore") as f:
                    v = f.read().strip()
                    if v:
                        return v
        if sys.platform == "darwin":
            import subprocess
            out = subprocess.run(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"], capture_output=True, text=True, timeout=5).stdout
            for line in out.splitlines():
                if "IOPlatformUUID" in line:
                    return line.split('"')[-2]
    except Exception:
        pass
    return "mac-%012x" % uuid.getnode()


def device_fingerprint(product: str) -> str:
    return hashlib.sha256(f"odl|{product}|{_machine_guid()}".encode("utf-8")).hexdigest()


def _default_dir(product: str) -> str:
    if sys.platform.startswith("win"):
        base = os.environ.get("PROGRAMDATA") or os.path.expanduser("~")
        return os.path.join(base, "OzkanDemir", "Lisans", product)
    return os.path.join(os.path.expanduser("~"), ".ozkandemir", "lisans", product)


def _fmt_date(ts: int) -> str:
    return datetime.fromtimestamp(ts, TR_TZ).strftime("%d.%m.%Y")


# ---------------------------------------------------------------------------
# Lisans durumu
# ---------------------------------------------------------------------------
@dataclass
class LicenseState:
    ok: bool
    code: str                       # active | no_license | expired | suspended | revoked | device_removed | offline_too_long | tampered | invalid
    message: str
    customer: str = ""
    program: str = ""
    key: str = ""                   # maskeli
    expires_at: Optional[int] = None
    limits: Dict[str, int] = field(default_factory=dict)
    modules: List[str] = field(default_factory=list)
    last_check: Optional[int] = None
    valid_until: Optional[int] = None
    warning: str = ""               # uyarı (süre yaklaşıyor / uzun süredir doğrulanamadı)

    @property
    def expires(self) -> str:
        return _fmt_date(self.expires_at) if self.expires_at else ""

    @property
    def days_left(self) -> Optional[int]:
        return None if not self.expires_at else max(0, int((self.expires_at - time.time()) // 86400))

    def limit(self, name: str, default: int = 0) -> int:
        return int(self.limits.get(name, default))

    def has_module(self, name: str) -> bool:
        return name in self.modules

    def to_dict(self) -> dict:
        d = self.__dict__.copy()
        d.update(expires=self.expires, days_left=self.days_left)
        return d


MESSAGES = {
    "no_license": "Bu bilgisayarda etkin lisans yok. Lisans anahtarınızı girerek etkinleştirin.",
    "expired": "Lisans süresi dolmuş. Yenileme için Özkan Demir ile iletişime geçin (0551 600 77 87).",
    "suspended": "Lisans askıya alınmış. Lütfen Özkan Demir ile iletişime geçin (0551 600 77 87).",
    "revoked": "Lisans iptal edilmiş. Lütfen Özkan Demir ile iletişime geçin (0551 600 77 87).",
    "device_removed": "Bu bilgisayarın lisansı kaldırılmış. Lisansı yeniden etkinleştirin.",
    "offline_too_long": "Lisans 30 gündür doğrulanamadı. İnternet bağlantısını kontrol edip tekrar deneyin.",
    "tampered": "Sistem saati geri alınmış görünüyor. Saati düzeltip programı yeniden başlatın.",
    "invalid": "Lisans dosyası geçersiz veya bu bilgisayara ait değil. Lisansı yeniden etkinleştirin.",
    "restored": "Eski bir lisans dosyası geri yüklenmiş görünüyor. Programı internete bağlayıp lisansı doğrulayın.",
    "not_started": "Lisans henüz başlamadı.",
}


class LicenseError(Exception):
    def __init__(self, message: str, code: str = "error"):
        super().__init__(message)
        self.code = code
        self.message = message


# ---------------------------------------------------------------------------
# İstemci
# ---------------------------------------------------------------------------
class LicenseClient:
    CHECK_RETRY = 6 * 3600  # doğrulama zamanı geldi ama internet yoksa 6 saatte bir tekrar dene

    def __init__(self, product: str, public_key: str, app_version: str = "",
                 data_dir: Optional[str] = None, server: str = DEFAULT_SERVER,
                 usage_provider: Optional[Callable[[], Dict[str, int]]] = None,
                 device_name: Optional[str] = None, timeout: int = 15):
        product = product.upper()
        if product not in PRODUCTS:
            raise ValueError("Bilinmeyen ürün kodu: " + product)
        self.product = product
        self.public_key = public_key.strip()
        self.app_version = app_version
        self.server = server.rstrip("/")
        self.usage_provider = usage_provider
        self.device_id = device_fingerprint(product)
        self.device_name = (device_name or socket.gethostname() or "Bilgisayar")[:100]
        self.timeout = timeout
        self.data_dir = data_dir or _default_dir(product)
        self.path = os.path.join(self.data_dir, "lisans.json")
        self._lock = threading.Lock()
        self._cached: Optional[LicenseState] = None

    # ----- depolama -----
    def _load(self) -> dict:
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}

    def _save(self, data: dict) -> None:
        os.makedirs(self.data_dir, exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        os.replace(tmp, self.path)

    # ----- ikinci kayıt yeri (eski lisans dosyasının geri yüklenmesine ve saat oynamaya karşı) -----
    def _mirror_id(self) -> str:
        return hashlib.sha256(f"{self.product}|{os.path.abspath(self.data_dir)}".encode("utf-8")).hexdigest()[:16]

    def _read_mirror(self) -> dict:
        try:
            if sys.platform.startswith("win"):
                import winreg  # type: ignore
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\OzkanDemir\Lisans") as k:
                    return json.loads(winreg.QueryValueEx(k, self._mirror_id())[0])
            with open(os.path.join(os.path.expanduser("~"), ".config", ".odl-" + self._mirror_id()), "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}

    def _write_mirror(self, max_seen: int, max_iat: int) -> None:
        cur = self._read_mirror()
        val = {"s": max(int(cur.get("s", 0)), int(max_seen)), "i": max(int(cur.get("i", 0)), int(max_iat))}
        if val == cur:
            return
        try:
            if sys.platform.startswith("win"):
                import winreg  # type: ignore
                with winreg.CreateKey(winreg.HKEY_CURRENT_USER, r"Software\OzkanDemir\Lisans") as k:
                    winreg.SetValueEx(k, self._mirror_id(), 0, winreg.REG_SZ, json.dumps(val))
            else:
                d = os.path.join(os.path.expanduser("~"), ".config")
                os.makedirs(d, exist_ok=True)
                with open(os.path.join(d, ".odl-" + self._mirror_id()), "w", encoding="utf-8") as f:
                    json.dump(val, f)
        except Exception:
            pass

    # ----- ağ -----
    def _post(self, path: str, body: dict) -> dict:
        req = urllib.request.Request(
            self.server + path, data=json.dumps(body).encode("utf-8"), method="POST",
            headers={"content-type": "application/json", "user-agent": f"odlisans/{__version__} ({self.product} {self.app_version})"})
        ctx = ssl.create_default_context()
        try:
            with urllib.request.urlopen(req, timeout=self.timeout, context=ctx) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                return json.loads(e.read().decode("utf-8"))
            except Exception:
                raise LicenseError(f"Lisans sunucusu yanıt vermedi ({e.code}).", "network")
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise LicenseError("Lisans sunucusuna bağlanılamadı. İnternet bağlantısını kontrol edin.", "network") from e

    def _body(self, key: str) -> dict:
        usage = {}
        if self.usage_provider:
            try:
                usage = {k: int(v) for k, v in (self.usage_provider() or {}).items()}
            except Exception:
                usage = {}
        return {"key": key, "device_id": self.device_id, "device_name": self.device_name,
                "os": f"{platform.system()} {platform.release()}"[:100], "app_version": self.app_version,
                "product": self.product, "usage": usage}

    def _accept(self, data: dict, key: str, resp: dict) -> Optional[dict]:
        """Sunucudan gelen imzalı belgeyi doğrular ve saklar."""
        token = resp.get("token")
        payload = verify_token(self.public_key, token) if token else None
        if not payload or payload.get("device") != self.device_id or payload.get("product") != self.product:
            return None
        data.update(key=key, token=token, last_check=int(time.time()), max_seen=max(int(time.time()), int(data.get("max_seen", 0))))
        self._save(data)
        self._write_mirror(data["max_seen"], int(payload.get("iat", 0)))
        return payload

    # ----- herkese açık işlemler -----
    def activate(self, key: str) -> LicenseState:
        """Anahtarı bu bilgisayarda etkinleştirir. Hata durumunda LicenseError fırlatır."""
        key = normalize_key(key)
        if key[:4] != self.product:
            raise LicenseError(f"Bu anahtar {PRODUCTS.get(key[:4], 'başka bir programa')} ait.", "wrong_product")
        resp = self._post("/lisans/api/activate", self._body(key))
        data = self._load()
        if resp.get("ok"):
            if not self._accept(data, key, resp):
                raise LicenseError("Sunucudan gelen lisans doğrulanamadı.", "invalid")
            self._cached = None
            return self.state(online=False)
        if resp.get("token"):
            self._accept(data, key, resp)  # imzalı kilit belgesi
        raise LicenseError(resp.get("message") or "Etkinleştirme başarısız.", resp.get("code", "error"))

    def check_now(self) -> LicenseState:
        """Hemen çevrimiçi doğrulama yapar (sonuç ne olursa olsun durum döner)."""
        data = self._load()
        if not data.get("key"):
            return self._evaluate(data)
        try:
            resp = self._post("/lisans/api/check", self._body(data["key"]))
            self._accept(data, data["key"], resp)
        except LicenseError:
            data["last_attempt"] = int(time.time())
            self._save(data)
        return self._evaluate(self._load())

    def state(self, online: bool = True) -> LicenseState:
        """Geçerli lisans durumu. Doğrulama zamanı geldiyse (7 gün) sunucuya sorar."""
        with self._lock:
            data = self._load()
            payload = verify_token(self.public_key, data.get("token", "")) if data.get("token") else None
            now = int(time.time())
            if online and data.get("key") and payload:
                due = now >= int(payload.get("check_after", 0))
                retry_ok = now - int(data.get("last_attempt", 0)) >= self.CHECK_RETRY
                if due and retry_ok:
                    st = self.check_now()
                    self._cached = st
                    return st
            st = self._evaluate(data)
            if st.ok and now > int(data.get("max_seen", 0)):
                data["max_seen"] = now
                try:
                    self._save(data)
                except OSError:
                    pass
                self._write_mirror(now, 0)
            self._cached = st
            return st

    def cached_state(self) -> LicenseState:
        """Son hesaplanan durum (sık çağrılan yerlerde, ör. her HTTP isteğinde)."""
        if self._cached is None:
            return self.state(online=False)
        st = self._cached
        if st.ok and st.valid_until and time.time() > st.valid_until:
            return self.state(online=False)
        return st

    def start_background_checks(self, interval_hours: float = 6) -> threading.Thread:
        """Sürekli çalışan sunucu uygulamaları (FastAPI vb.) için arka plan doğrulaması."""
        def loop():
            while True:
                try:
                    self.state(online=True)
                except Exception:
                    pass
                time.sleep(interval_hours * 3600)
        t = threading.Thread(target=loop, name="odlisans", daemon=True)
        t.start()
        return t

    def offline_request_code(self, key: str) -> str:
        """İnternet olmayan sunucu için istek kodu. Bu kod ozkandemir.net paneline yapıştırılır."""
        key = normalize_key(key)
        body = {"k": key, "d": self.device_id, "n": self.device_name, "o": f"{platform.system()} {platform.release()}",
                "v": self.app_version, "p": self.product}
        data = self._load()
        data["key"] = key
        self._save(data)
        return "ODR1." + _b64url_encode(json.dumps(body, ensure_ascii=False).encode("utf-8"))

    def install_offline_token(self, token: str) -> LicenseState:
        """Panelin verdiği lisans kodunu kurar."""
        payload = verify_token(self.public_key, token.strip())
        if not payload or payload.get("device") != self.device_id or payload.get("product") != self.product:
            raise LicenseError("Lisans kodu geçersiz veya bu bilgisayara ait değil.", "invalid")
        data = self._load()
        data.update(token=token.strip(), last_check=int(time.time()), max_seen=max(int(time.time()), int(data.get("max_seen", 0))))
        self._save(data)
        self._write_mirror(data["max_seen"], int(payload.get("iat", 0)))
        self._cached = None
        return self.state(online=False)

    def remove_local(self) -> None:
        """Yerel lisans dosyasını siler (ikinci kayıt korunur; eski dosya geri yüklenemez)."""
        try:
            os.remove(self.path)
        except FileNotFoundError:
            pass
        self._cached = None

    # ----- değerlendirme -----
    def _evaluate(self, data: dict) -> LicenseState:
        now = int(time.time())
        token = data.get("token")
        if not token:
            return LicenseState(False, "no_license", MESSAGES["no_license"])
        p = verify_token(self.public_key, token)
        if not p or p.get("device") != self.device_id or p.get("product") != self.product:
            return LicenseState(False, "invalid", MESSAGES["invalid"])
        base = dict(customer=p.get("customer", ""), program=p.get("program", ""), key=p.get("key", ""),
                    expires_at=p.get("expires"), limits=p.get("limits") or {}, modules=p.get("modules") or [],
                    last_check=data.get("last_check"), valid_until=p.get("valid_until"))
        status = p.get("status")
        if status != "active":
            return LicenseState(False, status or "invalid", p.get("message") or MESSAGES.get(status, MESSAGES["invalid"]), **base)
        # Saat geri alma ve eski dosyanın geri yüklenmesi kontrolü (ikinci kayıt yeriyle karşılaştırılır)
        mirror = self._read_mirror()
        max_seen = max(int(data.get("max_seen", 0)), int(mirror.get("s", 0)))
        if int(p.get("iat", 0)) < int(mirror.get("i", 0)):
            return LicenseState(False, "restored", MESSAGES["restored"], **base)
        if now < int(p.get("iat", 0)) - 86400 or now < max_seen - 86400:
            return LicenseState(False, "tampered", MESSAGES["tampered"], **base)
        if now >= int(p.get("expires", 0)):
            return LicenseState(False, "expired", MESSAGES["expired"], **base)
        if now >= int(p.get("valid_until", 0)):
            return LicenseState(False, "offline_too_long", MESSAGES["offline_too_long"], **base)
        warning = ""
        days = (int(p["expires"]) - now) // 86400
        if days <= 30:
            warning = f"Lisans süresi {_fmt_date(int(p['expires']))} tarihinde doluyor ({days} gün kaldı)."
        elif not p.get("offline") and now - int(p.get("iat", now)) > 8 * 86400:
            left = (int(p["valid_until"]) - now) // 86400
            warning = f"Lisans {int((now - int(p['iat'])) // 86400)} gündür doğrulanamadı. İnternet bağlantısı sağlanmazsa {left} gün sonra program kilitlenecek."
        return LicenseState(True, "active", "Lisans etkin.", warning=warning, **base)


# ---------------------------------------------------------------------------
# Komut satırı (deneme ve destek için)
# ---------------------------------------------------------------------------
def _main(argv=None) -> int:
    import argparse
    ap = argparse.ArgumentParser(description="ozkandemir.net lisans istemcisi")
    ap.add_argument("--product", required=True, help="NPDK, BNKX, SATD, CRMT, IZIN, C360")
    ap.add_argument("--public-key", required=True, help="LISANS-ACIK-ANAHTAR.txt içindeki değer")
    ap.add_argument("--server", default=DEFAULT_SERVER)
    ap.add_argument("--data-dir")
    ap.add_argument("--app-version", default="")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    sub.add_parser("check")
    a = sub.add_parser("activate"); a.add_argument("key")
    r = sub.add_parser("request-code"); r.add_argument("key")
    i = sub.add_parser("install"); i.add_argument("token")
    sub.add_parser("device")
    args = ap.parse_args(argv)
    c = LicenseClient(args.product, args.public_key, args.app_version, data_dir=args.data_dir, server=args.server)
    try:
        if args.cmd == "activate":
            st = c.activate(args.key)
        elif args.cmd == "check":
            st = c.check_now()
        elif args.cmd == "request-code":
            print(c.offline_request_code(args.key)); return 0
        elif args.cmd == "install":
            st = c.install_offline_token(args.token)
        elif args.cmd == "device":
            print(json.dumps({"device_id": c.device_id, "device_name": c.device_name, "data": c.path}, ensure_ascii=False, indent=1)); return 0
        else:
            st = c.state()
    except LicenseError as e:
        print(json.dumps({"ok": False, "code": e.code, "message": e.message}, ensure_ascii=False, indent=1))
        return 2
    print(json.dumps(st.to_dict(), ensure_ascii=False, indent=1))
    return 0 if st.ok else 1


if __name__ == "__main__":
    sys.exit(_main())
