-- ozkandemir.net V3.10 — NİS PDKS uzaktan erişim adresleri (<ad>-pdks.ozkandemir.net, Cloudflare Tunnel)
-- Tünel çalıştırma anahtarı (token) SAKLANMAZ; gerektikçe Cloudflare API'den alınır.
CREATE TABLE IF NOT EXISTS tunnels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,                   -- lic:<eski lisans kimliği> | odl:<panel lisans no>
  license_id INTEGER,                    -- panel lisansıysa licenses.id (iptalde tüneller kapanır)
  customer TEXT NOT NULL,
  machine TEXT NOT NULL,
  host TEXT,                             -- müşteri sunucusunun adı
  name TEXT NOT NULL UNIQUE,             -- kitapsec
  hostname TEXT NOT NULL UNIQUE,         -- kitapsec-pdks.ozkandemir.net
  tunnel_id TEXT NOT NULL,
  dns_record_id TEXT,
  port INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (owner, machine)
);
CREATE INDEX IF NOT EXISTS idx_tunnels_license ON tunnels(license_id);

-- tunnel_create sınırı (lisans başına günde 5) ve iz kaydı
CREATE TABLE IF NOT EXISTS tunnel_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,                  -- create | delete | close
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_tunnel_log ON tunnel_log(owner, at);
