/* ozkandemir.net V3.6 — Panel: online lisans yönetimi */
(function () {
  'use strict';
  const { $, h, icon } = window.OD;
  const A = () => window.ODApp;

  const ls = { programId: 0, products: [], listTimer: null, lastCreated: null };

  const STATE = {
    active: ['Aktif', 'ok'],
    expiring: ['Süresi yaklaşıyor', 'warn'],
    waiting: ['Etkinleştirilmedi', 'info'],
    stale: ['Bağlanmıyor', 'warn'],
    suspended: ['Askıda · kilitli', 'bad'],
    revoked: ['İptal edildi', 'bad'],
    expired: ['Süresi doldu · kilitli', 'mute'],
    not_started: ['Henüz başlamadı', 'mute'],
  };
  function statePill(state, endsIn) {
    const [label, kind] = STATE[state] || [state, 'mute'];
    const text = state === 'expiring' ? `${Math.max(0, Math.ceil(endsIn / 86400))} gün kaldı` : label;
    return h('span', { class: 'pill pill-' + kind, text });
  }
  function ago(sec) {
    if (sec === null || sec === undefined) return '—';
    if (sec < 90) return 'şimdi';
    if (sec < 3600) return Math.round(sec / 60) + ' dk önce';
    if (sec < 86400) return Math.round(sec / 3600) + ' sa önce';
    return Math.round(sec / 86400) + ' gün önce';
  }
  function waNumber(phone) {
    let d = String(phone || '').replace(/\D/g, '');
    if (d.startsWith('0')) d = d.slice(1);
    if (d.length === 10 && d.startsWith('5')) d = '90' + d;
    return d.length >= 11 ? d : '';
  }
  function shareButtons(text, subject, email, phone) {
    const copy = h('button', { type: 'button', class: 'btn btn-sm' }, 'Kopyala');
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); A().toast('Mesaj kopyalandı.'); } catch { A().toast('Kopyalanamadı.', true); }
    });
    const wa = waNumber(phone);
    return h('div', { class: 'btn-row' },
      copy,
      h('a', { class: 'btn btn-sm btn-green', target: '_blank', rel: 'noopener noreferrer', href: `https://wa.me/${wa}?text=${encodeURIComponent(text)}` }, 'WhatsApp ile gönder'),
      h('a', { class: 'btn btn-sm', href: `mailto:${encodeURIComponent(email || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}` }, 'E-posta'),
      h('a', { class: 'btn btn-sm', target: '_blank', rel: 'noopener noreferrer', href: `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email || '')}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}` }, 'Gmail'),
    );
  }
  const SIGN = '\n\nÖzkan Demir\nSerbest Muhasebeci Mali Müşavir\n0551 600 77 87';

  // ================= Liste =================
  async function loadList() {
    const qs = new URLSearchParams();
    if (ls.programId) qs.set('program', ls.programId);
    if ($('#licStatus').value) qs.set('status', $('#licStatus').value);
    if ($('#licSearch').value.trim()) qs.set('q', $('#licSearch').value.trim());
    let r;
    try { r = await A().call('/licenses?' + qs); } catch (e) { A().toast(e.message, true); return; }
    ls.products = r.products;
    const s = r.stats;
    const stat = (label, value, note, warn) => h('div', { class: 'stat' }, h('small', { text: label }), h('b', { class: warn ? 'warn-text' : null, text: String(value) }), h('span', { text: note }));
    $('#licStats').replaceChildren(
      stat('Aktif lisans', s.active, `${s.programs} programda`),
      stat('30 gün içinde dolacak', s.expiring, s.expiring ? 'Hatırlatma gönderin' : 'Yaklaşan bitiş yok', s.expiring > 0),
      stat('Etkin cihaz / sunucu', s.devices, s.stale ? `${s.stale} lisansta 8+ gündür bağlantı yok` : 'Hepsi düzenli doğruluyor'),
      stat('Son 24 saatte doğrulama', s.checks24h, s.rejected24h ? `${s.rejected24h} reddedilen deneme` : 'Reddedilen deneme yok'),
    );
    $('#licChips').replaceChildren(
      chip(`Tümü (${r.total})`, 0),
      ...r.products.map((p) => chip(`${p.name} (${r.counts[p.programId] || 0})`, p.programId)),
    );
    const body = $('#licRows');
    if (!r.licenses.length) {
      body.replaceChildren(h('tr', {}, h('td', { colspan: 8, class: 'empty', text: r.total ? 'Filtreye uyan lisans yok.' : 'Henüz lisans oluşturulmadı. “Yeni lisans oluştur” ile başlayın.' })));
      return;
    }
    body.replaceChildren(...r.licenses.map((l) => {
      const acts = h('div', { class: 'acts' });
      if (l.state === 'expiring' || l.state === 'expired') {
        acts.append(h('button', { type: 'button', class: 'btn btn-sm', onclick: () => remind(l) }, 'Hatırlat'));
      }
      acts.append(h('a', { class: 'btn btn-sm', href: '#lisans-' + l.id }, 'Detay'));
      return h('tr', {},
        h('td', {}, h('b', { text: l.customer }), l.email ? h('span', { class: 'sub', text: l.email }) : null),
        h('td', { text: l.program }),
        h('td', { class: 'mono nowrap', text: l.key }),
        h('td', {}, h('span', { text: 'Yıllık' }), h('span', { class: 'sub', text: l.ends })),
        h('td', { class: 'num', text: `${l.devices} / ${l.maxDevices}` }),
        h('td', { text: ago(l.lastSeenAgo) }),
        h('td', {}, statePill(l.state, l.endsIn)),
        h('td', {}, acts));
    }));
  }
  function chip(label, id) {
    return h('button', { type: 'button', class: 'chip' + (ls.programId === id ? ' on' : ''), onclick: () => { ls.programId = id; loadList(); } }, label);
  }
  function remind(l) {
    const expired = l.state === 'expired';
    const text = `Merhaba,\n\n${l.program} lisansınız ${expired ? l.ends + ' tarihinde sona erdi; program kilitlendi' : l.ends + ' tarihinde sona eriyor'}. ${expired ? 'Yeniden kullanmak' : 'Kesintisiz kullanım'} için lisansınızı yenileyelim mi?\n\nLisans: ${l.key}${SIGN}`;
    A().openModal('Yenileme hatırlatması', h('div', { class: 'modal-body' },
      h('p', { class: 'muted', text: `${l.customer} · ${l.program}` }),
      h('textarea', { class: 'textarea', rows: 8, readonly: true, text: text }),
      shareButtons(text, `${l.program} lisans yenileme`, l.email, l.phone)));
  }
  $('#licStatus').addEventListener('change', loadList);
  $('#licSearch').addEventListener('input', () => { clearTimeout(ls.listTimer); ls.listTimer = setTimeout(loadList, 250); });

  // ================= Yeni lisans =================
  function addYearMinusDay(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y + 1, m - 1, d));
    if (dt.getUTCMonth() !== m - 1) dt.setUTCDate(0);
    dt.setUTCDate(dt.getUTCDate() - 1);
    return dt.toISOString().slice(0, 10);
  }
  let newLoaded = false;
  async function showNew() {
    $('#licMsg').hidden = true;
    if (newLoaded) return;
    let r;
    try { r = await A().call('/license-products'); } catch (e) { A().toast(e.message, true); return; }
    ls.products = r.products;
    $('#licStarts').value = r.defaults.starts;
    $('#licEnds').value = r.defaults.ends;
    $('#licProducts').replaceChildren(...r.products.map((p, i) => h('label', { class: 'prod' },
      h('input', { type: 'radio', name: 'licProduct', value: String(p.programId), checked: i === 0, onchange: renderTerms }),
      h('b', { text: p.name }), h('small', { text: p.prefix + '-…' }))));
    renderTerms();
    newLoaded = true;
  }
  const selectedProduct = () => {
    const el = document.querySelector('input[name=licProduct]:checked');
    return ls.products.find((p) => String(p.programId) === (el && el.value));
  };
  function renderTerms() {
    const p = selectedProduct();
    if (!p) return;
    $('#licLimits').replaceChildren(...p.limits.map((l) => h('label', { class: 'field' }, l.label,
      h('input', { class: 'input', type: 'number', min: 0, max: 1000000, step: 1, value: String(l.def), dataset: { limit: l.key } }))));
    $('#licModules').replaceChildren(...(p.modules.length ? p.modules.map((m) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: !!m.def, dataset: { module: m.key } }), m.label)) : [h('span', { class: 'muted small', text: 'Bu programın ek modülü yok.' })]));
    const dl = $('#licWithDl');
    dl.disabled = !p.latest;
    dl.checked = !!p.latest;
    $('#licDlText').textContent = p.latest
      ? `Mesaja kurulum dosyası indirme linkini de ekle (${p.name} ${p.latest.version} · 7 gün, 3 indirme)`
      : `${p.name} için henüz yüklü sürüm yok; indirme linki eklenemez.`;
  }
  $('#licStarts').addEventListener('change', () => { if ($('#licStarts').value) $('#licEnds').value = addYearMinusDay($('#licStarts').value); });

  $('#licForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const p = selectedProduct();
    A().msg($('#licMsg'), '');
    if (!p) return A().msg($('#licMsg'), 'Program seçin.');
    const limits = {};
    document.querySelectorAll('#licLimits [data-limit]').forEach((i) => { limits[i.dataset.limit] = Number(i.value); });
    const modules = [...document.querySelectorAll('#licModules [data-module]')].filter((i) => i.checked).map((i) => i.dataset.module);
    $('#licBtn').disabled = true;
    try {
      const r = await A().call('/licenses', { method: 'POST', body: {
        programId: p.programId, customer: $('#licCustomer').value, email: $('#licEmail').value, phone: $('#licPhone').value,
        starts: $('#licStarts').value, ends: $('#licEnds').value, maxDevices: Number($('#licDevices').value),
        limits, modules, note: $('#licNote').value, withDownload: $('#licWithDl').checked && !$('#licWithDl').disabled,
      } });
      showResult(r, $('#licEmail').value, $('#licPhone').value);
      $('#licCustomer').value = ''; $('#licEmail').value = ''; $('#licPhone').value = ''; $('#licNote').value = '';
      A().toast('Lisans oluşturuldu.');
    } catch (err) {
      A().msg($('#licMsg'), err.message);
    } finally {
      $('#licBtn').disabled = false;
    }
  });

  function licenseMessage(r) {
    let t = `Merhaba,\n\n${r.program} lisans anahtarınız:\n${r.key}\n\nGeçerlilik: ${r.starts} – ${r.ends}\nKapsam: ${r.maxDevices} sunucu · ${r.limitText}`;
    if (r.download) t += `\n\nKurulum dosyası (${r.download.version}): ${r.download.url}\nBu bağlantı size özeldir; ${r.download.expires} tarihine kadar 3 kez kullanılabilir.`;
    t += '\n\nEtkinleştirme: Programın Lisans ekranında anahtarı girip “İnternet ile etkinleştir”e tıklayın.' + SIGN;
    return t;
  }
  function showResult(r, email, phone) {
    const box = $('#licResult');
    const text = licenseMessage(r);
    box.replaceChildren(
      h('div', { class: 'ok-head' }, h('span', {}, icon('check')), h('b', { text: 'Lisans hazır' })),
      h('div', { class: 'bigkey', text: r.key }),
      h('dl', { class: 'dl2' },
        h('dt', { text: 'Müşteri' }), h('dd', { text: r.customer }),
        h('dt', { text: 'Program' }), h('dd', { text: r.program + (r.download ? ` · son sürüm ${r.download.version}` : '') }),
        h('dt', { text: 'Geçerlilik' }), h('dd', { text: `${r.starts} – ${r.ends}` }),
        h('dt', { text: 'Sınırlar' }), h('dd', { text: `${r.maxDevices} sunucu · ${r.limitText}` })),
      r.download ? h('small', { class: 'muted', text: 'Mesaj, kurulum dosyasının indirme linkini de içerir.' }) : null,
      shareButtons(text, `${r.program} lisans anahtarınız`, email, phone),
      h('a', { class: 'btn btn-sm', href: '#lisans-' + r.id }, 'Lisans detayına git →'));
    box.hidden = false;
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ================= Detay =================
  async function showDetail(id) {
    const root = $('#licDetailView');
    root.replaceChildren(h('p', { class: 'muted', text: 'Yükleniyor…' }));
    let d;
    try { d = await A().call('/licenses/' + id); } catch (e) { root.replaceChildren(h('p', { class: 'alert alert-err', text: e.message }), h('a', { class: 'back', href: '#lisanslar' }, '← Lisanslar')); return; }
    const reload = () => showDetail(id);
    const locked = d.status === 'revoked';

    const actions = h('div', { class: 'btn-row' });
    if (!locked) {
      actions.append(h('button', { type: 'button', class: 'btn btn-gold', onclick: () => extendModal(d, reload) }, 'Süre uzat'));
      actions.append(h('button', { type: 'button', class: 'btn', onclick: () => editModal(d, reload) }, 'Koşulları düzenle'));
      actions.append(h('button', { type: 'button', class: 'btn', onclick: () => offlineModal(d, reload) }, 'Çevrimdışı etkinleştir'));
      if (d.status === 'suspended') {
        const b = h('button', { type: 'button', class: 'btn btn-green' }, 'Yeniden aç');
        A().armed(b, 'Emin misiniz? Aç', async () => { await post(`/licenses/${d.id}/resume`, 'Lisans yeniden açıldı.'); reload(); });
        actions.append(b);
      } else {
        const b = h('button', { type: 'button', class: 'btn btn-warn' }, 'Askıya al');
        A().armed(b, 'Emin misiniz? Askıya al', async () => { await post(`/licenses/${d.id}/suspend`, 'Lisans askıya alındı.'); reload(); });
        actions.append(b);
      }
      const rv = h('button', { type: 'button', class: 'btn btn-danger' }, 'İptal et');
      A().armed(rv, 'Kalıcı iptal — emin misiniz?', async () => { await post(`/licenses/${d.id}/revoke`, 'Lisans iptal edildi.'); reload(); });
      actions.append(rv);
    }

    const resend = h('button', { type: 'button', class: 'btn btn-sm' }, 'Müşteriye yeniden gönder');
    resend.addEventListener('click', () => {
      const limitText = d.config.limits.map((l) => `${d.limits[l.key]} ${l.label.replace(' sınırı', '').toLocaleLowerCase('tr')}`).join(' · ');
      const text = licenseMessage({ program: d.program, key: d.key, starts: d.starts, ends: d.ends, maxDevices: d.maxDevices, limitText });
      A().openModal('Lisansı yeniden gönder', h('div', { class: 'modal-body' }, h('textarea', { class: 'textarea', rows: 10, readonly: true, text }), shareButtons(text, `${d.program} lisans anahtarınız`, d.email, d.phone)));
    });
    const copyKey = h('button', { type: 'button', class: 'btn btn-sm' }, 'Kopyala');
    copyKey.addEventListener('click', async () => { try { await navigator.clipboard.writeText(d.key); A().toast('Anahtar kopyalandı.'); } catch { A().toast('Kopyalanamadı.', true); } });

    const liveDevices = d.devices.filter((x) => !x.removed);
    const usageMax = {};
    for (const dv of liveDevices) for (const [k, v] of Object.entries(dv.usage || {})) usageMax[k] = Math.max(usageMax[k] || 0, v);
    const fact = (label, value, note) => h('div', { class: 'fact' }, h('small', { text: label }), h('b', { text: value }), note ? h('span', { text: note }) : null);
    const days = Math.ceil(d.endsIn / 86400);
    const facts = [
      fact('Geçerlilik', `${d.starts} – ${d.ends}`, d.endsIn > 0 ? `${days} gün kaldı` : 'Süresi doldu'),
      fact('Süre bitince', 'Program kilitlenir', '30 gün kala hatırlatma gönderin'),
      ...d.config.limits.map((l) => fact(l.label.replace(' sınırı', ''), usageMax[l.key] !== undefined ? `${usageMax[l.key]} / ${d.limits[l.key]}` : `Sınır: ${d.limits[l.key]}`, usageMax[l.key] !== undefined ? 'Programın bildirdiği kullanım' : 'Kullanım henüz bildirilmedi')),
      fact('Sunucu / cihaz', `${liveDevices.length} / ${d.maxDevices}`),
      fact('Modüller', d.modules.length ? d.config.modules.filter((m) => d.modules.includes(m.key)).map((m) => m.label).join(' · ') : '—'),
      fact('Çevrimdışı tolerans', `${d.lic.graceDays} gün`, `Doğrulama ${d.lic.checkEveryDays} günde bir`),
      fact('İletişim', [d.email, d.phone].filter(Boolean).join(' · ') || '—'),
    ];
    if (d.note) facts.push(fact('İç not', d.note));

    const devRows = d.devices.length ? d.devices.map((dv) => {
      const rm = h('button', { type: 'button', class: 'btn btn-sm btn-danger' }, 'Cihazı kaldır');
      A().armed(rm, 'Emin misiniz?', async () => { await post(`/licenses/${d.id}/devices/${dv.id}/remove`, 'Cihaz kaldırıldı.'); reload(); });
      const current = d.latestVersion && dv.version && dv.version.replace(/^v/i, '') === d.latestVersion.replace(/^v/i, '');
      return h('tr', { class: dv.removed ? 'removed' : null },
        h('td', {}, h('b', { text: dv.name }), h('span', { class: 'sub', text: dv.os || '' })),
        h('td', { class: 'mono', text: dv.fingerprint }),
        h('td', {}, h('b', { text: dv.version ? 'v' + dv.version.replace(/^v/i, '') : '—' }),
          d.latestVersion && dv.version ? h('span', { class: 'sub', text: current ? 'Güncel' : `Son sürüm: ${d.latestVersion}` }) : null),
        h('td', { text: dv.activated }),
        h('td', {}, h('span', { text: dv.removed ? '—' : ago(dv.lastSeenAgo) }), h('span', { class: 'sub', text: dv.location || '' })),
        h('td', { class: 'r' }, dv.removed ? h('span', { class: 'pill pill-mute', text: 'Kaldırıldı ' + dv.removed.slice(0, 10) }) : locked ? null : rm));
    }) : [h('tr', {}, h('td', { colspan: 6, class: 'empty', text: 'Lisans henüz hiçbir cihazda etkinleştirilmedi.' }))];

    const PILL = { 'Oluşturuldu': 'info', 'Etkinleşti': 'ok', 'Doğrulama': 'ok', 'Süre uzatıldı': 'info', 'Düzenlendi': 'info', 'Yeniden açıldı': 'ok', 'Uyarı': 'warn', 'Askıya alındı': 'warn', 'Cihaz kaldırıldı': 'warn', 'Reddedildi': 'bad', 'İptal edildi': 'bad' };

    root.replaceChildren(
      h('header', { class: 'page-head' },
        h('div', {},
          h('a', { class: 'back', href: '#lisanslar' }, '← Lisanslar'),
          h('div', { class: 'title-row' }, h('h1', { text: d.customer }), statePill(d.state, d.endsIn)),
          h('p', { text: `${d.program} · Yıllık abonelik · oluşturma ${d.created}` })),
        actions),
      h('section', { class: 'card' },
        h('div', { class: 'keyline' }, h('span', { class: 'bigkey', text: d.key }), copyKey, resend),
        h('div', { class: 'facts' }, facts)),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', { text: 'Etkinleştirilmiş cihazlar' }), h('small', { class: 'muted', text: `${liveDevices.length} / ${d.maxDevices} cihaz kullanımda` })),
        h('div', { class: 'table-wrap' }, h('table', { class: 'tbl wide' },
          h('thead', {}, h('tr', {}, ['Cihaz', 'Parmak izi', 'Kurulu sürüm', 'Etkinleştirme', 'Son doğrulama', ''].map((t, i) => h('th', { class: i === 5 ? 'r' : null, text: t })))),
          h('tbody', {}, devRows))),
        h('div', { class: 'alert alert-info' }, icon('info'), h('span', { text: 'Müşteri sunucusunu değiştirirse “Cihazı kaldır” deyin; anahtar yeni sunucuda yeniden etkinleştirilebilir. Kaldırılan cihaz en geç bir sonraki doğrulamada (7 gün) kilitlenir. Askıya alma ve iptal de aynı şekilde yansır.' }))),
      h('section', { class: 'card' },
        h('h2', { text: 'Lisans geçmişi' }),
        h('div', {}, d.events.length ? d.events.map((e) => h('div', { class: 'hist' },
          h('time', { text: e.time }), h('span', { class: 'pill pill-' + (PILL[e.type] || 'mute'), text: e.type }), h('span', { text: e.detail + (e.location ? ` · ${e.location}` : '') }))) : h('p', { class: 'muted', text: 'Kayıt yok.' }))),
    );
  }

  async function post(path, okText, body = {}) {
    try {
      const r = await A().call(path, { method: 'POST', body });
      if (okText) A().toast(okText);
      return r;
    } catch (e) {
      A().toast(e.message, true);
      throw e;
    }
  }

  function modalForm(title, fields, submitText, onSubmit) {
    const err = h('div', { class: 'alert', role: 'alert', hidden: true });
    const btn = h('button', { type: 'submit', class: 'btn btn-navy' }, submitText);
    const form = h('form', { class: 'modal-body', novalidate: true }, fields, err, btn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      A().msg(err, '');
      btn.disabled = true;
      try { await onSubmit(form); } catch (ex) { A().msg(err, ex.message); } finally { btn.disabled = false; }
    });
    A().openModal(title, form);
  }

  function extendModal(d, done) {
    modalForm('Süre uzat', [
      h('p', { class: 'muted', text: `Mevcut bitiş: ${d.ends}. Yeni süre programa bir sonraki doğrulamada (en geç 7 gün) ya da müşteri “Şimdi doğrula” dediğinde yansır.` }),
      h('label', { class: 'field' }, 'Yeni bitiş tarihi', h('input', { class: 'input', type: 'date', id: 'extEnds', value: d.nextYearIso })),
    ], 'Süreyi uzat', async () => {
      await A().call(`/licenses/${d.id}/extend`, { method: 'POST', body: { ends: $('#extEnds').value } });
      A().closeModal(); A().toast('Süre uzatıldı.'); done();
    });
  }

  function editModal(d, done) {
    modalForm('Koşulları düzenle', [
      h('label', { class: 'field' }, 'Firma unvanı', h('input', { class: 'input', id: 'edCustomer', value: d.customer, maxlength: 120 })),
      h('div', { class: 'grid2f' },
        h('label', { class: 'field' }, 'Yetkili e-posta', h('input', { class: 'input', id: 'edEmail', value: d.email || '', type: 'email' })),
        h('label', { class: 'field' }, 'Yetkili telefon', h('input', { class: 'input', id: 'edPhone', value: d.phone || '' }))),
      h('div', { class: 'grid2f' },
        h('label', { class: 'field' }, 'Sunucu / cihaz', h('input', { class: 'input', id: 'edDevices', type: 'number', min: 1, max: 10, value: String(d.maxDevices) })),
        ...d.config.limits.map((l) => h('label', { class: 'field' }, l.label, h('input', { class: 'input', type: 'number', min: 0, value: String(d.limits[l.key]), dataset: { edLimit: l.key } })))),
      d.config.modules.length ? h('div', { class: 'checks' }, d.config.modules.map((m) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: d.modules.includes(m.key), dataset: { edModule: m.key } }), m.label))) : null,
      h('label', { class: 'field' }, 'İç not', h('textarea', { class: 'textarea', id: 'edNote', rows: 2, maxlength: 500, text: d.note || '' })),
    ], 'Kaydet', async (form) => {
      const limits = {};
      form.querySelectorAll('[data-ed-limit]').forEach((i) => { limits[i.dataset.edLimit] = Number(i.value); });
      const modules = [...form.querySelectorAll('[data-ed-module]')].filter((i) => i.checked).map((i) => i.dataset.edModule);
      await A().call(`/licenses/${d.id}/update`, { method: 'POST', body: {
        customer: $('#edCustomer').value, email: $('#edEmail').value, phone: $('#edPhone').value,
        maxDevices: Number($('#edDevices').value), limits, modules, note: $('#edNote').value,
      } });
      A().closeModal(); A().toast('Koşullar güncellendi.'); done();
    });
  }

  function offlineModal(d, done) {
    modalForm('Çevrimdışı etkinleştirme', [
      h('p', { class: 'muted', text: 'İnternete çıkamayan sunucular için: müşterinin programındaki “Çevrimdışı istek kodu”nu aşağıya yapıştırın. Verilen lisans kodu bitiş tarihine kadar internetsiz çalışır; askıya alma, iptal ve cihaz kaldırma bu cihaza yansımaz (yalnızca internete bağlandığında yansır).' }),
      h('label', { class: 'field' }, 'Müşterinin istek kodu', h('textarea', { class: 'textarea mono', id: 'offReq', rows: 4, placeholder: 'ODR1.…' })),
    ], 'Lisans kodu üret', async () => {
      const r = await A().call(`/licenses/${d.id}/offline`, { method: 'POST', body: { request: $('#offReq').value } });
      const copy = h('button', { type: 'button', class: 'btn btn-sm' }, 'Kopyala');
      copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(r.token); A().toast('Lisans kodu kopyalandı.'); } catch { A().toast('Kopyalanamadı.', true); } });
      A().openModal('Lisans kodu hazır', h('div', { class: 'modal-body' },
        h('p', { class: 'muted', text: `${r.device} cihazı için. Bu kodu müşteriye iletin; programda “Lisans kodunu kur” ile girilir.` }),
        h('textarea', { class: 'textarea mono', rows: 8, readonly: true, text: r.token }),
        h('div', { class: 'btn-row' }, copy)));
      done();
    });
  }

  // ================= Yönlendirme =================
  function route(hash) {
    $('#licListView').hidden = hash !== 'lisanslar';
    $('#licNewView').hidden = hash !== 'lisans-yeni';
    $('#licDetailView').hidden = !/^lisans-\d+$/.test(hash);
    if (hash === 'lisanslar') loadList();
    else if (hash === 'lisans-yeni') showNew();
    else if (/^lisans-\d+$/.test(hash)) showDetail(hash.slice(7));
    else location.hash = '#lisanslar';
  }

  window.ODLic = { route };
})();
