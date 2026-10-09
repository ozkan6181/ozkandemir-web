/* ozkandemir.net V3.6 — Yönetim paneli */
(function () {
  'use strict';
  const { $, $$, api, h, icon, fmtSize } = window.OD;

  const state = { overview: null, idleTimeout: 1800, lastServer: Date.now(), expiresAt: 0, clockSkew: 0, upload: null, view: 'programlar' };
  const EXT = ['zip', 'exe', 'msi', 'rar', '7z'];
  const MAX = 2 * 1024 ** 3;

  // ---------- Genel ----------
  let toastTimer;
  function toast(text, err) {
    const t = $('#toast');
    t.textContent = text;
    t.className = 'toast' + (err ? ' err' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, err ? 6000 : 3500);
  }
  function msg(el, text, kind = 'err') {
    if (!text) { el.hidden = true; el.textContent = ''; return; }
    el.className = 'alert alert-' + kind;
    el.textContent = text;
    el.hidden = false;
  }
  function goLogin() { location.replace('/panel/?cikis=1'); }

  async function call(path, opts) {
    try {
      const r = await api(path, opts);
      state.lastServer = Date.now();
      return r;
    } catch (e) {
      if (e.status === 401 && e.data && e.data.restart) goLogin();
      if (e.status === 429) setTimeout(goLogin, 2500);
      throw e;
    }
  }

  function left(sec) {
    if (sec <= 0) return 'süresi doldu';
    const d = Math.floor(sec / 86400), hh = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (d) return `${d} gün${hh ? ' ' + hh + ' sa' : ''} kaldı`;
    if (hh) return `${hh} sa${m ? ' ' + m + ' dk' : ''} kaldı`;
    return `${Math.max(1, m)} dk kaldı`;
  }
  function browserName(ua) {
    ua = String(ua || '');
    const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Tarayıcı';
    const o = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iPhone / iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'cihaz';
    return `${b} · ${o}`;
  }
  // İki adımlı onay düğmesi (tarayıcı uyarı penceresi açmadan)
  function armed(btn, label, fn) {
    btn.addEventListener('click', async () => {
      if (!btn.classList.contains('armed')) {
        const orig = btn.textContent;
        btn.classList.add('armed');
        btn.textContent = label;
        btn._t = setTimeout(() => { btn.classList.remove('armed'); btn.textContent = orig; }, 4000);
        btn._orig = orig;
        return;
      }
      clearTimeout(btn._t);
      btn.classList.remove('armed');
      btn.textContent = btn._orig;
      btn.disabled = true;
      try { await fn(); } finally { btn.disabled = false; }
    });
  }

  // ---------- Modal ----------
  let lastFocus = null;
  function openModal(title, body, wide) {
    lastFocus = document.activeElement;
    $('#modalTitle').textContent = title;
    const mb = $('#modalBody');
    mb.replaceChildren(body);
    $('#modalBox').className = 'modal-box' + (wide ? ' wide' : '');
    $('#modal').hidden = false;
    const f = mb.querySelector('input,select,textarea,button');
    (f || $('#modalClose')).focus();
  }
  function closeModal() {
    $('#modal').hidden = true;
    $('#modalBody').replaceChildren();
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  $('#modalClose').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeModal(); });
  $('#modal').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  // ---------- Oturum süresi ----------
  function idleTick() {
    const idleLeft = state.idleTimeout - (Date.now() - state.lastServer) / 1000;
    const absLeft = state.expiresAt ? state.expiresAt - (Date.now() / 1000 + state.clockSkew) : Infinity;
    const leftSec = Math.min(idleLeft, absLeft);
    $('#sessIdle').textContent = `Otomatik çıkış: ${Math.max(0, Math.ceil(leftSec / 60))} dk`;
    if (leftSec <= 0) goLogin();
  }
  let lastPing = 0;
  ['click', 'keydown', 'scroll', 'pointermove'].forEach((ev) => document.addEventListener(ev, () => {
    // Kullanıcı aktifse oturumu canlı tut (en fazla 5 dakikada bir)
    if (Date.now() - state.lastServer > 5 * 60 * 1000 && Date.now() - lastPing > 60 * 1000 && !state.upload) {
      lastPing = Date.now();
      call('/me').catch(() => {});
    }
  }, { passive: true }));

  // ---------- Görünümler ----------
  function route() {
    const hash = (location.hash || '#programlar').slice(1);
    const view = hash === 'guvenlik' ? 'guvenlik' : hash.startsWith('lisans') ? 'lisans' : 'programlar';
    $('#view-programlar').hidden = view !== 'programlar';
    $('#view-guvenlik').hidden = view !== 'guvenlik';
    $('#view-lisans').hidden = view !== 'lisans';
    const navKey = view === 'lisans' ? 'lisanslar' : hash;
    $$('.side-nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === navKey || (hash === '' && a.dataset.nav === 'programlar')));
    if (view === 'lisans') {
      state.view = 'lisans';
      window.scrollTo({ top: 0 });
      if (window.ODLic) window.ODLic.route(hash);
      return;
    }
    if (view !== state.view) {
      state.view = view;
      if (view === 'guvenlik') loadSecurity();
      else loadOverview();
    }
    if (view === 'programlar' && (hash === 'yukle' || hash === 'linkler')) {
      const el = document.getElementById(hash);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      window.scrollTo({ top: 0 });
    }
  }
  window.addEventListener('hashchange', route);

  // ---------- Programlar ----------
  async function loadOverview() {
    try {
      const o = await call('/overview');
      state.overview = o;
      renderStats(o.stats);
      renderPrograms();
      renderProgramSelect();
      renderVersionSelect();
    } catch (e) {
      toast(e.message, true);
    }
    loadLinks();
  }

  function stat(label, value, note) {
    return h('div', { class: 'stat' }, h('small', { text: label }), h('b', { text: value }), h('span', { text: note }));
  }
  function renderStats(s) {
    $('#stats').replaceChildren(
      stat('Program', String(s.programs), `Toplam ${s.versions} sürüm arşivde`),
      stat('Depolama', s.storageText, `10 GB ücretsiz kotanın %${String(s.quotaPct).replace('.', ',')}’i`),
      stat('Aktif indirme linki', String(s.activeLinks), s.activeLinks ? `En yakını ${left(s.nextExpiryIn).replace(' kaldı', '')} sonra kapanır` : 'Şu an açık bağlantı yok'),
      stat('Bu ay indirme', String(s.downloadsThisMonth), 'Müşteri bağlantılarıyla'),
    );
  }

  function renderPrograms() {
    const term = $('#progSearch').value.trim().toLocaleLowerCase('tr');
    const rows = (state.overview ? state.overview.programs : []).filter((p) => !term || p.name.toLocaleLowerCase('tr').includes(term));
    const body = $('#progRows');
    if (!rows.length) {
      body.replaceChildren(h('tr', {}, h('td', { colspan: 6, class: 'empty', text: term ? 'Aramaya uyan program yok.' : 'Henüz program yok.' })));
      return;
    }
    body.replaceChildren(...rows.map((p) => {
      const v = p.latest;
      const badge = !v ? h('span', { class: 'pill pill-mute', text: 'Henüz yüklenmedi' })
        : p.access === 'link' ? h('span', { class: 'pill pill-ok', text: `Müşteri linki (${p.activeLinks})` })
        : h('span', { class: 'pill pill-mute', text: 'Gizli' });
      return h('tr', {},
        h('td', {}, h('b', { text: p.name }), v ? h('span', { class: 'sub', text: v.filename }) : null),
        h('td', { class: 'num', text: v ? v.version : '—' }),
        h('td', { text: v ? v.sizeText : '—' }),
        h('td', { text: v ? v.date : '—' }),
        h('td', {}, badge),
        h('td', {}, h('div', { class: 'acts' },
          h('button', { type: 'button', class: 'btn btn-sm', onclick: () => openVersions(p), disabled: !p.versionCount }, `Sürümler${p.versionCount ? ' (' + p.versionCount + ')' : ''}`),
          v ? h('button', { type: 'button', class: 'btn btn-sm btn-navy', onclick: () => prepareLink(v.id, `${p.name} — ${v.version}`) }, 'Link oluştur')
            : h('button', { type: 'button', class: 'btn btn-sm btn-navy', onclick: () => prepareUpload(p.id) }, 'Yükle'),
        )),
      );
    }));
  }
  $('#progSearch').addEventListener('input', renderPrograms);

  async function openVersions(p) {
    const wrap = h('div', { class: 'table-wrap' });
    openModal(`${p.name} · Sürümler`, h('div', { class: 'modal-body' }, wrap), true);
    try {
      const r = await call(`/programs/${p.id}/versions`);
      if (!r.versions.length) { wrap.replaceChildren(h('p', { class: 'empty', text: 'Bu programa ait sürüm yok.' })); return; }
      wrap.replaceChildren(h('table', { class: 'tbl mid' },
        h('thead', {}, h('tr', {}, ['Sürüm', 'Tarih', 'Boyut', 'Notlar / SHA-256', ''].map((t, i) => h('th', { class: i === 4 ? 'r' : null, text: t })))),
        h('tbody', {}, r.versions.map((v) => {
          const del = h('button', { type: 'button', class: 'btn btn-sm btn-danger' }, 'Sil');
          armed(del, 'Emin misiniz? Sil', async () => {
            try {
              await call(`/versions/${v.id}`, { method: 'DELETE' });
              toast(`${p.name} ${v.version} silindi.`);
              closeModal();
              loadOverview();
            } catch (e) { toast(e.message, true); }
          });
          return h('tr', {},
            h('td', { class: 'num' }, v.version, v.active ? h('span', { class: 'sub', text: `${v.active} aktif link` }) : null),
            h('td', { text: v.date }),
            h('td', { text: v.sizeText }),
            h('td', {}, v.notes ? h('span', { text: v.notes }) : h('span', { class: 'muted', text: 'Not yok' }), h('span', { class: 'sub mono', text: v.sha256 || '' })),
            h('td', {}, h('div', { class: 'acts' },
              h('button', { type: 'button', class: 'btn btn-sm btn-navy', onclick: () => { closeModal(); prepareLink(v.id, `${p.name} — ${v.version}`); } }, 'Link'),
              del)),
          );
        })),
      ));
    } catch (e) { wrap.replaceChildren(h('p', { class: 'empty', text: e.message })); }
  }

  // ---------- Yükleme ----------
  let chosen = null;
  function renderProgramSelect() {
    const sel = $('#upProgram');
    const keep = sel.value;
    const progs = state.overview ? [...state.overview.programs].sort((a, b) => a.name.localeCompare(b.name, 'tr')) : [];
    sel.replaceChildren(h('option', { value: '', text: 'Program seçin' }), ...progs.map((p) => h('option', { value: String(p.id), text: p.name })), h('option', { value: '__new', text: '+ Yeni program ekle…' }));
    if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
    $('#newProgWrap').hidden = sel.value !== '__new';
  }
  $('#upProgram').addEventListener('change', () => {
    $('#newProgWrap').hidden = $('#upProgram').value !== '__new';
    if ($('#upProgram').value === '__new') $('#upNewProgram').focus();
  });
  function prepareUpload(pid) {
    $('#upProgram').value = String(pid);
    $('#newProgWrap').hidden = true;
    location.hash = '#yukle';
    document.getElementById('yukle').scrollIntoView({ behavior: 'smooth' });
    $('#upVersion').focus();
  }

  function chooseFile(f) {
    msg($('#upMsg'), '');
    if (!f) return;
    const ext = (f.name.match(/\.([A-Za-z0-9]+)$/) || [])[1];
    if (!ext || !EXT.includes(ext.toLowerCase())) { chosen = null; resetDrop(); return msg($('#upMsg'), 'İzin verilen dosya türleri: .zip, .exe, .msi, .rar, .7z'); }
    if (f.size > MAX) { chosen = null; resetDrop(); return msg($('#upMsg'), 'Dosya 2 GB sınırını aşıyor.'); }
    if (!f.size) { chosen = null; resetDrop(); return msg($('#upMsg'), 'Dosya boş.'); }
    chosen = f;
    $('#drop').classList.add('has');
    $('#dropTitle').textContent = f.name;
    $('#dropHelp').textContent = `${fmtSize(f.size)} · değiştirmek için tıklayın`;
    const m = f.name.match(/v?(\d+(?:\.\d+){1,3})/i);
    if (m && !$('#upVersion').value) $('#upVersion').value = 'v' + m[1];
  }
  function resetDrop() {
    $('#drop').classList.remove('has', 'over');
    $('#dropTitle').textContent = 'Dosyayı sürükleyin veya seçin';
    $('#dropHelp').textContent = '.zip, .exe, .msi, .rar, .7z · en fazla 2 GB';
    $('#file').value = '';
  }
  $('#file').addEventListener('change', () => chooseFile($('#file').files[0]));
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
  drop.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) chooseFile(e.dataTransfer.files[0]); });

  function setProgress(done, total, status) {
    const pct = total ? Math.floor((done / total) * 100) : 0;
    $('#upPct').textContent = pct + '%';
    $('#upBar').style.width = pct + '%';
    if (status) $('#upStatus').textContent = status;
  }

  async function putPart(versionId, n, buf, signal) {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (signal.aborted) throw new Error('İptal edildi');
      try {
        return await call(`/uploads/${versionId}/parts/${n}`, { method: 'PUT', body: buf });
      } catch (e) {
        lastErr = e;
        if (e.status && e.status < 500 && e.status !== 0) throw e;
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    throw lastErr;
  }

  $('#uploadForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.upload) return;
    msg($('#upMsg'), '');
    if (!chosen) return msg($('#upMsg'), 'Önce yüklenecek dosyayı seçin.');
    let programId = $('#upProgram').value;
    const version = $('#upVersion').value.trim();
    if (!programId) return msg($('#upMsg'), 'Program seçin.');
    if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/.test(version)) return msg($('#upMsg'), 'Sürüm numarası geçersiz (ör. v2.4.0).');

    const ctrl = { aborted: false, versionId: null };
    state.upload = ctrl;
    $('#upBtn').disabled = true;
    $('#upCancel').hidden = false;
    $('#upProgress').hidden = false;
    $('#upName').textContent = chosen.name;
    setProgress(0, chosen.size, 'Hazırlanıyor…');
    try {
      if (programId === '__new') {
        const p = await call('/programs', { method: 'POST', body: { name: $('#upNewProgram').value } });
        programId = String(p.id);
        await loadOverview();
        $('#upProgram').value = programId;
        $('#newProgWrap').hidden = true;
        $('#upNewProgram').value = '';
      }
      const start = await call('/uploads', { method: 'POST', body: { programId: Number(programId), version, filename: chosen.name, size: chosen.size, notes: $('#upNotes').value } });
      ctrl.versionId = start.versionId;
      const sha = new window.ODSha256();
      const parts = [];
      const t0 = Date.now();
      for (let n = 1; n <= start.parts; n++) {
        if (ctrl.aborted) throw new Error('İptal edildi');
        const from = (n - 1) * start.partSize;
        const buf = new Uint8Array(await chosen.slice(from, Math.min(from + start.partSize, chosen.size)).arrayBuffer());
        sha.update(buf);
        parts.push(await putPart(start.versionId, n, buf, ctrl));
        const done = Math.min(chosen.size, n * start.partSize);
        const speed = done / Math.max(1, (Date.now() - t0) / 1000);
        const rest = speed ? Math.round((chosen.size - done) / speed) : 0;
        setProgress(done, chosen.size, `${fmtSize(done)} / ${fmtSize(chosen.size)} · ${fmtSize(speed)}/sn${rest > 3 ? ' · yaklaşık ' + (rest > 90 ? Math.ceil(rest / 60) + ' dk' : rest + ' sn') + ' kaldı' : ''}`);
      }
      setProgress(chosen.size, chosen.size, 'Doğrulanıyor…');
      const digest = sha.hex();
      await call(`/uploads/${start.versionId}/complete`, { method: 'POST', body: { parts, sha256: digest } });
      ctrl.versionId = null;
      msg($('#upMsg'), `Yükleme tamamlandı. SHA-256: ${digest}`, 'ok');
      toast('Yükleme tamamlandı.');
      chosen = null;
      resetDrop();
      $('#upVersion').value = '';
      $('#upNotes').value = '';
      $('#upProgress').hidden = true;
      await loadOverview();
    } catch (err) {
      if (ctrl.versionId) { try { await api(`/uploads/${ctrl.versionId}/abort`, { method: 'POST', body: {} }); } catch {} }
      msg($('#upMsg'), ctrl.aborted ? 'Yükleme iptal edildi.' : err.message, ctrl.aborted ? 'info' : 'err');
      $('#upProgress').hidden = true;
    } finally {
      state.upload = null;
      $('#upBtn').disabled = false;
      $('#upCancel').hidden = true;
    }
  });
  $('#upCancel').addEventListener('click', () => { if (state.upload) state.upload.aborted = true; });
  window.addEventListener('beforeunload', (e) => { if (state.upload) { e.preventDefault(); e.returnValue = ''; } });

  // ---------- İndirme bağlantıları ----------
  function renderVersionSelect(extra) {
    const sel = $('#lnVersion');
    const keep = extra ? String(extra.id) : sel.value;
    const opts = (state.overview ? state.overview.programs : []).filter((p) => p.latest)
      .map((p) => ({ id: String(p.latest.id), label: `${p.name} — ${p.latest.version}` }));
    if (extra && !opts.some((o) => o.id === String(extra.id))) opts.unshift({ id: String(extra.id), label: extra.label });
    if (!opts.length) {
      sel.replaceChildren(h('option', { value: '', text: 'Önce bir program sürümü yükleyin' }));
      return;
    }
    sel.replaceChildren(...opts.map((o) => h('option', { value: o.id, text: o.label })));
    if (keep && opts.some((o) => o.id === keep)) sel.value = keep;
  }
  function prepareLink(versionId, label) {
    renderVersionSelect({ id: versionId, label });
    $('#lnOut').hidden = true;
    location.hash = '#linkler';
    document.getElementById('linkler').scrollIntoView({ behavior: 'smooth' });
    $('#lnCustomer').focus();
  }

  $('#linkForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    msg($('#lnMsg'), '');
    const versionId = Number($('#lnVersion').value);
    if (!versionId) return msg($('#lnMsg'), 'Önce bir program sürümü yükleyin.');
    $('#lnBtn').disabled = true;
    try {
      const r = await call('/links', { method: 'POST', body: { versionId, customer: $('#lnCustomer').value, hours: Number($('#lnHours').value), maxDownloads: Number($('#lnMax').value) } });
      $('#lnUrl').value = r.url;
      const text = `Merhaba,\n\n${r.program} ${r.version} kurulum dosyanızı aşağıdaki bağlantıdan indirebilirsiniz. Bağlantı size özeldir ve ${r.expires} tarihine kadar geçerlidir.\n\n${r.url}\n\nÖzkan Demir\nSerbest Muhasebeci Mali Müşavir\n0551 600 77 87`;
      $('#lnWa').href = 'https://wa.me/?text=' + encodeURIComponent(text);
      $('#lnMail').href = 'mailto:?subject=' + encodeURIComponent(`${r.program} ${r.version} - İndirme Bağlantısı`) + '&body=' + encodeURIComponent(text);
      $('#lnOut').hidden = false;
      $('#lnUrl').select();
      $('#lnCustomer').value = '';
      toast('Bağlantı oluşturuldu.');
      loadOverview();
    } catch (err) {
      msg($('#lnMsg'), err.message);
    } finally {
      $('#lnBtn').disabled = false;
    }
  });
  $('#lnCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#lnUrl').value); toast('Bağlantı kopyalandı.'); }
    catch { $('#lnUrl').select(); toast('Seçili bağlantıyı Ctrl+C ile kopyalayın.'); }
  });

  async function loadLinks() {
    const box = $('#linkList');
    try {
      const r = await call('/links');
      if (!r.links.length) { box.replaceChildren(h('p', { class: 'muted small', text: 'Henüz bağlantı oluşturulmadı.' })); return; }
      const labels = { expired: 'Süresi doldu', used: 'Hakkı bitti', revoked: 'İptal edildi' };
      box.replaceChildren(...r.links.slice(0, 15).map((l) => {
        const right = h('div', {});
        if (l.status === 'active') {
          right.append(h('small', { text: left(l.expiresIn) }));
          const b = h('button', { type: 'button', class: 'btn btn-sm btn-danger' }, 'İptal et');
          armed(b, 'Emin misiniz?', async () => {
            try { await call(`/links/${l.id}/revoke`, { method: 'POST', body: {} }); toast('Bağlantı iptal edildi.'); loadOverview(); }
            catch (e) { toast(e.message, true); }
          });
          right.append(b);
        } else {
          right.append(h('span', { class: 'pill pill-mute', text: labels[l.status] }));
        }
        return h('div', { class: 'link-item' },
          h('div', {}, h('b', { text: l.customer }), h('small', { text: `${l.program} ${l.version} · ${l.downloads} / ${l.max_downloads} indirme · ${l.created}` })),
          right);
      }));
    } catch (e) { box.replaceChildren(h('p', { class: 'muted small', text: e.message })); }
  }

  // ---------- Güvenlik ----------
  async function loadSecurity() {
    try {
      const s = await call('/security');
      const missing = s.layers.filter((l) => !l.ok).length;
      $('#secHead').replaceChildren(
        h('span', { class: 'sec-badge ' + (s.allOk ? 'ok' : 'warn') }, icon(s.allOk ? 'shieldok' : 'alert', 'ic-lg')),
        h('div', {}, h('b', { text: s.allOk ? 'Tüm koruma katmanları açık' : `${missing} koruma katmanı bekliyor` }), h('small', { text: `Son kontrol: ${s.checkedAt}` })),
      );
      $('#layers').replaceChildren(...s.layers.map((l) => h('div', { class: 'layer ' + (l.ok ? 'ok' : 'no') },
        icon(l.ok ? 'check' : 'alert'), h('div', {}, h('b', { text: l.title }), h('small', { text: l.detail })))));
      $('#sessList').replaceChildren(...s.sessions.map((x) => h('div', { class: 'sess' },
        h('div', {}, h('b', { text: browserName(x.ua) }), h('small', { text: `${x.location} · ${x.ip} · ${x.current ? 'şu an aktif (bu cihaz)' : x.lastSeenAgo < 90 ? 'şu an aktif' : Math.round(x.lastSeenAgo / 60) + ' dk önce'}` })),
        h('span', { class: 'pill ' + (x.current ? 'pill-ok' : 'pill-info'), text: x.current ? 'Bu cihaz' : 'Açık' }))));
      $('#revokeOthers').disabled = s.sessions.length < 2;
      $('#pwInfo').textContent = `En az 14 karakter · ${s.password.daysAgo === 0 ? 'bugün' : s.password.daysAgo + ' gün önce'} değişti`;
      $('#bcInfo').textContent = `${s.backup.total} koddan ${s.backup.left}’i kullanılmadı`;
      $('#trInfo').textContent = s.trustedDevices ? `${s.trustedDevices} cihaz 30 gün boyunca kod istemeden giriş yapabilir` : 'Güvenilir cihaz yok';
      $('#trBtn').disabled = !s.trustedDevices;
      $('#pkInfo').textContent = s.publicKey || '—';
      $('#pkBtn').onclick = async () => { try { await navigator.clipboard.writeText(s.publicKey); toast('Açık anahtar kopyalandı.'); } catch { toast('Kopyalanamadı.', true); } };
    } catch (e) { toast(e.message, true); }
    loadAudit();
  }

  const PILL = { 'Giriş': 'ok', 'Çıkış': 'ok', 'Yükleme': 'info', 'İndirme': 'info', 'Link': 'info', 'Program': 'info', 'Dışa aktarım': 'info', 'Güvenlik': 'info', 'Uyarı': 'warn', 'Silme': 'warn', 'Engellendi': 'bad', 'Başarısız giriş': 'bad', 'Başarısız doğrulama': 'bad' };
  async function loadAudit() {
    try {
      const r = await call('/audit?limit=200');
      $('#auditRows').replaceChildren(...r.entries.map((e) => h('tr', {},
        h('td', { class: 'mono', text: e.time }),
        h('td', {}, h('span', { class: 'pill pill-' + (PILL[e.type] || 'mute'), text: e.type })),
        h('td', { text: e.detail }),
        h('td', { class: 'mono', text: `${e.location || ''} · ${e.ip || ''}` }))));
    } catch (e) { toast(e.message, true); }
  }

  armed($('#revokeOthers'), 'Emin misiniz? Kapat', async () => {
    try { const r = await call('/sessions/revoke-others', { method: 'POST', body: {} }); toast(`${r.closed} oturum kapatıldı.`); loadSecurity(); }
    catch (e) { toast(e.message, true); }
  });
  armed($('#trBtn'), 'Emin misiniz? Sıfırla', async () => {
    try { await call('/trusted/clear', { method: 'POST', body: {} }); toast('Güvenilir cihazlar sıfırlandı.'); loadSecurity(); }
    catch (e) { toast(e.message, true); }
  });

  function codeField(id, label = 'Doğrulama uygulamasındaki 6 haneli kod') {
    return h('label', { class: 'field' }, label, h('input', { class: 'input mono', id, inputmode: 'numeric', maxlength: 6, autocomplete: 'one-time-code', placeholder: '000000' }));
  }
  function formModal(title, fields, submitText, onSubmit) {
    const err = h('div', { class: 'alert', role: 'alert', hidden: true });
    const btn = h('button', { type: 'submit', class: 'btn btn-navy' }, submitText);
    const form = h('form', { class: 'modal-body', novalidate: true }, fields, err, btn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg(err, '');
      btn.disabled = true;
      try { await onSubmit(form, err); } catch (ex) { msg(err, ex.message); } finally { btn.disabled = false; }
    });
    openModal(title, form);
    return form;
  }

  $('#pwBtn').addEventListener('click', () => {
    formModal('Şifre değiştir', [
      h('label', { class: 'field' }, 'Mevcut şifre', h('input', { class: 'input', id: 'pwCur', type: 'password', autocomplete: 'current-password' })),
      h('label', { class: 'field' }, 'Yeni şifre', h('input', { class: 'input', id: 'pwNew', type: 'password', autocomplete: 'new-password' })),
      h('label', { class: 'field' }, 'Yeni şifre (tekrar)', h('input', { class: 'input', id: 'pwNew2', type: 'password', autocomplete: 'new-password' })),
      h('small', { class: 'muted', text: 'En az 14 karakter; büyük harf, küçük harf ve rakam içermeli. Değişiklikten sonra diğer tüm oturumlar kapanır.' }),
      codeField('pwCode'),
    ], 'Şifreyi değiştir', async () => {
      if ($('#pwNew').value !== $('#pwNew2').value) throw new Error('Yeni şifreler aynı değil.');
      await call('/password', { method: 'POST', body: { current: $('#pwCur').value, next: $('#pwNew').value, code: $('#pwCode').value.trim() } });
      closeModal();
      toast('Şifre değiştirildi.');
      loadSecurity();
    });
  });

  $('#totpBtn').addEventListener('click', () => {
    formModal('Doğrulama uygulamasını yeniden kur', [
      h('p', { class: 'muted', text: 'Telefon değiştirdiyseniz veya kaybettiyseniz kullanın. Şifrenizi ve mevcut 6 haneli kodu girin; telefon kaybolduysa kod yerine bir yedek kod yazın.' }),
      h('label', { class: 'field' }, 'Şifre', h('input', { class: 'input', id: 'tpPw', type: 'password', autocomplete: 'current-password' })),
      h('label', { class: 'field' }, 'Mevcut doğrulama kodu veya yedek kod', h('input', { class: 'input mono', id: 'tpOld', autocomplete: 'one-time-code', maxlength: 12, placeholder: '000000 veya ABCD-EFGH' })),
    ], 'Devam et', async () => {
      const r = await call('/totp/begin', { method: 'POST', body: { password: $('#tpPw').value, code: $('#tpOld').value.trim() } });
      formModal('Yeni anahtarı uygulamaya ekleyin', [
        h('ol', { class: 'steps' },
          h('li', { text: 'Google veya Microsoft Authenticator uygulamasını açın.' }),
          h('li', { text: '“+” → “Kurulum anahtarı girin” seçin.' }),
          h('li', { text: 'Hesap adı: ozkandemir.net · Anahtar: aşağıdaki kod · Tür: Zamana dayalı.' })),
        h('div', { class: 'secret', text: r.secret }),
        h('a', { class: 'btn btn-sm', href: r.uri }, 'Bu cihazdaki uygulamada aç'),
        codeField('tpCode', 'Uygulamanın gösterdiği yeni 6 haneli kod'),
        h('small', { class: 'muted', text: 'Onayladığınızda eski kodlar geçersiz olur ve diğer tüm oturumlar kapanır.' }),
      ], 'Onayla ve etkinleştir', async () => {
        await call('/totp/confirm', { method: 'POST', body: { code: $('#tpCode').value.trim() } });
        closeModal();
        toast('Doğrulama uygulaması yenilendi.');
        loadSecurity();
      });
    });
  });

  $('#bcBtn').addEventListener('click', () => {
    formModal('Yedek kodları yenile', [
      h('p', { class: 'muted', text: 'Eski yedek kodların tamamı geçersiz olur. Yeni 10 kod yalnızca bir kez gösterilir.' }),
      codeField('bcCode'),
    ], 'Yeni kodları oluştur', async () => {
      const r = await call('/backup-codes', { method: 'POST', body: { code: $('#bcCode').value.trim() } });
      const text = 'ozkandemir.net panel yedek kodları\n' + new Date().toLocaleString('tr-TR') + '\n\n' + r.codes.join('\n') + '\n\nHer kod bir kez kullanılabilir.';
      const blobUrl = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      const copy = h('button', { type: 'button', class: 'btn btn-sm' }, 'Kopyala');
      copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(text); toast('Kodlar kopyalandı.'); } catch { toast('Kopyalanamadı, dosya olarak indirin.', true); } });
      openModal('Yeni yedek kodlarınız', h('div', { class: 'modal-body' },
        h('div', { class: 'alert alert-warn', text: 'Bu kodları güvenli bir yere kaydedin (yazdırın veya parola yöneticisine ekleyin). Pencere kapandıktan sonra tekrar gösterilmez.' }),
        h('div', { class: 'codes' }, r.codes.map((c) => h('code', { text: c }))),
        h('div', { class: 'btn-row' }, copy, h('a', { class: 'btn btn-sm', href: blobUrl, download: 'ozkandemir-panel-yedek-kodlar.txt' }, 'Metin dosyası olarak indir')),
      ));
      loadSecurity();
    });
  });

  $('#logoutBtn').addEventListener('click', async () => {
    try { await api('/logout', { method: 'POST', body: {} }); } catch {}
    location.replace('/panel/');
  });

  // Lisans modülü (lisans.js) için ortak yardımcılar
  window.ODApp = { call, toast, msg, openModal, closeModal, armed, left, browserName };

  // ---------- Başlangıç ----------
  (async function boot() {
    try {
      const me = await call('/me');
      state.idleTimeout = me.idleTimeout;
      state.expiresAt = me.expiresAt;
      state.clockSkew = me.serverTime - Date.now() / 1000;
      $('#sessWhere').textContent = `Oturum: ${me.location} · ${browserName(me.ua)}`;
    } catch (e) {
      if (e.status !== 401) {
        document.body.classList.remove('booting');
        toast(e.message, true);
      }
      return goLogin();
    }
    document.body.classList.remove('booting');
    try {
      const bl = sessionStorage.getItem('od-backup-left');
      if (bl !== null) {
        sessionStorage.removeItem('od-backup-left');
        msg($('#backupWarn'), `Yedek kodla giriş yaptınız. Kalan yedek kod: ${bl}. Telefonunuz kaybolduysa Güvenlik bölümünden doğrulama uygulamasını yeniden kurun.`, 'warn');
      }
    } catch {}
    state.view = '';
    route();
    setInterval(idleTick, 15000);
    idleTick();
  })();
})();
