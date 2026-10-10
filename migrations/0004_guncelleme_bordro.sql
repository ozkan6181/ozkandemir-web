-- ozkandemir.net V3.8 — Güncelleme dağıtımı, bordro parametreleri, resmi kaynak takibi

-- Müşteri programlarına otomatik güncelleme olarak sunulan sürümler (yayın kanalı)
CREATE TABLE IF NOT EXISTS releases (
  version_id INTEGER PRIMARY KEY REFERENCES versions(id),
  program_id INTEGER NOT NULL REFERENCES programs(id),
  mandatory INTEGER NOT NULL DEFAULT 0,
  public_notes TEXT,
  published_at INTEGER NOT NULL
);

-- Bordro parametreleri: her yayın yeni satır, en son satır geçerlidir (geri alma = eski satırı yeniden yayınlama)
CREATE TABLE IF NOT EXISTS payroll_params (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  base_json TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL
);

-- Resmi kaynak takibi: bordroyu etkileyebilecek yeni duyurular
CREATE TABLE IF NOT EXISTS source_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  keyword TEXT,
  found_at INTEGER NOT NULL,
  dismissed_at INTEGER,
  UNIQUE (source, title)
);

-- Küçük ayarlar (kaynak takibi durumu, Access yapılandırması)
CREATE TABLE IF NOT EXISTS settings (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_releases_program ON releases(program_id);
CREATE INDEX IF NOT EXISTS idx_source_alerts_found ON source_alerts(found_at);
