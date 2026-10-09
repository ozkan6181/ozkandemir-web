/* ozkandemir.net V3.6 — Panel girişi */
(function () {
  'use strict';
  const { $, $$, api } = window.OD;
  const loginForm = $('#loginForm'), otpForm = $('#otpForm');
  const boxes = $$('#otpBoxes input');
  let challenge = null, expiresAt = 0, timer = null, backupMode = false, busy = false;

  function msg(el, text, kind = 'err') {
    if (!text) { el.hidden = true; el.textContent = ''; return; }
    el.className = 'alert alert-' + kind;
    el.textContent = text;
    el.hidden = false;
  }

  const params = new URLSearchParams(location.search);
  if (params.get('cikis') === '1') msg($('#loginMsg'), 'Oturumunuz kapandı. Güvenliğiniz için yeniden giriş yapın.', 'info');
  history.replaceState(null, '', '/panel/');

  // Zaten açık oturum varsa doğrudan panele geç; yönetici hesabı yoksa ilk kurulum sihirbazını göster
  api('/me').then(() => location.replace('/panel/app')).catch(() => {
    api('/setup/status').then((st) => { if (st.needsSetup) startSetup(st.setupEnabled); }).catch((e) => {
      if (e.status === 503) msg($('#loginMsg'), 'Panel ilk kez hazırlanıyor. Birkaç dakika sonra sayfayı yenileyin.', 'info');
    });
  });

  // ---------- İlk kurulum ----------
  let setupToken = null;
  function startSetup(enabled) {
    loginForm.hidden = true;
    otpForm.hidden = true;
    $('#setupStart').hidden = false;
    if (!enabled) msg($('#setupMsg'), 'Kurulum kodu tanımlı değil. Lütfen Özkan Demir’e (geliştirici) başvurun.', 'err');
    $('#setupCode').focus();
  }
  $('#setupStart').addEventListener('submit', async (e) => {
    e.preventDefault();
    msg($('#setupMsg'), '');
    if ($('#setupPw').value !== $('#setupPw2').value) return msg($('#setupMsg'), 'Şifreler aynı değil.');
    $('#setupBtn').disabled = true;
    try {
      const r = await api('/setup/start', { method: 'POST', body: { setupCode: $('#setupCode').value, email: $('#setupEmail').value, password: $('#setupPw').value } });
      setupToken = r.token;
      $('#setupQr').replaceChildren(window.ODQR.svg(r.uri, 220));
      $('#setupSecret').textContent = r.secret;
      $('#setupOtpLink').href = r.uri;
      $('#setupStart').hidden = true;
      $('#setupPhone').hidden = false;
      $('#setupTotp').focus();
    } catch (err) {
      msg($('#setupMsg'), err.message);
    } finally {
      $('#setupBtn').disabled = false;
    }
  });
  $('#setupPhone').addEventListener('submit', async (e) => {
    e.preventDefault();
    msg($('#setupPhoneMsg'), '');
    const code = $('#setupTotp').value.replace(/\D/g, '');
    if (code.length !== 6) return msg($('#setupPhoneMsg'), 'Uygulamadaki 6 haneli kodu girin.');
    $('#setupPhoneBtn').disabled = true;
    try {
      const r = await api('/setup/finish', { method: 'POST', body: { token: setupToken, code } });
      const text = 'ozkandemir.net panel yedek kodları\n' + new Date().toLocaleString('tr-TR') + '\n\n' + r.codes.join('\n') + '\n\nHer kod bir kez kullanılabilir.';
      $('#setupCodes').replaceChildren(...r.codes.map((c) => { const el = document.createElement('code'); el.textContent = c; return el; }));
      $('#setupDownload').href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      $('#setupCopy').onclick = async () => { try { await navigator.clipboard.writeText(text); $('#setupCopy').textContent = 'Kopyalandı ✓'; } catch {} };
      $('#setupPhone').hidden = true;
      $('#setupDone').hidden = false;
    } catch (err) {
      if (err.data && err.data.restart) { $('#setupPhone').hidden = true; $('#setupStart').hidden = false; return msg($('#setupMsg'), err.message); }
      msg($('#setupPhoneMsg'), err.message);
      $('#setupTotp').select();
    } finally {
      $('#setupPhoneBtn').disabled = false;
    }
  });
  $('#setupSaved').addEventListener('change', () => { $('#setupGo').setAttribute('aria-disabled', $('#setupSaved').checked ? 'false' : 'true'); });

  function showLogin(text, kind) {
    clearInterval(timer);
    challenge = null;
    otpForm.hidden = true;
    loginForm.hidden = false;
    $('#password').value = '';
    msg($('#loginMsg'), text, kind);
    $('#password').focus();
  }

  function showOtp(ch, ttl) {
    challenge = ch;
    expiresAt = Date.now() + ttl * 1000;
    loginForm.hidden = true;
    otpForm.hidden = false;
    msg($('#otpMsg'), '');
    setBackup(false);
    boxes.forEach((b) => { b.value = ''; });
    boxes[0].focus();
    clearInterval(timer);
    const tickFn = () => {
      const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      $('#otpTimer').textContent = `Bu adım için kalan süre: ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      if (left <= 0) showLogin('Doğrulama süresi doldu. Lütfen yeniden giriş yapın.', 'info');
    };
    tickFn();
    timer = setInterval(tickFn, 1000);
  }

  function setBackup(on) {
    backupMode = on;
    $('#otpBoxes').hidden = on;
    $('#backupWrap').hidden = !on;
    $('#backupToggle').textContent = on ? 'Doğrulama uygulamasını kullan' : 'Telefonum yanımda değil (yedek kod)';
    $('#otpTitle').textContent = on ? 'Yedek kodu girin' : 'Doğrulama kodunu girin';
    $('#otpHelp').textContent = on
      ? 'Kurulumda verilen 10 yedek koddan birini yazın. Her yedek kod yalnızca bir kez kullanılabilir.'
      : 'Google Authenticator veya Microsoft Authenticator uygulamasındaki 6 haneli kodu yazın. Kod her 30 saniyede yenilenir.';
    (on ? $('#backupCode') : boxes[0]).focus();
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const email = $('#email').value.trim(), password = $('#password').value;
    if (!email || !password) return msg($('#loginMsg'), 'E-posta ve şifre gerekli.');
    busy = true;
    $('#loginBtn').disabled = true;
    msg($('#loginMsg'), '');
    try {
      const r = await api('/login', { method: 'POST', body: { email, password } });
      if (r.ok) return location.replace('/panel/app');
      showOtp(r.challenge, r.expiresIn || 300);
    } catch (err) {
      msg($('#loginMsg'), err.message);
      $('#password').select();
    } finally {
      busy = false;
      $('#loginBtn').disabled = false;
    }
  });

  boxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      const digits = box.value.replace(/\D/g, '');
      if (digits.length > 1) return fillFrom(i, digits);
      box.value = digits;
      if (digits && i < 5) boxes[i + 1].focus();
      if (boxes.every((b) => b.value)) submitOtp();
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !box.value && i > 0) { boxes[i - 1].focus(); boxes[i - 1].value = ''; }
      if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus();
      if (e.key === 'ArrowRight' && i < 5) boxes[i + 1].focus();
    });
    box.addEventListener('paste', (e) => {
      const t = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
      if (t) { e.preventDefault(); fillFrom(i, t); }
    });
    box.addEventListener('focus', () => box.select());
  });

  function fillFrom(start, digits) {
    for (let k = 0; k < digits.length && start + k < 6; k++) boxes[start + k].value = digits[k];
    const next = Math.min(5, start + digits.length);
    boxes[next].focus();
    if (boxes.every((b) => b.value)) submitOtp();
  }

  otpForm.addEventListener('submit', (e) => { e.preventDefault(); submitOtp(); });

  async function submitOtp() {
    if (busy || !challenge) return;
    const code = backupMode ? $('#backupCode').value.trim() : boxes.map((b) => b.value).join('');
    if (!backupMode && !/^\d{6}$/.test(code)) return msg($('#otpMsg'), '6 haneli kodu eksiksiz girin.');
    if (backupMode && code.replace(/[^A-Za-z0-9]/g, '').length !== 8) return msg($('#otpMsg'), 'Yedek kod 8 karakterden oluşur (ör. ABCD-EFGH).');
    busy = true;
    $('#otpBtn').disabled = true;
    try {
      const r = await api('/verify', { method: 'POST', body: { challenge, code, trust: $('#trust').checked } });
      clearInterval(timer);
      if (typeof r.backupLeft === 'number') {
        try { sessionStorage.setItem('od-backup-left', String(r.backupLeft)); } catch {}
      }
      location.replace('/panel/app');
    } catch (err) {
      if (err.data && err.data.restart) return showLogin(err.message, 'err');
      if (err.status === 429) return showLogin(err.message, 'err');
      msg($('#otpMsg'), err.message);
      boxes.forEach((b) => { b.value = ''; });
      if (!backupMode) boxes[0].focus(); else $('#backupCode').select();
    } finally {
      busy = false;
      $('#otpBtn').disabled = false;
    }
  }

  $('#backBtn').addEventListener('click', () => showLogin(''));
  $('#backupToggle').addEventListener('click', () => setBackup(!backupMode));
  $('#email').focus();
})();
