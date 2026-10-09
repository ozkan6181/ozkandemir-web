/* ozkandemir.net V3.6 — Panel ortak yardımcıları (CSP uyumlu: innerHTML kullanılmaz) */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  async function api(path, { method = 'GET', body } = {}) {
    const opts = { method, headers: {}, credentials: 'same-origin', cache: 'no-store' };
    if (method !== 'GET') opts.headers['x-od-panel'] = '1';
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      opts.body = body;
      opts.headers['content-type'] = 'application/octet-stream';
    } else if (body !== undefined) {
      opts.body = JSON.stringify(body);
      opts.headers['content-type'] = 'application/json';
    }
    let r;
    try {
      r = await fetch('/panel/api' + path, opts);
    } catch {
      const e = new Error('Bağlantı kurulamadı. İnternet bağlantınızı kontrol edin.');
      e.status = 0;
      throw e;
    }
    let data = {};
    try { data = await r.json(); } catch {}
    if (!r.ok) {
      const e = new Error(data.error || 'İşlem tamamlanamadı (' + r.status + ').');
      e.status = r.status;
      e.data = data;
      throw e;
    }
    return data;
  }

  // Güvenli DOM oluşturucu: metinler her zaman textContent ile eklenir
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const ICONS = {
    box: 'M21 16V8l-9-5-9 5v8l9 5z|M3.3 7L12 12l8.7-5M12 22V12',
    upload: 'M12 16V4M7 9l5-5 5 5|M20 16v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3',
    link: 'M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1|M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
    shield: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z',
    shieldok: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z|M8.5 12l2.5 2.5 4.5-5',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    alert: 'M12 3l10 18H2z|M12 10v4M12 17.5h.01',
    lock: 'M6 11h12v10H6z|M8 11V7a4 4 0 0 1 8 0v4',
    phone: 'M7 2h10v20H7z|M11 18h2',
    list: 'M4 6h16M4 12h16M4 18h10',
    search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z|M20 20l-3.5-3.5',
    plus: 'M12 5v14M5 12h14',
    info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z|M12 8v5M12 16h.01',
  };
  const NS = 'http://www.w3.org/2000/svg';
  function icon(name, cls = 'ic') {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', cls);
    for (const d of (ICONS[name] || '').split('|')) {
      if (!d) continue;
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    }
    return svg;
  }

  function fmtSize(n) {
    n = Number(n) || 0;
    if (!n) return '0 MB';
    if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2).replace('.', ',') + ' GB';
    if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1).replace('.', ',') + ' MB';
    return Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  window.OD = { $, $$, api, h, icon, fmtSize };
})();
