// Yönetici hesabı kurulum çekirdeği (setup-admin.mjs ve testler kullanır)
import {
  hashPassword, passwordProblem, base32Encode, randomBytes, b64,
  encryptText, newBackupCodes, normalizeBackupCode, sha256hex, otpauthUri,
} from '../src/panel/security.js';

const sq = (s) => "'" + String(s).replace(/'/g, "''") + "'";

export async function buildAdminSetup({ email, password, encKey, iterations }) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Geçerli bir e-posta adresi girin.');
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  encKey = encKey || b64(randomBytes(32));
  const secret = base32Encode(randomBytes(20));
  const totpEnc = await encryptText(encKey, secret);
  const passHash = await hashPassword(password, undefined, iterations || undefined);
  const codes = newBackupCodes(10);
  const hashes = [];
  for (const c of codes) hashes.push(await sha256hex('bc:' + normalizeBackupCode(c)));
  const t = Math.floor(Date.now() / 1000);
  const sql = [
    '-- ozkandemir.net panel yönetici kurulumu. ÇALIŞTIRDIKTAN SONRA BU DOSYAYI SİLİN.',
    'DELETE FROM backup_codes;',
    `INSERT OR REPLACE INTO admin (id, email, pass_hash, pass_changed_at, totp_enc, totp_last_step, totp_pending_enc, updated_at) VALUES (1, ${sq(email)}, ${sq(passHash)}, ${t}, ${sq(totpEnc)}, 0, NULL, ${t});`,
    ...hashes.map((h) => `INSERT INTO backup_codes (code_hash) VALUES (${sq(h)});`),
    'UPDATE sessions SET revoked = 1;',
    'DELETE FROM trusted_devices;',
    'DELETE FROM login_attempts;',
    '',
  ].join('\n');
  return { sql, encKey, secret, secretGrouped: secret.match(/.{1,4}/g).join(' '), codes, uri: otpauthUri(secret, email), email };
}

// Lisans imza anahtar çifti (Ed25519). Gizli anahtar Worker secret'ı olur; açık anahtar programlara gömülür.
export async function buildSigningKey() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const secret = JSON.stringify({ kty: 'OKP', crv: 'Ed25519', d: jwk.d, x: jwk.x });
  return { secret, publicX: jwk.x };
}
