-- ozkandemir.net V3.12 — "NİS PDKS + Yıllık İzin" paketi: aynı müşteriye birlikte verilen lisansları bağlar.
-- bundle_id = paketin ana (NİS PDKS) lisansının id'si. Mevcut licenses tablosu değişmez.
CREATE TABLE IF NOT EXISTS license_bundles (
  license_id INTEGER PRIMARY KEY REFERENCES licenses(id),
  bundle_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'pdks-izin',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_license_bundles_bundle ON license_bundles(bundle_id);
