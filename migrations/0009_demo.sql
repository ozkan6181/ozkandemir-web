-- ozkandemir.net V3.13 — Sitedeki "7 günlük demo iste" formundan gelen talepler.
-- Talep önce burada durur; yönetici panelden "Demo gönder" deyince 7 günlük deneme lisansı (licenses) oluşur ve
-- anahtar + indirme bağlantısı firmaya e-postayla gider. Mevcut tablolara dokunulmaz.
CREATE TABLE IF NOT EXISTS demo_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_slug TEXT NOT NULL,
  company TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  note TEXT,
  ip TEXT,
  mail_state TEXT NOT NULL DEFAULT 'pending',   -- bize bildirim: pending | sent
  state TEXT NOT NULL DEFAULT 'new',            -- new | sent | closed
  license_id INTEGER,
  sent_at INTEGER,
  closed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_demo_requests_ip ON demo_requests(ip, created_at);
CREATE INDEX IF NOT EXISTS idx_demo_requests_state ON demo_requests(state, created_at);
