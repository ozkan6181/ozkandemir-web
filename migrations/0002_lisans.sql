-- ozkandemir.net V3.6 — Online lisans yönetimi (Cloudflare D1)

CREATE TABLE IF NOT EXISTS licenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id INTEGER NOT NULL REFERENCES programs(id),
  key_hash TEXT NOT NULL UNIQUE,        -- SHA-256 (arama için)
  key_enc TEXT NOT NULL,                -- AES-256-GCM (panelde yeniden göstermek için)
  key_mask TEXT NOT NULL,               -- NPDK-7K2Q-••••-••••-H8WC
  customer TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  max_devices INTEGER NOT NULL DEFAULT 1,
  limits_json TEXT NOT NULL DEFAULT '{}',
  modules_json TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  status TEXT NOT NULL DEFAULT 'active',  -- active | suspended | revoked
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS activations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id INTEGER NOT NULL REFERENCES licenses(id),
  device_id TEXT NOT NULL,
  device_name TEXT,
  os TEXT,
  app_version TEXT,
  usage_json TEXT,
  ip TEXT,
  location TEXT,
  activated_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  removed_at INTEGER,
  UNIQUE (license_id, device_id)
);

CREATE TABLE IF NOT EXISTS license_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  type TEXT NOT NULL,
  detail TEXT NOT NULL,
  ip TEXT,
  location TEXT
);

CREATE INDEX IF NOT EXISTS idx_licenses_program ON licenses(program_id);
CREATE INDEX IF NOT EXISTS idx_licenses_ends ON licenses(ends_at);
CREATE INDEX IF NOT EXISTS idx_activations_license ON activations(license_id);
CREATE INDEX IF NOT EXISTS idx_license_events ON license_events(license_id, at);
CREATE INDEX IF NOT EXISTS idx_license_events_at ON license_events(at, type);
