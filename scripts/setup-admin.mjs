#!/usr/bin/env node
// ozkandemir.net V3.6 — Yönetim paneli yönetici hesabı kurulumu
// Kullanım:  node scripts/setup-admin.mjs
// Telefon kaybolursa veya şifre unutulursa aynı komutla hesap sıfırlanır.
import readline from 'node:readline';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { buildAdminSetup } from './setup-lib.mjs';
import { base32Decode, verifyTotp } from '../src/panel/security.js';

const DB = 'ozkandemir-panel';
const SQL_FILE = 'panel-kurulum.sql';
const KEY_BACKUP = 'PANEL-SIFRELEME-ANAHTARI-YEDEK.txt';

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(question); };
    }
    rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a.trim()); });
  });
}
const run = (args, input) => spawnSync('npx', args, { stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'], input, shell: process.platform === 'win32' });

console.log('\n=== ozkandemir.net · Yönetim paneli hesabı kurulumu ===\n');
console.log('1) İlk kurulum');
console.log('2) Hesabı sıfırla (şifre unutuldu / telefon kayboldu) — lisanslar ve dosyalar korunur\n');
const mode = (await ask('Seçiminiz [1/2]: ')) === '2' ? 'reset' : 'first';
let encKey;
if (mode === 'reset') {
  if (fs.existsSync(KEY_BACKUP)) {
    encKey = (fs.readFileSync(KEY_BACKUP, 'utf8').match(/^[A-Za-z0-9+/]{43}=$/m) || [])[0];
  }
  if (!encKey) encKey = await ask(`İlk kurulumda saklanan PANEL_ENC_KEY değerini yapıştırın (${KEY_BACKUP}): `);
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encKey)) { console.log('✗ Anahtar biçimi hatalı. Sıfırlama yapılmadı.'); process.exit(1); }
  console.log('Mevcut şifreleme anahtarı kullanılacak; tüm açık oturumlar kapanacak.\n');
}

console.log('Cloudflare Workers planınız?  1) Ücretli (Workers Paid, önerilen)  2) Ücretsiz');
const plan = await ask('Seçiminiz [1/2]: ');
const iterations = plan === '2' ? 10000 : 100000;
if (plan === '2') console.log('  Ücretsiz planın 10 ms CPU sınırı için şifre özeti 10.000 turla üretilecek (giriş yine 2FA ile korunur).\n');

let email = (await ask('Giriş e-postası [ozkan6181@hotmail.com]: ')) || 'ozkan6181@hotmail.com';
let setup;
for (;;) {
  const pw = await ask('Yeni şifre (en az 14 karakter, büyük/küçük harf ve rakam): ', { hidden: true });
  const pw2 = await ask('Yeni şifre (tekrar): ', { hidden: true });
  if (pw !== pw2) { console.log('  ✗ Şifreler aynı değil.\n'); continue; }
  try { setup = await buildAdminSetup({ email, password: pw, encKey, iterations }); break; }
  catch (e) { console.log('  ✗ ' + e.message + '\n'); }
}

console.log('\n--- 1) Doğrulama uygulaması ---');
console.log('Telefonunuzda Google Authenticator veya Microsoft Authenticator açın:');
console.log('  "+" → "Kurulum anahtarı girin" → Hesap adı: ozkandemir.net → Tür: Zamana dayalı');
console.log('\n  Anahtar:  ' + setup.secretGrouped + '\n');
for (;;) {
  const code = await ask('Uygulamanın gösterdiği 6 haneli kodu yazın (kontrol için): ');
  if ((await verifyTotp(base32Decode(setup.secret), code, 0)) !== null) { console.log('  ✓ Kod doğru.\n'); break; }
  console.log('  ✗ Kod tutmadı. Telefonun saatinin otomatik olduğundan emin olun ve tekrar deneyin.');
}

console.log('--- 2) Yedek kodlar (telefon kaybolursa) ---');
console.log('Bunları yazdırın veya parola yöneticinize kaydedin. Her biri bir kez kullanılır:\n');
setup.codes.forEach((c, i) => console.log(`  ${String(i + 1).padStart(2)}.  ${c}`));
fs.writeFileSync(SQL_FILE, setup.sql);
if (mode === 'first') {
  fs.writeFileSync(KEY_BACKUP, `GİZLİ — ozkandemir.net panel şifreleme anahtarı (PANEL_ENC_KEY)\nHesap sıfırlamada gerekir. Lisans anahtarları ve doğrulama sırrı bununla şifrelenir.\nŞifreli bir USB'ye veya parola yöneticisine yedekleyip bu klasörden SİLİN.\n\n${setup.encKey}\n`);
  console.log(`\n!! ${KEY_BACKUP} oluşturuldu. Güvenli yere yedekleyin (hesap sıfırlamada gerekecek).`);
}

console.log('\n--- 3) Cloudflare\'a yükleme ---');
const auto = (await ask('\nŞimdi Cloudflare\'a yükleyeyim mi? (wrangler girişi yapılmış olmalı) [E/h]: ')).toLowerCase();
if (auto === '' || auto === 'e' || auto === 'evet') {
  let s = { status: 0 };
  if (mode === 'first') {
    console.log('\n> PANEL_ENC_KEY secret kaydediliyor…');
    s = run(['wrangler', 'secret', 'put', 'PANEL_ENC_KEY'], setup.encKey + '\n');
  }
  console.log('\n> Yönetici hesabı veritabanına yazılıyor…');
  const d = run(['wrangler', 'd1', 'execute', DB, '--remote', `--file=${SQL_FILE}`]);
  if (s.status === 0 && d.status === 0) {
    fs.rmSync(SQL_FILE, { force: true });
    console.log('\n✓ Kurulum tamam. Kurulum dosyası silindi. https://ozkandemir.net/panel/ adresinden giriş yapabilirsiniz.\n');
    process.exit(0);
  }
  console.log('\n✗ Otomatik adımlardan biri başarısız oldu. Aşağıdaki komutları elle çalıştırın.');
}
console.log(`
Elle kurulum:
  1) ${mode === 'first' ? `npx wrangler secret put PANEL_ENC_KEY   (değer: ${KEY_BACKUP} içinde)` : '(sıfırlamada secret değişmez)'}
  2) npx wrangler d1 execute ${DB} --remote --file=${SQL_FILE}
  3) ${SQL_FILE} dosyasını SİLİN.
`);
