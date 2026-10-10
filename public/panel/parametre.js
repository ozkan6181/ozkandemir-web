/* ozkandemir.net V3.8 — Panel: bordro parametreleri ve resmi kaynak takibi */
(function () {
  'use strict';
  const { $, h } = window.OD;
  const A = () => window.ODApp;
  const st = { data: null, base: null, timer: null, seq: 0 };

  // ---------- Sayı biçimi (Türkçe: 33.030 / 64.948,77 / 21,75) ----------
  function parseNum(v) {
    let s = String(v ?? '').replace(/\s/g, '').replace(/[₺%‰]/g, '');
    if (!s) return NaN;
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    else if ((s.match(/\./g) || []).length > 1 || /^\d{1,3}\.\d{3}$/.test(s)) s = s.replace(/\./g, '');
    return Number(s);
  }
  const fmt = (n, max = 2) => (Number.isFinite(n) ? n.toLocaleString('tr-TR', { maximumFractionDigits: max }) : '');
  const tl = (n) => fmt(n) + ' TL';
  const pct = (r) => fmt(Math.round(r * 1e6) / 1e4, 4);   // 0.2175 → "21,75"
  const permil = (r) => fmt(Math.round(r * 1e7) / 1e4, 4); // 0.00759 → "7,59"

  // ---------- Form alanları ----------
  function input(value, attrs = {}) {
    return h('input', { class: 'input', inputmode: 'decimal', autocomplete: 'off', value, ...attrs });
  }
  function unitField(label, key, value, unit, help) {
    return h('label', { class: 'field' }, label,
      h('span', { class: 'unit' }, input(value, { 'data-k': key }), h('i', { text: unit })),
      help ? h('small', { class: 'muted', text: help }) : null);
  }

  function bracketTable(kind, rows) {
    const body = h('tbody', {});
    const draw = () => body.replaceChildren(...rows.map((r, i) => {
      const last = i === rows.length - 1;
      return h('tr', {},
        h('td', { class: 'num', text: `${i + 1}.` }),
        h('td', {}, last ? h('span', { class: 'muted small', text: 'Üzeri' }) : input(fmt(r[0]), { 'data-b': kind, 'data-i': i, 'data-c': 0, 'aria-label': `${i + 1}. dilim üst sınırı` })),
        h('td', {}, h('span', { class: 'unit' }, input(pct(r[1]), { 'data-b': kind, 'data-i': i, 'data-c': 1, 'aria-label': `${i + 1}. dilim oranı` }), h('i', { text: '%' }))));
    }));
    draw();
    return h('table', { class: 'ptbl' }, h('thead', {}, h('tr', {}, h('th', { text: '' }), h('th', { text: 'Kümülatif matrah üst sınırı (TL)' }), h('th', { text: 'Oran' }))), body);
  }

  function periodTable(kind, rows, withMethod) {
    const body = h('tbody', {});
    const wrap = h('div', {});
    function draw() {
      body.replaceChildren(...rows.map((r, i) => {
        const del = h('button', { type: 'button', class: 'btn btn-sm', 'aria-label': 'Dönemi sil', disabled: rows.length < 2 }, '×');
        del.addEventListener('click', () => { collect(); rows.splice(i, 1); draw(); schedule(); });
        const method = withMethod ? h('select', { class: 'select', 'data-p': kind, 'data-i': i, 'data-c': 'yontem' },
          h('option', { value: 'sabit', text: 'Sabit tutar' }),
          h('option', { value: 'gunluk_brut_asgari_ucret_orani', text: 'Günlük brütün %’si' })) : null;
        if (method) method.value = r.yontem || 'sabit';
        const isRate = withMethod && r.yontem === 'gunluk_brut_asgari_ucret_orani';
        if (method) method.addEventListener('change', () => { collect(); draw(); schedule(); });
        return h('tr', {},
          h('td', {}, h('input', { class: 'input', type: 'date', value: r.baslangic || '', 'data-p': kind, 'data-i': i, 'data-c': 'baslangic', 'aria-label': 'Başlangıç' })),
          h('td', {}, h('input', { class: 'input', type: 'date', value: r.bitis || '', 'data-p': kind, 'data-i': i, 'data-c': 'bitis', 'aria-label': 'Bitiş (boş: devam ediyor)' })),
          method ? h('td', {}, method) : null,
          h('td', {}, h('span', { class: 'unit' }, input(isRate ? pct(r.oran) : fmt(r.tutar), { 'data-p': kind, 'data-i': i, 'data-c': isRate ? 'oran' : 'tutar', 'aria-label': 'Değer' }), h('i', { text: isRate ? '%' : 'TL' }))),
          h('td', { class: 'x' }, del));
      }));
    }
    const add = h('button', { type: 'button', class: 'btn btn-sm' }, '+ Dönem ekle');
    add.addEventListener('click', () => {
      collect();
      const prev = rows[rows.length - 1] || {};
      rows.push({ baslangic: '', bitis: null, ...(withMethod ? { yontem: 'sabit', tutar: prev.tutar || 0 } : { tutar: prev.tutar || 0 }) });
      draw();
    });
    draw();
    wrap.append(h('div', { class: 'ptbl-wrap' }, h('table', { class: 'ptbl' + (withMethod ? ' ptbl-4' : '') },
      h('thead', {}, h('tr', {}, h('th', { text: 'Başlangıç' }), h('th', { text: 'Bitiş' }), withMethod ? h('th', { text: 'Yöntem' }) : null, h('th', { text: 'Değer' }), h('th', { text: '' }))),
      body)), add);
    return wrap;
  }

  // Oran bölmelerinde kayan nokta artığı kalmasın (7,59 / 1000 = 0.00759)
  const rnd = (x) => (Number.isFinite(x) ? Math.round(x * 1e10) / 1e10 : x);
  // Formdaki değerleri st.base'e toplar
  function collect() {
    const b = st.base;
    const form = $('#prmForm');
    const RATE = { isci_sgk: 1, isci_issizlik: 1, isveren_sgk_indirimsiz: 1, isveren_sgk_genel: 1, isveren_sgk_imalat: 1, isveren_issizlik: 1 };
    for (const el of form.querySelectorAll('[data-k]')) {
      const k = el.dataset.k;
      if (k === 'dogrulama_tarihi') { b[k] = el.value || null; continue; }
      const n = parseNum(el.value);
      if (k.startsWith('engelli')) b.engelli[Number(k.slice(-1))] = n;
      else if (RATE[k]) b[k] = rnd(n / 100);
      else if (k === 'damga_orani') b[k] = rnd(n / 1000);
      else b[k] = n;
    }
    for (const el of form.querySelectorAll('[data-b]')) {
      const list = b[el.dataset.b];
      const i = Number(el.dataset.i), c = Number(el.dataset.c);
      list[i][c] = c === 1 ? rnd(parseNum(el.value) / 100) : parseNum(el.value);
    }
    for (const el of form.querySelectorAll('[data-p]')) {
      const list = b[el.dataset.p];
      const row = list[Number(el.dataset.i)];
      const c = el.dataset.c;
      if (c === 'baslangic' || c === 'bitis') row[c] = el.value || null;
      else if (c === 'yontem') {
        row.yontem = el.value;
        if (el.value === 'sabit') { delete row.oran; if (!Number.isFinite(row.tutar)) row.tutar = 0; } else { delete row.tutar; if (!Number.isFinite(row.oran)) row.oran = 0; }
      } else if (c === 'oran') row.oran = rnd(parseNum(el.value) / 100);
      else row.tutar = parseNum(el.value);
    }
    return b;
  }

  function renderForm() {
    const b = st.base;
    const form = $('#prmForm');
    const sec = (title, hint, ...kids) => h('div', { class: 'prm-sec' }, h('h3', { text: title }), hint ? h('p', { class: 'hint', text: hint }) : null, ...kids);
    const note = h('input', { class: 'input', id: 'prmNote', maxlength: 300, placeholder: 'ör. 2027 asgari ücret Resmî Gazete 24.12.2026' });
    const code = A().codeField('prmCode', 'Yayın için doğrulama uygulamasındaki 6 haneli kod');
    const err = h('div', { class: 'alert', role: 'alert', hidden: true, id: 'prmMsg' });
    const changes = h('div', { class: 'alert alert-info', id: 'prmChanges', hidden: true });
    const btn = h('button', { type: 'submit', class: 'btn btn-navy', id: 'prmBtn' }, 'Yayınla');
    const reset = h('button', { type: 'button', class: 'btn' }, 'Değişiklikleri geri al');
    reset.addEventListener('click', () => load());
    form.replaceChildren(
      sec('Asgari ücret ve SGK', 'Asgari ücreti girdiğinizde net ücret, SGK tabanı/tavanı, günlük-saatlik ücret ve istisnalar kendiliğinden hesaplanır.',
        h('div', { class: 'prm-grid' },
          unitField('Yıl', 'yil', String(b.yil), ''),
          h('label', { class: 'field' }, 'Doğrulama tarihi', h('input', { class: 'input', type: 'date', 'data-k': 'dogrulama_tarihi', value: b.dogrulama_tarihi || '' })),
          unitField('Brüt asgari ücret (aylık)', 'asgari_brut', fmt(b.asgari_brut), 'TL'),
          unitField('SGK tavanı katsayısı', 'sgk_tavan_kat', fmt(b.sgk_tavan_kat), '×', 'Tavan = brüt asgari ücret × katsayı'))),
      sec('Prim oranları', null,
        h('div', { class: 'prm-grid' },
          unitField('İşçi SGK payı', 'isci_sgk', pct(b.isci_sgk), '%'),
          unitField('İşçi işsizlik payı', 'isci_issizlik', pct(b.isci_issizlik), '%'),
          unitField('İşveren SGK (indirimsiz)', 'isveren_sgk_indirimsiz', pct(b.isveren_sgk_indirimsiz), '%'),
          unitField('İşveren SGK (genel indirimli)', 'isveren_sgk_genel', pct(b.isveren_sgk_genel), '%'),
          unitField('İşveren SGK (imalat)', 'isveren_sgk_imalat', pct(b.isveren_sgk_imalat), '%'),
          unitField('İşveren işsizlik payı', 'isveren_issizlik', pct(b.isveren_issizlik), '%'))),
      sec('Gelir vergisi ve damga vergisi', 'Ücret tarifesi bordroda, genel tarife sitedeki diğer hesaplamalarda kullanılır.',
        h('b', { class: 'small', text: 'Ücret gelirleri tarifesi' }), bracketTable('ucret_dilimleri', b.ucret_dilimleri),
        h('b', { class: 'small', text: 'Genel tarife' }), bracketTable('genel_dilimleri', b.genel_dilimleri),
        h('div', { class: 'prm-grid' },
          unitField('Damga vergisi oranı', 'damga_orani', permil(b.damga_orani), '‰'),
          unitField('Engellilik indirimi 1. derece', 'engelli0', fmt(b.engelli[0]), 'TL'),
          unitField('Engellilik indirimi 2. derece', 'engelli1', fmt(b.engelli[1]), 'TL'),
          unitField('Engellilik indirimi 3. derece', 'engelli2', fmt(b.engelli[2]), 'TL'))),
      sec('Yemek ve yol istisnaları', 'Fiilen çalışılan gün başına tutarlar.',
        h('div', { class: 'prm-grid' },
          unitField('Yemek — gelir vergisi', 'yemek_gv', fmt(b.yemek_gv), 'TL'),
          unitField('Yemek kartı (KDV dahil)', 'yemek_karti', fmt(b.yemek_karti), 'TL'),
          unitField('Yol — gelir vergisi', 'yol_gv', fmt(b.yol_gv), 'TL')),
        h('b', { class: 'small', text: 'SGK yemek istisnası dönemleri' }), periodTable('yemek_sgk', b.yemek_sgk, true)),
      sec('Kıdem tazminatı tavanı', 'Yılda iki kez (Ocak ve Temmuz) memur maaş katsayısıyla değişir; bitişi boş bırakılan dönem devam ediyor sayılır.',
        periodTable('kidem', b.kidem, false)),
      sec('Yayın', 'Yayınladığınız anda NİS PDKS dosyası ve sitedeki hesaplama araçları yeni değerleri kullanır. Her yayın geçmişte saklanır, tek tıkla geri alınabilir.',
        changes,
        h('label', { class: 'field' }, 'Yayın notu (isteğe bağlı)', note),
        code, err,
        h('div', { class: 'btn-row' }, btn, reset)),
    );
  }

  // ---------- Önizleme (hesaplanan değerler + değişiklikler) ----------
  function schedule() {
    clearTimeout(st.timer);
    st.timer = setTimeout(preview, 350);
  }
  async function preview() {
    const seq = ++st.seq;
    let r;
    try {
      r = await A().call('/payroll/preview', { method: 'POST', body: { base: collect() } });
    } catch (e) {
      if (seq !== st.seq) return;
      A().msg($('#prmMsg'), e.message);
      $('#prmBtn').disabled = true;
      return;
    }
    if (seq !== st.seq) return;
    A().msg($('#prmMsg'), '');
    renderDerived(r.derived);
    const box = $('#prmChanges');
    box.hidden = false;
    if (r.changes.length) {
      box.replaceChildren(h('b', { text: `Yayınlanacak değişiklikler (${r.changes.length})` }), h('ul', { class: 'change-list' }, r.changes.map((c) => h('li', { text: c }))));
      $('#prmBtn').disabled = false;
    } else {
      box.replaceChildren(h('span', { text: 'Yayındaki değerlerle aynı; değişiklik yok.' }));
      $('#prmBtn').disabled = true;
    }
  }

  function renderDerived(d) {
    const row = (k, v) => h('div', {}, h('dt', { text: k }), h('dd', { text: v }));
    $('#prmDerived').replaceChildren(
      h('h2', { text: 'Otomatik hesaplanan' }),
      h('dl', { class: 'dlist' },
        row('Net asgari ücret', tl(d.asgari_net)),
        row('SGK tabanı (aylık)', tl(d.sgk_taban)),
        row('SGK tavanı (aylık)', tl(d.sgk_tavan)),
        row('Günlük brüt ücret', tl(d.gunluk_brut)),
        row('Saatlik brüt ücret', tl(d.saatlik_brut)),
        row('Damga vergisi istisnası', tl(d.damga_istisnasi))),
      h('h3', { text: 'Asgari ücret gelir vergisi istisnası' }),
      h('div', { class: 'months' }, d.gv_istisnasi.map((m) => h('span', {}, h('span', { text: m.ad.slice(0, 3) }), h('b', { text: m.istisna_tutari.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) })))));
  }

  function renderHistory(list) {
    const box = $('#prmHistory');
    box.replaceChildren(h('h2', { text: 'Yayın geçmişi' }));
    if (!list.length) { box.append(h('p', { class: 'muted small', text: 'Henüz panelden yayın yapılmadı; şu an varsayılan dosyadaki değerler kullanılıyor.' })); return; }
    for (const x of list) {
      const right = x.current ? h('span', { class: 'pill pill-ok', text: 'Yayında' }) : (() => {
        const b = h('button', { type: 'button', class: 'btn btn-sm' }, 'Geri al');
        b.addEventListener('click', () => restore(x));
        return b;
      })();
      box.append(h('div', { class: 'renew' },
        h('div', {}, h('b', { text: x.at }), h('small', { text: x.note || x.changes.join(', ') || '—' }), x.note && x.changes.length ? h('small', { text: x.changes.join(', ') }) : null),
        right));
    }
  }

  function restore(x) {
    const err = h('div', { class: 'alert', role: 'alert', hidden: true });
    const btn = h('button', { type: 'submit', class: 'btn btn-navy' }, 'Bu değerleri yeniden yayınla');
    const form = h('form', { class: 'modal-body', novalidate: true },
      h('p', { class: 'muted', text: `${x.at} tarihli değerler yeni bir yayın olarak geri yüklenir; mevcut değerler geçmişte kalır.` }),
      A().codeField('prmRestoreCode'), err, btn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      A().msg(err, '');
      btn.disabled = true;
      try {
        await A().call(`/payroll/${x.id}/restore`, { method: 'POST', body: { code: $('#prmRestoreCode').value.trim() } });
        A().closeModal();
        A().toast('Önceki değerler yeniden yayınlandı.');
        load();
      } catch (ex) { A().msg(err, ex.message); } finally { btn.disabled = false; }
    });
    A().openModal('Geri al', form);
  }

  function renderWatch(d) {
    const box = $('#prmWatch');
    const w = d.watch;
    const runBtn = h('button', { type: 'button', class: 'btn btn-sm' }, 'Şimdi tara');
    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      try {
        const r = await A().call('/watch/run', { method: 'POST', body: {} });
        A().toast(r.firstRun ? 'İlk tarama yapıldı; bundan sonra çıkan yeni başlıklar burada görünecek.' : r.found ? `${r.found} yeni başlık bulundu.` : 'Yeni başlık yok.');
        load();
      } catch (e) { A().toast(e.message, true); } finally { runBtn.disabled = false; }
    });
    const open = d.alerts.filter((a) => a.open);
    const closed = d.alerts.filter((a) => !a.open && a.dismissed_at !== a.found_at).slice(0, 4); // ilk taramanın sessiz kayıtları gösterilmez
    const status = w
      ? `Son tarama: ${w.at} · okunan: ${w.checked.join(', ') || '—'}${w.failed.length ? ' · okunamayan: ' + w.failed.join(', ') : ''}`
      : 'Henüz tarama yapılmadı. Site her sabah 07:17’de GİB, SGK ve Resmî Gazete sayfalarını kendiliğinden tarar.';
    const item = (a) => {
      const done = h('button', { type: 'button', class: 'btn btn-sm' }, 'İncelendi');
      done.addEventListener('click', async () => {
        try { await A().call(`/alerts/${a.id}/dismiss`, { method: 'POST', body: {} }); load(); } catch (e) { A().toast(e.message, true); }
      });
      return h('div', { class: 'alert-item' + (a.open ? '' : ' done') },
        h('div', {}, h('a', { href: a.url, target: '_blank', rel: 'noopener noreferrer', text: a.title }), h('small', { text: `${a.source} · ${a.keyword} · ${a.found}` })),
        a.open ? done : h('span', { class: 'pill pill-mute', text: 'İncelendi' }));
    };
    box.replaceChildren(
      h('div', { class: 'card-head' },
        h('div', {}, h('h2', { text: open.length ? `Resmi kaynaklarda ${open.length} yeni başlık` : 'Resmi kaynak takibi' }), h('p', { class: 'muted small', text: status })),
        runBtn),
      open.length
        ? h('p', { class: 'muted small', text: 'Bu başlıklar bordro parametrelerini etkileyebilir. Kaynağı açıp inceleyin; değer değiştiyse aşağıdan güncelleyip yayınlayın. Site değerleri kendiliğinden değiştirmez.' })
        : h('p', { class: 'muted small', text: 'İncelenmeyi bekleyen başlık yok.' }),
      h('div', { class: 'alert-list' }, open.map(item), closed.map(item)));
    const badge = $('#paramBadge');
    badge.textContent = String(open.length);
    badge.hidden = !open.length;
  }

  async function load() {
    let d;
    try { d = await A().call('/payroll'); } catch (e) { A().toast(e.message, true); return; }
    st.data = d;
    st.base = JSON.parse(JSON.stringify(d.base));
    $('#prmFile').href = d.urls.pdks;
    $('#prmSource').replaceChildren(d.published
      ? h('span', { class: 'pill pill-ok', text: `Panelden yayında · ${d.published.at}` })
      : h('span', { class: 'pill pill-info', text: 'Varsayılan dosya kullanılıyor' }));
    renderWatch(d);
    renderForm();
    renderDerived(d.derived);
    renderHistory(d.history);
    $('#prmBtn').disabled = true;
    $('#prmChanges').hidden = true;
  }

  $('#prmForm').addEventListener('input', (e) => { if (e.target.id !== 'prmNote' && e.target.id !== 'prmCode') schedule(); });
  $('#prmForm').addEventListener('change', (e) => { if (e.target.type === 'date') schedule(); });
  $('#prmForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#prmBtn');
    A().msg($('#prmMsg'), '');
    btn.disabled = true;
    try {
      const r = await A().call('/payroll', { method: 'POST', body: { base: collect(), note: $('#prmNote').value, code: $('#prmCode').value.trim() } });
      A().toast(`Yayınlandı: ${r.changes.join(', ')}`);
      load();
    } catch (ex) {
      A().msg($('#prmMsg'), ex.message);
      btn.disabled = false;
    }
  });

  window.ODParam = { load };
})();
