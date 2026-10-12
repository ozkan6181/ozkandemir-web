// ozkandemir.net V3.13 — 7 günlük demo talep formu
(function () {
  var form = document.getElementById('demoForm');
  if (!form) return;
  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);
  var urun = params.get('urun');
  if (urun && $('demoProgram').querySelector('option[value="' + urun.replace(/[^a-z0-9-]/g, '') + '"]')) $('demoProgram').value = urun;
  function show(text, ok) {
    var m = $('demoMsg');
    m.textContent = text;
    m.className = 'full demo-msg ' + (ok ? 'ok' : 'err');
    m.hidden = false;
    m.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var body = {
      program: $('demoProgram').value,
      company: $('demoCompany').value.trim(),
      contact_name: $('demoName').value.trim(),
      email: $('demoEmail').value.trim(),
      phone: $('demoPhone').value.trim(),
      note: $('demoNote').value.trim(),
      website: $('demoWebsite').value,
      kvkk: $('demoKvkk').checked,
    };
    if (body.company.length < 2) return show('Firma adını yazın.');
    if (body.contact_name.length < 3) return show('Adınızı ve soyadınızı yazın.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(body.email)) return show('Geçerli bir e-posta adresi yazın; demo bilgileri bu adrese gönderilecek.');
    if (body.phone.replace(/\D/g, '').length < 10) return show('Telefon numaranızı yazın.');
    if (!body.kvkk) return show('Devam etmek için KVKK aydınlatma metnini onaylayın.');
    var btn = $('demoSubmit');
    btn.disabled = true; btn.textContent = 'Gönderiliyor…';
    fetch('/lisans/api/demo-talep', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, message: 'Sunucuya ulaşılamadı.' }; }); })
      .then(function (d) {
        if (d && d.ok) {
          show(d.message || 'Talebiniz alındı.', true);
          form.querySelectorAll('input:not([type=checkbox]),textarea').forEach(function (el) { el.value = ''; });
          $('demoKvkk').checked = false;
        } else {
          show((d && d.message) || 'Talep gönderilemedi. Lütfen 0551 600 77 87 numarasından ulaşın.');
        }
      })
      .catch(function () { show('Bağlantı hatası. Lütfen tekrar deneyin ya da 0551 600 77 87 numarasından ulaşın.'); })
      .then(function () { btn.disabled = false; btn.textContent = 'Demo Talebini Gönder'; });
  });
})();
