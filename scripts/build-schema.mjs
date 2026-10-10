// migrations/*.sql → src/panel/schema.js (panelin kendi kendini kurması için gömülü şema)
// Kullanım: node scripts/build-schema.mjs   (tests/test-config.mjs eşitliği denetler)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function readMigrations() {
  const dir = path.join(ROOT, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const stmts = [];
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8')
      .split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
    // Tetikleyici gövdeleri (BEGIN ... END;) içindeki noktalı virgüllerde bölme
    let buf = '';
    let depth = 0;
    for (const line of sql.split('\n')) {
      buf += line + '\n';
      const code = line.replace(/\s*--.*$/, '');
      if (/\bBEGIN\b/i.test(code)) depth++;
      if (/\bEND\s*;\s*$/i.test(code)) depth--;
      if (depth === 0 && /;\s*$/.test(code)) {
        const s = buf.trim().replace(/;\s*$/, '');
        if (s) stmts.push(s);
        buf = '';
      }
    }
    if (buf.trim()) stmts.push(buf.trim());
  }
  return { files, stmts };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { files, stmts } = readMigrations();
  const version = String(files.length);
  const out = `// ozkandemir.net — Veritabanı şeması (migrations/*.sql ile aynı; tests/test-config.mjs eşitliği denetler)
// Panel ilk açıldığında bu ifadeler tek işlemde (batch) çalıştırılır; tümü "IF NOT EXISTS" olduğundan tekrar çalışması güvenlidir.
// Bu dosya elle düzenlenmez: node scripts/build-schema.mjs
export const SCHEMA_VERSION = '${version}';
export const SCHEMA = [
${stmts.map((s) => '  ' + JSON.stringify(s) + ',').join('\n')}
];
`;
  fs.writeFileSync(path.join(ROOT, 'src/panel/schema.js'), out);
  console.log(`schema.js yazıldı: ${stmts.length} ifade, sürüm ${version}`);
}
