// NİS PDKS bordro parametreleri dosyası testleri
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const P = createRequire(import.meta.url)('../public/params-2026.js');
const d = JSON.parse(fs.readFileSync(new URL('../public/pdks/parametreler.json', import.meta.url), 'utf8'));
assert.equal(d.sema, 'nis-pdks-bordro-parametreleri/1');
assert.equal(d.asgari_ucret.aylik_brut, P.minGross, 'site parametreleriyle aynı olmalı');
assert.equal(d.asgari_ucret.aylik_net, P.minNet);
assert.equal(d.sgk.tavan_aylik, P.sgkCeiling);
assert.equal(d.sgk.isveren_prim_orani.indirimsiz, P.employerSgkNoDiscount);
assert.equal(d.gelir_vergisi.ucret_tarifesi.at(-1).ust_sinir, null);
const ay = d.gelir_vergisi.asgari_ucret_istisnasi.aylik;
assert.equal(ay.length, 12);
assert.equal(ay[0].istisna_tutari, 4211.33);
// net asgari ücret = brüt − SGK − işsizlik (vergi istisnası nedeniyle)
assert.equal(Math.round((P.minGross * 0.85) * 100) / 100, d.asgari_ucret.aylik_net);
assert.equal(d.damga_vergisi.asgari_ucret_istisnasi_aylik, 250.7);
assert.equal(d.kidem_tazminati_tavani.at(-1).tutar, P.severanceCeiling);
// Mali takvim abonelik dosyası params-2026.js ile güncel olmalı (node scripts/takvim-ics.mjs)
const { buildIcs } = await import('../scripts/takvim-ics.mjs');
const ics = fs.readFileSync(new URL('../public/mali-takvim.ics', import.meta.url), 'utf8');
assert.equal(ics, buildIcs(P), 'mali-takvim.ics güncel değil: node scripts/takvim-ics.mjs');
assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, P.deadlines.length);
assert.ok(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75), 'satır uzunluğu en fazla 75 bayt');
console.log('pdks params tests: OK');
