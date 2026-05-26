(function () {
  'use strict';

  const ERR_MAP = {
    'Invalid login credentials': 'Email or password is incorrect.',
    'User already registered': 'An account with this email already exists. Try logging in.',
    'Email not confirmed': 'Please check your email to confirm your account before logging in.',
    'Password should be at least 6 characters.': 'Password must be at least 8 characters.'
  };
  function friendly(err) {
    if (!err) return 'Something went wrong. Please try again.';
    const msg = (err.message || String(err)).trim();
    if (ERR_MAP[msg]) return ERR_MAP[msg];
    if (/Password should contain/i.test(msg)) {
      return 'Your password needs lowercase, uppercase, a number, and a special character (e.g. !@#$). Try something like "MyPass2024!".';
    }
    if (/Password should be at least/i.test(msg)) {
      return 'Password is too short — please use at least 8 characters.';
    }
    if (/For security purposes/i.test(msg)) {
      return 'Too many attempts — please wait a minute and try again.';
    }
    if (/rate limit/i.test(msg)) {
      return 'Too many requests right now. Please wait a moment.';
    }
    return msg;
  }

  function $(id) { return document.getElementById(id); }
  function sb() { return window.hirayaSupabase; }
  function clientReady() {
    if (!sb()) {
      showToast('Auth is not configured yet. Please fill in /js/config.js.', 'error');
      return false;
    }
    return true;
  }

  // ── PHONE FORMATTING ───────────────────────────────────────────────────
  // Formats any digit string into North American (XXX) XXX-XXXX.
  // Strips a leading "1" country code if present (so +1 519... → 519...).
  function formatPhone(value) {
    const digits = String(value == null ? '' : value).replace(/\D/g, '');
    const d = (digits.length === 11 && digits.startsWith('1')) ? digits.slice(1) : digits;
    if (!d) return '';
    if (d.length < 4) return '(' + d;
    if (d.length < 7) return '(' + d.slice(0, 3) + ') ' + d.slice(3);
    return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6, 10);
  }

  function wirePhoneInput(el) {
    if (!el || el.dataset.phoneWired === '1') return;
    el.dataset.phoneWired = '1';
    el.addEventListener('input', function () {
      const atEnd = el.selectionStart === el.value.length;
      el.value = formatPhone(el.value);
      if (atEnd) {
        const len = el.value.length;
        el.setSelectionRange(len, len);
      }
    });
    el.addEventListener('blur', function () {
      if (el.value) el.value = formatPhone(el.value);
    });
  }

  // ── POSTAL CODE FORMATTING (Canadian: A1A 1A1) ─────────────────────────
  function formatPostal(value) {
    let s = String(value == null ? '' : value).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (s.length > 3) s = s.slice(0, 3) + ' ' + s.slice(3);
    return s;
  }

  function wirePostalInput(el) {
    if (!el || el.dataset.postalWired === '1') return;
    el.dataset.postalWired = '1';
    el.addEventListener('input', function () {
      const atEnd = el.selectionStart === el.value.length;
      el.value = formatPostal(el.value);
      if (atEnd) {
        const len = el.value.length;
        el.setSelectionRange(len, len);
      }
    });
    el.addEventListener('blur', function () {
      if (el.value) el.value = formatPostal(el.value);
    });
  }

  // ── BOOKING FORM PREFILL ───────────────────────────────────────────────
  function prefillBookingForm(user) {
    if (!user) return;
    const meta = user.user_metadata || {};
    const nameEl = $('f-name');
    const phoneEl = $('f-phone');
    const emailEl = $('f-email');
    if (nameEl && !nameEl.value) nameEl.value = meta.full_name || '';
    if (phoneEl && !phoneEl.value) phoneEl.value = formatPhone(meta.phone || '');
    if (emailEl && !emailEl.value) emailEl.value = user.email || '';
  }

  function clearBookingForm() {
    // Only clears name/phone/email. The structured address fields are
    // cleared by booking.js (clearBookingAddressFields) on SIGNED_OUT so
    // they stay in sync with the saved-address picker.
    ['f-name', 'f-phone', 'f-email'].forEach(function (id) {
      const el = $(id);
      if (el) el.value = '';
    });
  }

  // ── TOAST ──────────────────────────────────────────────────────────────
  function showToast(text, kind) {
    let host = $('hiraya-toast');
    if (!host) {
      host = document.createElement('div');
      host.id = 'hiraya-toast';
      host.className = 'hiraya-toast';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    host.textContent = text;
    host.dataset.kind = kind || 'success';
    host.classList.add('visible');
    clearTimeout(host._t);
    host._t = setTimeout(() => host.classList.remove('visible'), 4500);
  }

  // ── ERROR DISPLAY ──────────────────────────────────────────────────────
  function showErr(id, text) {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    el.style.display = 'block';
  }
  function hideErr(id) {
    const el = $(id);
    if (el) el.style.display = 'none';
  }
  function clearAuthErrors() {
    ['login-err', 'su-err', 'fp-err'].forEach(hideErr);
  }

  // ── MODAL OPEN / CLOSE / SWITCH ────────────────────────────────────────
  let lastFocused = null;
  let focusTrapHandler = null;

  function openAuthModal(view) {
    const modal = $('auth-modal');
    if (!modal) return;
    lastFocused = document.activeElement;
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
    switchAuthView(view || 'login');
    installFocusTrap(modal);
  }

  function closeAuthModal() {
    const modal = $('auth-modal');
    if (!modal) return;
    modal.classList.remove('open');
    document.body.style.overflow = '';
    clearAuthErrors();
    removeFocusTrap();
    if (lastFocused && typeof lastFocused.focus === 'function') {
      lastFocused.focus();
    }
  }

  function switchAuthView(view) {
    clearAuthErrors();
    const views = {
      login: 'form-login',
      signup: 'form-signup',
      forgot: 'form-forgot',
      'check-email': 'form-check-email'
    };
    Object.keys(views).forEach(k => {
      const el = $(views[k]);
      if (el) el.style.display = (k === view) ? 'block' : 'none';
    });
    setTimeout(() => {
      const target = $(views[view]);
      const firstInput = target?.querySelector('input');
      const firstBtn = target?.querySelector('button');
      (firstInput || firstBtn)?.focus();
    }, 30);
  }

  function showCheckEmailView(opts) {
    const titleEl = $('check-email-title');
    const subEl = $('check-email-sub');
    if (titleEl) titleEl.textContent = opts.title || 'Check your email';
    if (subEl) subEl.innerHTML = opts.sub || '';
    // Re-fetch addrEl AFTER innerHTML rewrite — the old reference is now detached.
    const addrEl = $('check-email-addr');
    if (addrEl) addrEl.textContent = opts.email || '';
    switchAuthView('check-email');
  }

  function installFocusTrap(modal) {
    focusTrapHandler = function (e) {
      if (e.key === 'Escape') { e.preventDefault(); closeAuthModal(); return; }
      if (e.key !== 'Tab') return;
      const focusables = modal.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      const visible = Array.from(focusables).filter(el => el.offsetParent !== null);
      if (visible.length === 0) return;
      const first = visible[0];
      const last = visible[visible.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', focusTrapHandler);
  }
  function removeFocusTrap() {
    if (focusTrapHandler) document.removeEventListener('keydown', focusTrapHandler);
    focusTrapHandler = null;
  }

  // ── SIGNUP ─────────────────────────────────────────────────────────────
  async function doSignup() {
    if (!clientReady()) return;
    hideErr('su-err');
    const name = $('su-name').value.trim();
    const email = $('su-email').value.trim().toLowerCase();
    const phone = ($('su-phone')?.value || '').trim();
    const pass = $('su-pass').value;
    const pass2 = $('su-pass2').value;

    if (!name || !email || !pass || !pass2) {
      showErr('su-err', 'Please fill in all required fields.');
      return;
    }
    if (pass.length < 8) {
      showErr('su-err', 'Password must be at least 8 characters.');
      return;
    }
    if (pass !== pass2) {
      showErr('su-err', 'Passwords do not match.');
      return;
    }

    const btn = $('su-submit');
    if (btn) { btn.disabled = true; btn.textContent = 'Creating account…'; }

    console.log('[Hiraya] doSignup → calling supabase.auth.signUp for', email);
    const { data, error } = await sb().auth.signUp({
      email,
      password: pass,
      options: {
        data: { full_name: name, phone: phone || null },
        emailRedirectTo: window.location.origin + '/'
      }
    });
    console.log('[Hiraya] doSignup ← response:', { data, error });

    if (btn) { btn.disabled = false; btn.textContent = 'Create account'; }

    if (error) {
      console.log('[Hiraya] doSignup: showing error', error.message);
      showErr('su-err', friendly(error));
      return;
    }

    if (data?.user && !data.session) {
      console.log('[Hiraya] doSignup: showing check-email view');
      showCheckEmailView({
        title: 'Check your email',
        sub: 'We sent a confirmation link to <strong id="check-email-addr"></strong>. Click the link in that email to activate your account, then come back here to log in.',
        email: email
      });
    } else if (data?.session) {
      console.log('[Hiraya] doSignup: instant session — closing modal');
      closeAuthModal();
      showToast('Welcome to Hiraya Spaces!', 'success');
    } else {
      // Supabase v2 returns {user: null, session: null, error: null} as an
      // obfuscated response when email confirmation is enabled. It looks the
      // same whether the email is new (signup succeeded, email sent) or already
      // registered (no email sent) — security to prevent email enumeration.
      // We show the check-email view either way; if they don't get an email
      // they can fall back to logging in.
      console.log('[Hiraya] doSignup: obfuscated response → showing check-email view');
      showCheckEmailView({
        title: 'Check your email',
        sub: 'If this email is new, a confirmation link has been sent to <strong id="check-email-addr"></strong>. Click the link to activate your account. If you already have an account, just <a onclick="HirayaAuth.switchAuthView(\'login\')" style="color:var(--sage);cursor:pointer;font-weight:600">log in</a> instead.',
        email: email
      });
    }
  }

  // ── LOGIN ──────────────────────────────────────────────────────────────
  // Tracks how many times login has been clicked this session — surfaced in
  // the toast so a user reporting "nothing happens" can tell us how many
  // taps actually reached the JS.
  let loginAttemptCount = 0;
  async function doLogin() {
    loginAttemptCount += 1;
    // Immediate visible feedback. If the user reports "nothing happens" and
    // doesn't see this toast either, the click isn't reaching JS at all
    // (browser/CSS issue). If they DO see it but no login, the bug is below.
    showToast('Signing in…', 'success');

    if (!clientReady()) {
      showErr('login-err', 'Booking system is still loading. Try again in a second.');
      showToast('Booking system not ready. Refresh the page.', 'error');
      return;
    }
    hideErr('login-err');
    const email = ($('login-email')?.value || '').trim().toLowerCase();
    const pass = $('login-pass')?.value || '';

    if (!email || !pass) {
      showErr('login-err', 'Please enter your email and password.');
      showToast('Email and password required.', 'error');
      return;
    }

    const btn = $('login-submit');
    if (btn) { btn.disabled = true; btn.textContent = 'Logging in…'; }

    // Wrap the whole flow so ANY unexpected error becomes a visible message
    // instead of "I clicked log in and nothing happened."
    try {
      // Force a clean slate: nuke any stale local session before re-attempting.
      // Some users end up with a half-broken cached session that swallows
      // signInWithPassword silently — this guarantees a fresh request.
      try { await sb().auth.signOut({ scope: 'local' }); } catch (_) {}

      const { data, error } = await sb().auth.signInWithPassword({ email, password: pass });

      if (error) {
        showErr('login-err', friendly(error));
        if (btn) { btn.disabled = false; btn.textContent = 'Log in'; }
        return;
      }

      // Verify the session actually persisted. iOS Private Mode / strict ITP
      // can return success but silently drop the session because localStorage
      // is blocked.
      const { data: sessionData } = await sb().auth.getSession();
      if (!sessionData?.session) {
        showErr('login-err', 'Signed in, but the session was blocked by your browser. Try a non-private tab or another browser.');
        if (btn) { btn.disabled = false; btn.textContent = 'Log in'; }
        return;
      }

      // Force a fresh page load so the entire UI re-renders against the new
      // auth state. Eliminates every "modal closed but I'm not logged in"
      // edge case regardless of whether onAuthStateChange fired.
      closeAuthModal();
      window.location.reload();
    } catch (err) {
      console.error('doLogin error:', err);
      const msg = (err && err.message) || String(err) || 'Unexpected error';
      showErr('login-err', msg + ' — refresh and try again.');
      showToast('Login error: ' + msg, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Log in'; }
    }
  }

  // Force a fresh login flow even when the user is already signed in.
  // Used by the "Sign in as someone else" menu item — clears the cached
  // session locally and globally, then opens the login modal.
  async function switchAccount() {
    try { closeUserMenu(); } catch (_) {}
    try { await sb().auth.signOut(); } catch (e) { console.warn('switchAccount signOut failed:', e); }
    // Clear any leftover login fields so the new user starts fresh.
    const emailEl = $('login-email'); if (emailEl) emailEl.value = '';
    const passEl = $('login-pass'); if (passEl) passEl.value = '';
    setNavLoggedOut();
    openAuthModal('login');
  }

  // ── LOGOUT ─────────────────────────────────────────────────────────────
  async function doLogout() {
    if (!clientReady()) return;
    await sb().auth.signOut();
    showToast('You have been logged out.', 'success');
  }

  // ── FORGOT PASSWORD ────────────────────────────────────────────────────
  async function doForgotPassword() {
    if (!clientReady()) return;
    hideErr('fp-err');
    const email = $('fp-email').value.trim().toLowerCase();
    if (!email) { showErr('fp-err', 'Please enter your email.'); return; }

    const btn = $('fp-submit');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

    const { error } = await sb().auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + '/reset-password'
    });

    if (btn) { btn.disabled = false; btn.textContent = 'Send reset link'; }

    if (error) { showErr('fp-err', friendly(error)); return; }
    showCheckEmailView({
      title: 'Check your email',
      sub: 'We sent a password reset link to <strong id="check-email-addr"></strong>. Click the link to set a new password.',
      email: email
    });
  }

  // ── RESET PASSWORD (on /reset-password page) ──────────────────────────
  async function doResetPassword() {
    if (!clientReady()) return;
    hideErr('rp-err');
    const pass = $('rp-pass').value;
    const pass2 = $('rp-pass2').value;

    if (!pass || !pass2) { showErr('rp-err', 'Please enter and confirm your new password.'); return; }
    if (pass.length < 8) { showErr('rp-err', 'Password must be at least 8 characters.'); return; }
    if (pass !== pass2) { showErr('rp-err', 'Passwords do not match.'); return; }

    const btn = $('rp-submit');
    if (btn) { btn.disabled = true; btn.textContent = 'Updating…'; }

    const { error } = await sb().auth.updateUser({ password: pass });

    if (btn) { btn.disabled = false; btn.textContent = 'Update password'; }

    if (error) { showErr('rp-err', friendly(error)); return; }
    showToast('Password updated. Redirecting…', 'success');
    setTimeout(() => { window.location.href = '/'; }, 1200);
  }

  // ── NAV STATE ──────────────────────────────────────────────────────────
  function setNavLoggedOut() {
    const loginBtn = $('nav-login-btn');
    const signupBtn = $('nav-signup-btn');
    const userWrap = $('nav-user-wrap');
    const accountLink = $('nav-account-link');
    const mLogin = $('m-link-login');
    const mSignup = $('m-link-signup');
    const mBookings = $('m-link-bookings');
    const mLogout = $('m-link-logout');
    if (loginBtn) loginBtn.style.display = '';
    if (signupBtn) signupBtn.style.display = '';
    if (userWrap) userWrap.style.display = 'none';
    if (accountLink) accountLink.style.display = 'none';
    if (mLogin) mLogin.style.display = '';
    if (mSignup) mSignup.style.display = '';
    if (mBookings) mBookings.style.display = 'none';
    if (mLogout) mLogout.style.display = 'none';
    closeUserMenu();
  }
  function setNavLoggedIn(user) {
    const loginBtn = $('nav-login-btn');
    const signupBtn = $('nav-signup-btn');
    const userWrap = $('nav-user-wrap');
    const accountLink = $('nav-account-link');
    const greet = $('nav-user-greet');
    const mLogin = $('m-link-login');
    const mSignup = $('m-link-signup');
    const mBookings = $('m-link-bookings');
    const mLogout = $('m-link-logout');
    if (loginBtn) loginBtn.style.display = 'none';
    if (signupBtn) signupBtn.style.display = 'none';
    if (userWrap) userWrap.style.display = 'flex';
    if (accountLink) accountLink.style.display = '';
    if (mLogin) mLogin.style.display = 'none';
    if (mSignup) mSignup.style.display = 'none';
    if (mBookings) mBookings.style.display = '';
    if (mLogout) mLogout.style.display = '';
    const meta = user.user_metadata || {};
    const fullName = meta.full_name || user.email || '';
    const first = fullName.split(' ')[0] || fullName;
    if (greet) greet.textContent = 'Welcome, ' + first;
  }

  // ── USER DROPDOWN MENU ─────────────────────────────────────────────────
  function toggleUserMenu() {
    const menu = $('nav-user-menu');
    const trigger = $('nav-user-trigger');
    if (!menu || !trigger) return;
    const isOpen = menu.classList.contains('open');
    if (isOpen) closeUserMenu();
    else openUserMenu();
  }
  function openUserMenu() {
    const menu = $('nav-user-menu');
    const trigger = $('nav-user-trigger');
    if (!menu || !trigger) return;
    menu.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
  }
  function closeUserMenu() {
    const menu = $('nav-user-menu');
    const trigger = $('nav-user-trigger');
    if (!menu) return;
    menu.classList.remove('open');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  }
  // Close the dropdown when clicking outside or pressing Escape.
  document.addEventListener('click', function (e) {
    const wrap = $('nav-user-wrap');
    if (!wrap || !wrap.contains(e.target)) closeUserMenu();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeUserMenu();
  });

  // ── EMAIL CONFIRMATION DETECTION ───────────────────────────────────────
  // Capture the URL fragment BEFORE Supabase clears it via detectSessionInUrl.
  const initialHash = window.location.hash || '';
  const isEmailConfirmation = /type=signup/.test(initialHash);
  const isRecoveryFlow = /type=recovery/.test(initialHash);
  let toastShownForConfirm = false;

  // ── BOOT ───────────────────────────────────────────────────────────────
  function wireUI() {
    const modal = $('auth-modal');
    if (modal) {
      modal.addEventListener('click', function (e) {
        if (e.target === modal) closeAuthModal();
      });
    }
    wirePhoneInput($('f-phone'));
    wirePhoneInput($('su-phone'));
    wirePostalInput($('f-postal'));
    wirePostalInput($('addr-postal'));
  }

  async function boot() {
    wireUI();

    if (!sb()) {
      setNavLoggedOut();
      return;
    }

    // Wrap in try/catch — getUser() noisily logs "AuthSessionMissingError"
    // to the console for every anonymous visitor, which clutters logs.
    let user = null;
    try {
      const { data } = await sb().auth.getUser();
      user = data?.user || null;
    } catch (_) { /* anon visitor or expired token — silent. */ }
    if (user) {
      setNavLoggedIn(user);
      prefillBookingForm(user);
    } else {
      setNavLoggedOut();
    }

    sb().auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session?.user) {
        setNavLoggedIn(session.user);
        prefillBookingForm(session.user);
        if (isEmailConfirmation && !toastShownForConfirm) {
          toastShownForConfirm = true;
          showToast('Email confirmed — welcome to Hiraya Spaces!', 'success');
        }
      } else if (event === 'SIGNED_OUT') {
        setNavLoggedOut();
        clearBookingForm();
      } else if (event === 'PASSWORD_RECOVERY') {
        // On the reset-password page this is the cue to show the new-password form.
        const rpForm = $('reset-password-form');
        if (rpForm) rpForm.dataset.ready = 'true';
      } else if (event === 'USER_UPDATED' && session?.user) {
        setNavLoggedIn(session.user);
        prefillBookingForm(session.user);
      }
    });

    // If we landed on /reset-password directly without a recovery hash, warn the user.
    if ($('reset-password-form') && !isRecoveryFlow && !(await sb().auth.getSession()).data.session) {
      showErr('rp-err', 'This page only works from a password reset email link.');
    }
  }

  // ── EXPORTS ────────────────────────────────────────────────────────────
  window.HirayaAuth = {
    openAuthModal,
    switchAccount,
    closeAuthModal,
    switchAuthView,
    doSignup,
    doLogin,
    doLogout,
    doForgotPassword,
    doResetPassword,
    toggleUserMenu,
    closeUserMenu
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
