-- ozkandemir.net V3.11 — 7 günlük deneme lisansları (programın ilk kurulum ekranındaki "7 gün dene")
-- Aynı e-posta ya da aynı sunucu (cihaz kimliği) ikinci kez deneme alamaz. Lisansın kendisi licenses tablosundadır.
CREATE TABLE IF NOT EXISTS trials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product TEXT NOT NULL,                 -- NPDK
  email TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_name TEXT,
  company TEXT NOT NULL,
  contact_name TEXT,
  phone TEXT,
  license_id INTEGER NOT NULL REFERENCES licenses(id),
  ip TEXT,
  sent_count INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_sent_at INTEGER NOT NULL,
  UNIQUE (product, email),
  UNIQUE (product, device_id)
);
CREATE INDEX IF NOT EXISTS idx_trials_ip ON trials(ip, last_sent_at);
