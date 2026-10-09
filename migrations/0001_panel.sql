-- ozkandemir.net V3.6 — Yönetim paneli veritabanı (Cloudflare D1)
-- Zamanlar: Unix saniye (UTC)

CREATE TABLE IF NOT EXISTS admin (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  email TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  pass_changed_at INTEGER NOT NULL,
  totp_enc TEXT NOT NULL,
  totp_last_step INTEGER NOT NULL DEFAULT 0,
  totp_pending_enc TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS backup_codes (
  code_hash TEXT PRIMARY KEY,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS challenges (
  id_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT,
  location TEXT,
  ua TEXT,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS trusted_devices (
  id_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ua TEXT
);

CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  fails INTEGER NOT NULL,
  first_at INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS programs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id INTEGER NOT NULL REFERENCES programs(id),
  version TEXT NOT NULL,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT,
  notes TEXT,
  r2_key TEXT NOT NULL UNIQUE,
  upload_id TEXT,
  status TEXT NOT NULL DEFAULT 'uploading',
  created_at INTEGER NOT NULL,
  UNIQUE (program_id, version)
);

CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  version_id INTEGER NOT NULL REFERENCES versions(id),
  customer TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  max_downloads INTEGER NOT NULL,
  downloads INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  type TEXT NOT NULL,
  detail TEXT NOT NULL,
  ip TEXT,
  location TEXT,
  ua TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at);
CREATE INDEX IF NOT EXISTS idx_versions_program ON versions(program_id);
CREATE INDEX IF NOT EXISTS idx_links_version ON links(version_id);

INSERT OR IGNORE INTO programs (slug, name, created_at) VALUES
  ('nis-pdks', 'NİS PDKS', unixepoch()),
  ('banka-xml-aktarim', 'Banka XML Aktarım', unixepoch()),
  ('satinalma-denetim', 'Satınalma Denetim', unixepoch()),
  ('cari-mutabakat', 'Cari Mutabakat', unixepoch()),
  ('yillik-izin', 'Yıllık İzin', unixepoch()),
  ('cari360', 'Cari360', unixepoch());

-- Denetim kaydı değiştirilemez; yalnızca 1 yıldan eski kayıtlar silinebilir.
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
BEGIN SELECT RAISE(ABORT, 'Denetim kaydi degistirilemez'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_recent_delete BEFORE DELETE ON audit
WHEN OLD.at > unixepoch() - 31536000
BEGIN SELECT RAISE(ABORT, 'Denetim kaydi silinemez'); END;
