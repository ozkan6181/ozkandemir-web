-- ozkandemir.net V3.14 — NİS PDKS kurulum sağlık raporu (programdan saatte bir "saglik" isteği).
-- Her kurulum (lisans sahibi + makine) için yalnız SON rapor tutulur. Kişisel veri yoktur (personel yalnız sayı).
-- alerts_json: {sorun_anahtarı: son_e-posta_zamanı} — aynı sorun için günde bir uyarı. Mevcut tablolara dokunulmaz.
CREATE TABLE IF NOT EXISTS pdks_health (
  owner TEXT NOT NULL,                   -- odl:<lisans id> | lic:<eski lisans id>
  machine TEXT NOT NULL,
  license_id INTEGER,
  customer TEXT,
  host TEXT,
  version TEXT,
  license_state TEXT,
  payload_json TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  alerts_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (owner, machine)
);
CREATE INDEX IF NOT EXISTS idx_pdks_health_received ON pdks_health(received_at);
