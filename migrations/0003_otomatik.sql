-- ozkandemir.net V3.7 — Otomatik kurulum: gizli anahtarlar ve web üzerinden ilk kurulum

CREATE TABLE IF NOT EXISTS system_keys (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS setup_pending (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  totp_enc TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
