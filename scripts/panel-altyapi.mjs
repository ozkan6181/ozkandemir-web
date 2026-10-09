#!/usr/bin/env node
// ozkandemir.net V3.6 — Panel altyapısını tek komutla kurar
// Kullanım:  npm run panel:altyapi
//  1) D1 veritabanı "ozkandemir-panel" (yoksa oluşturur)
//  2) R2 deposu "ozkandemir-programlar" (yoksa oluşturur, herkese kapalı)
//  3) wrangler.jsonc dosyasına veritabanı kimliğini ve bağlantıları yazar
//  4) Veritabanı tablolarını kurar (migrations)
// Tekrar çalıştırmak güvenlidir.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { patchWranglerConfig, parseJsonc, PANEL_DB, PANEL_BUCKET } from './setup-lib.mjs';

const DB = PANEL_DB;
const BUCKET = PANEL_BUCKET;
const CFG = 'wrangler.jsonc';
const win = process.platform === 'win32';

function wr(args, { capture = false } = {}) {
  const r = spawnSync('npx', ['wrangler', ...args], { encoding: 'utf8', shell: win, stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit' });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const fail = (m) => { console.error('\n✗ ' + m + '\n'); process.exit(1); };
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

console.log('\n=== ozkandemir.net · Panel altyapısı ===\n');
if (!fs.existsSync(CFG)) fail(`${CFG} bulunamadı. Komutu proje klasöründe çalıştırın.`);

// 0) Giriş kontrolü
const who = wr(['whoami'], { capture: true });
if (who.status !== 0 || /not authenticated|You are not/i.test(who.out)) fail('Cloudflare girişi yok. Önce: npx wrangler login');

// 1) D1
console.log('> D1 veritabanı kontrol ediliyor…');
function findDbId() {
  const l = wr(['d1', 'list', '--json'], { capture: true });
  try {
    const list = JSON.parse(l.out.slice(l.out.indexOf('['), l.out.lastIndexOf(']') + 1));
    const db = list.find((d) => d.name === DB);
    return db ? db.uuid || db.id : null;
  } catch { return null; }
}
let dbId = findDbId();
if (!dbId) {
  console.log(`> "${DB}" oluşturuluyor…`);
  const c = wr(['d1', 'create', DB], { capture: true });
  process.stdout.write(c.out);
  dbId = (c.out.match(UUID) || [])[0] || findDbId();
}
if (!dbId) fail('D1 veritabanı kimliği alınamadı. Cloudflare panelinde Workers & Pages → D1 bölümünü kontrol edin.');
console.log(`  ✓ D1: ${DB} (${dbId})`);

// 2) R2
console.log('> R2 deposu kontrol ediliyor…');
const r2 = wr(['r2', 'bucket', 'create', BUCKET], { capture: true });
if (r2.status === 0) console.log(`  ✓ R2 deposu oluşturuldu: ${BUCKET}`);
else if (/already exists|10004/i.test(r2.out)) console.log(`  ✓ R2 deposu zaten var: ${BUCKET}`);
else {
  process.stdout.write(r2.out);
  fail('R2 deposu oluşturulamadı. Cloudflare panelinde R2 Object Storage hizmetini bir kez etkinleştirin (ücretsiz kota için kart bilgisi istenebilir) ve komutu tekrar çalıştırın.');
}

// 3) wrangler.jsonc
let cfg;
try {
  cfg = patchWranglerConfig(fs.readFileSync(CFG, 'utf8'), dbId);
  parseJsonc(cfg); // yazmadan önce geçerliliğini doğrula
} catch (e) { fail(e.message); }
fs.writeFileSync(CFG, cfg);
console.log(`  ✓ ${CFG} güncellendi`);

// 4) Tablolar
console.log('> Veritabanı tabloları kuruluyor (onay sorulursa "y" yazın)…');
const m = wr(['d1', 'migrations', 'apply', DB, '--remote']);
if (m.status !== 0) fail('Tablolar kurulamadı. Komutu tekrar çalıştırabilirsiniz.');

console.log(`
✓ Altyapı hazır.

Sıradaki adımlar:
  1) Değişen wrangler.jsonc dosyasını GitHub'a gönderin (veya: npx wrangler deploy)
  2) npm run lisans:anahtar
  3) npm run panel:hesap
`);
