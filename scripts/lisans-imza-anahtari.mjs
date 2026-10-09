#!/usr/bin/env node
// ozkandemir.net V3.6 — Lisans imza anahtarı (Ed25519) oluşturma
// Kullanım:  node scripts/lisans-imza-anahtari.mjs
//
// BİR KEZ çalıştırılır. Gizli anahtar Cloudflare'a secret olarak kaydedilir; açık anahtar
// LISANS-ACIK-ANAHTAR.txt dosyasına yazılır ve 6 programın içine gömülür.
// DİKKAT: Anahtarı yeniden üretmek, dağıtılmış tüm programların lisans doğrulamasını bozar.
import fs from 'node:fs';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { buildSigningKey } from './setup-lib.mjs';

const PUB = 'LISANS-ACIK-ANAHTAR.txt';
const BACKUP = 'LISANS-GIZLI-ANAHTAR-YEDEK.txt';
const ask = (q) => new Promise((ok) => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, (a) => { rl.close(); ok(a.trim().toLowerCase()); }); });

console.log('\n=== ozkandemir.net · Lisans imza anahtarı ===\n');
if (fs.existsSync(PUB)) {
  console.log(`${PUB} zaten var. Yeni anahtar üretirseniz dağıtılmış programlar lisans doğrulayamaz.`);
  if ((await ask('Yine de YENİ anahtar üretilsin mi? (evet yazın): ')) !== 'evet') { console.log('Vazgeçildi.'); process.exit(0); }
}
const { secret, publicX } = await buildSigningKey();
fs.writeFileSync(PUB, `ozkandemir.net lisans açık anahtarı (Ed25519)\nProgramlara gömülecek değer:\n\n${publicX}\n\nOluşturma: ${new Date().toISOString()}\n`);
fs.writeFileSync(BACKUP, `GİZLİ — ozkandemir.net lisans imza anahtarı\nBu dosyayı şifreli bir USB'ye / parola yöneticisine yedekleyip BİLGİSAYARDAN SİLİN.\nKaybolursa yeni lisans imzalanamaz; ele geçirilirse sahte lisans üretilebilir.\n\n${secret}\n`);
console.log(`✓ Açık anahtar: ${publicX}`);
console.log(`  (${PUB} dosyasına yazıldı — programlara bu değer gömülecek)\n`);

const auto = await ask('Gizli anahtarı şimdi Cloudflare\'a (LICENSE_SIGNING_KEY) kaydedeyim mi? [E/h]: ');
if (auto === '' || auto === 'e' || auto === 'evet') {
  const r = spawnSync('npx', ['wrangler', 'secret', 'put', 'LICENSE_SIGNING_KEY'], { stdio: ['pipe', 'inherit', 'inherit'], input: secret + '\n', shell: process.platform === 'win32' });
  if (r.status === 0) console.log('\n✓ LICENSE_SIGNING_KEY kaydedildi.');
  else console.log(`\n✗ Kaydedilemedi. Elle: npx wrangler secret put LICENSE_SIGNING_KEY  (değer ${BACKUP} içinde)`);
} else {
  console.log(`\nElle: npx wrangler secret put LICENSE_SIGNING_KEY  (değer ${BACKUP} içinde)`);
}
console.log(`\n!! ${BACKUP} dosyasını güvenli bir yere yedekleyip bu klasörden SİLİN.\n`);
