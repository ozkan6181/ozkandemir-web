// ozkandemir.net V3.8 — Bordro parametrelerinin yayını
// Herkese açık:  GET /pdks/parametreler.json  (NİS PDKS okur)
//                GET /params-2026.js          (sitedeki hesaplama araçları; yayınlanan değerlerle güncellenir)
// Panel:         /panel/api/payroll*         (oturum + yayında iki adımlı kod)
// Veritabanında yayın yoksa statik dosyalar olduğu gibi sunulur.
import { json, fail, first, all, run, readJson, fmtTR, audit } from './common.js';
import { cleanBase, buildPayroll, baseFromPayroll, derived, siteOverride, diffBase } from './bordro.js';
import { isoDateTR } from './license.js';
import { now } from './security.js';

const CACHE_MS = 60 * 1000;
let cache = { at: 0, db: null, row: undefined };

export function clearPayrollCache() { cache = { at: 0, db: null, row: undefined }; }

async function currentRow(env) {
  if (cache.db === env.DB && cache.row !== undefined && Date.now() - cache.at < CACHE_MS) return cache.row;
  const row = await first(env, 'SELECT id, base_json, note, created_at FROM payroll_params ORDER BY id DESC LIMIT 1');
  cache = { at: Date.now(), db: env.DB, row: row || null };
  return cache.row;
}

const meta = (row) => {
  const d = isoDateTR(row.created_at);
  return { guncelleme_tarihi: d, surum_tarihi: `${d}.${row.id}` };
};

// ---------- Herkese açık dosyalar ----------
export function isPayrollPublicPath(p) {
  return p === '/pdks/parametreler.json' || p === '/params-2026.js';
}

export async function servePayrollPublic(request, env, url) {
  let row = null;
  try { if (env.DB) row = await currentRow(env); } catch (e) { console.error('payroll', e); }
  if (!row) return env.ASSETS.fetch(request);
  let base;
  try { base = JSON.parse(row.base_json); } catch { return env.ASSETS.fetch(request); }
  if (url.pathname === '/pdks/parametreler.json') {
    return new Response(JSON.stringify(buildPayroll(base, meta(row)), null, 2) + '\n', {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=300',
        'access-control-allow-origin': '*',
      },
    });
  }
  // params-2026.js: statik dosyadaki takvim vb. korunur, bordro değerleri yayınlananla değiştirilir
  const asset = await env.ASSETS.fetch(new Request(new URL('/params-2026.js', url.origin)));
  if (!asset.ok) return asset;
  const text = await asset.text();
  const o = siteOverride(base, isoDateTR(now()));
  const js = `${text}\n;(function(P,o){if(!P)return;var f=function(l){return l.map(function(x){return [x[0]===null?Infinity:x[0],x[1]]})};o.tax={general:f(o.tax.general),wage:f(o.tax.wage)};for(var k in o)P[k]=o[k];})(typeof globalThis!=='undefined'?globalThis.PARAM2026:this.PARAM2026,${JSON.stringify(o)});\n`;
  return new Response(js, { headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=300' } });
}

// ---------- Panel ----------
async function staticBase(c) {
  const r = await c.env.ASSETS.fetch(new Request(new URL('/pdks/parametreler.json', c.url.origin)));
  return baseFromPayroll(await r.json());
}

async function currentBase(c) {
  const row = await currentRow(c.env);
  if (row) return { base: JSON.parse(row.base_json), row };
  return { base: await staticBase(c), row: null };
}

function settingsGet(env, name) {
  return first(env, 'SELECT value, updated_at FROM settings WHERE name = ?', name);
}

export async function getPayroll(c) {
  const { base, row } = await currentBase(c);
  const history = await all(c.env, 'SELECT id, base_json, note, created_at FROM payroll_params ORDER BY id DESC LIMIT 15');
  const alerts = await all(c.env, 'SELECT id, source, title, url, keyword, found_at, dismissed_at FROM source_alerts ORDER BY found_at DESC, id DESC LIMIT 30');
  const watch = await settingsGet(c.env, 'watch_status');
  return json({
    base,
    derived: derived(base),
    source: row ? 'panel' : 'dosya',
    published: row ? { id: row.id, at: fmtTR(row.created_at), note: row.note } : null,
    history: history.map((h, i) => ({
      id: h.id, at: fmtTR(h.created_at), note: h.note,
      changes: diffBase(history[i + 1] ? JSON.parse(history[i + 1].base_json) : null, JSON.parse(h.base_json)),
      current: i === 0,
    })),
    alerts: alerts.map((a) => ({ ...a, found: fmtTR(a.found_at), open: !a.dismissed_at })),
    openAlerts: alerts.filter((a) => !a.dismissed_at).length,
    watch: watch ? { ...JSON.parse(watch.value), at: fmtTR(watch.updated_at) } : null,
    urls: { pdks: `${c.url.origin}/pdks/parametreler.json` },
  });
}

export async function previewPayroll(c) {
  const b = await readJson(c.req);
  let base;
  try { base = cleanBase(b.base); } catch (e) { return fail(400, e.message); }
  const { base: cur } = await currentBase(c);
  return json({ derived: derived(base), changes: diffBase(cur, base) });
}

// Kod kontrolünden SONRA panel.js çağırır
export async function publishPayroll(c, rawBase, note) {
  let base;
  try { base = cleanBase(rawBase); } catch (e) { return fail(400, e.message); }
  const { base: cur } = await currentBase(c);
  const changes = diffBase(cur, base);
  if (!changes.length) return fail(400, 'Değişiklik yok; yayınlanacak yeni değer girilmedi.');
  const cleanNote = String(note || '').trim().slice(0, 300) || null;
  await run(c.env, 'INSERT INTO payroll_params (base_json, note, created_at) VALUES (?, ?, ?)', JSON.stringify(base), cleanNote, c.t);
  clearPayrollCache();
  await audit(c, 'Bordro', `Bordro parametreleri yayınlandı: ${changes.join(', ')}${cleanNote ? ' · ' + cleanNote : ''}`);
  return json({ ok: true, changes });
}

export async function restorePayroll(c, id) {
  const row = await first(c.env, 'SELECT * FROM payroll_params WHERE id = ?', Number(id));
  if (!row) return fail(404, 'Kayıt bulunamadı.');
  const latest = await currentRow(c.env);
  if (latest && latest.id === row.id) return fail(400, 'Bu kayıt zaten yayında.');
  await run(c.env, 'INSERT INTO payroll_params (base_json, note, created_at) VALUES (?, ?, ?)', row.base_json, `${fmtTR(row.created_at)} tarihli değerlere geri dönüldü`, c.t);
  clearPayrollCache();
  await audit(c, 'Bordro', `Bordro parametreleri ${fmtTR(row.created_at)} tarihli kayda geri alındı`);
  return json({ ok: true });
}

export async function dismissAlert(c, [, id]) {
  const r = await run(c.env, 'UPDATE source_alerts SET dismissed_at = ? WHERE id = ? AND dismissed_at IS NULL', c.t, Number(id));
  return json({ ok: true, changed: r.meta ? r.meta.changes : 0 });
}
