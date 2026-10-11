-- ozkandemir.net V3.9 — Program içi "Cevabımı bulamadım" destek soruları (NİS PDKS Yardım merkezi)
-- Sorular önce burada saklanır, sonra destek e-postasına (info@ozkandemir.net) iletilir; e-posta gitmese de kaybolmaz.
CREATE TABLE IF NOT EXISTS support_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program TEXT NOT NULL,                 -- NİS PDKS
  customer TEXT NOT NULL,                -- lisanstaki müşteri adı
  license_ref TEXT,                      -- eski lisans kimliği ya da panel lisans no
  license_state TEXT,                    -- active | expired | suspended | deactivated
  machine TEXT,
  host TEXT,
  app_version TEXT,
  user_type TEXT,                        -- personel | yonetici
  lang TEXT,
  page TEXT,
  search TEXT,
  question TEXT NOT NULL,
  contact TEXT,
  asked_at TEXT,                         -- programdaki soru zamanı (yerel saat)
  dedupe TEXT NOT NULL UNIQUE,           -- aynı sorunun yeniden gönderimi tek kayıt olur
  received_at INTEGER NOT NULL,
  mail_state TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | failed
  mail_error TEXT,
  mail_tries INTEGER NOT NULL DEFAULT 0,
  answered_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_support_open ON support_questions(answered_at, received_at);
CREATE INDEX IF NOT EXISTS idx_support_mail ON support_questions(mail_state);
