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
  async function doLogin() {
    if (!clientReady()) return;
    hideErr('login-err');
    const email = $('login-email').value.trim().toLowerCase();
    const pass = $('login-pass').value;

    if (!email || !pass) {
      showErr('login-err', 'Please enter your email and password.');
      return;
    }

    const btn = $('login-submit');
    if (btn) { btn.disabled = true; btn.textContent = 'Logging in…'; }

    const { error } = await sb().auth.signInWithPassword({ email, password: pass });

    if (btn) { btn.disabled = false; btn.textContent = 'Log in'; }

    if (error) { showErr('login-err', friendly(error)); return; }
    closeAuthModal();
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
    if (loginBtn) loginBtn.style.display = '';
    if (signupBtn) signupBtn.style.display = '';
    if (userWrap) userWrap.style.display = 'none';
  }
  function setNavLoggedIn(user) {
    const loginBtn = $('nav-login-btn');
    const signupBtn = $('nav-signup-btn');
    const userWrap = $('nav-user-wrap');
    const greet = $('nav-user-greet');
    if (loginBtn) loginBtn.style.display = 'none';
    if (signupBtn) signupBtn.style.display = 'none';
    if (userWrap) userWrap.style.display = 'flex';
    if (greet) {
      const meta = user.user_metadata || {};
      const fullName = meta.full_name || user.email || '';
      const first = fullName.split(' ')[0] || fullName;
      greet.textContent = 'Welcome, ' + first;
    }
  }

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
  }

  async function boot() {
    wireUI();

    if (!sb()) {
      setNavLoggedOut();
      return;
    }

    const { data: { user } } = await sb().auth.getUser();
    if (user) setNavLoggedIn(user);
    else setNavLoggedOut();

    sb().auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session?.user) {
        setNavLoggedIn(session.user);
        if (isEmailConfirmation && !toastShownForConfirm) {
          toastShownForConfirm = true;
          showToast('Email confirmed — welcome to Hiraya Spaces!', 'success');
        }
      } else if (event === 'SIGNED_OUT') {
        setNavLoggedOut();
      } else if (event === 'PASSWORD_RECOVERY') {
        // On the reset-password page this is the cue to show the new-password form.
        const rpForm = $('reset-password-form');
        if (rpForm) rpForm.dataset.ready = 'true';
      } else if (event === 'USER_UPDATED' && session?.user) {
        setNavLoggedIn(session.user);
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
    closeAuthModal,
    switchAuthView,
    doSignup,
    doLogin,
    doLogout,
    doForgotPassword,
    doResetPassword
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
