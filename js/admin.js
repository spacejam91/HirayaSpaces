(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function sb() { return window.hirayaSupabase; }

  // Keep in lockstep with OWNER_EMAILS in js/account.js and is_owner() in
  // hiraya-schema.sql — all three check the same list of admin emails.
  const OWNER_EMAILS = [
    'aaron-thompson@outlook.com',
    'hirayaspaces@gmail.com',
    'jaeannecm@gmail.com',
  ];

  // ── UTILITIES ──────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function showToast(text, kind) {
    let host = $('hiraya-toast');
    if (!host) {
      host = document.createElement('div');
      host.id = 'hiraya-toast';
      host.className = 'hiraya-toast';
      document.body.appendChild(host);
    }
    host.textContent = text;
    host.dataset.kind = kind || 'success';
    host.classList.add('visible');
    clearTimeout(host._t);
    host._t = setTimeout(() => host.classList.remove('visible'), 4500);
  }

  function statusLabel(status) {
    return ({
      pending_review: 'Pending review',
      awaiting_quote: 'Awaiting quote',
      confirmed: 'Confirmed',
      in_progress: 'In progress',
      completed: 'Completed',
      cancelled: 'Cancelled',
      no_show: 'No show',
    })[status] || status;
  }

  function formatBookingDate(iso) {
    if (!iso) return 'Date TBD';
    // preferred_date is YYYY-MM-DD — anchor to noon UTC so timezone doesn't shift the day
    const d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' });
  }

  function bookingCardHtml(b, opts) {
    opts = opts || {};
    const svc = b.service_name || 'Cleaning service';
    const dateStr = formatBookingDate(b.preferred_date);
    const timeStr = b.preferred_time_slot ? ` at ${escapeHtml(b.preferred_time_slot)}` : '';
    const addr = [
      [b.street_address, b.unit].filter(Boolean).join(', '),
      [b.city, b.postal_code].filter(Boolean).join(' '),
    ].filter(Boolean).join(' · ');
    const total = b.estimated_price_cents != null
      ? '$' + Math.round(b.estimated_price_cents / 100)
      : 'Quote on request';
    const phoneLink = b.customer_phone ? `<a href="tel:${escapeHtml(b.customer_phone.replace(/[^\d+]/g, ''))}" style="color:var(--sage)">${escapeHtml(b.customer_phone)}</a>` : '';
    const emailLink = b.customer_email ? `<a href="mailto:${escapeHtml(b.customer_email)}" style="color:var(--sage)">${escapeHtml(b.customer_email)}</a>` : '';
    const mapsLink = addr ? `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}" target="_blank" rel="noopener" style="color:var(--sage);font-size:12px">🗺 Maps →</a>` : '';
    const notes = b.customer_notes ? `<div style="margin-top:6px;font-size:12px;color:var(--muted);font-style:italic">📝 ${escapeHtml(b.customer_notes)}</div>` : '';
    const internal = (opts.showInternal && b.internal_notes) ? `<div style="margin-top:6px;font-size:12px;color:var(--muted)">🔒 ${escapeHtml(b.internal_notes)}</div>` : '';

    const classes = ['booking-card'];
    if (b.status === 'cancelled' || b.status === 'no_show') classes.push('is-cancelled');
    if (['pending_review', 'awaiting_quote', 'confirmed'].includes(b.status)) classes.push('is-upcoming');

    return `
      <div class="${classes.join(' ')}" data-id="${b.id}">
        <div class="booking-card-head">
          <div>
            <div class="booking-card-svc">${escapeHtml(svc)}</div>
            <div class="booking-card-date">${escapeHtml(dateStr)}${timeStr}</div>
          </div>
          <span class="booking-status ${escapeHtml(b.status || 'pending_review')}">${escapeHtml(statusLabel(b.status))}</span>
        </div>
        <div class="booking-card-body">
          <div>👤 <strong>${escapeHtml(b.customer_name || 'Customer')}</strong></div>
          ${emailLink ? `<div>✉️ ${emailLink}</div>` : ''}
          ${phoneLink ? `<div>📞 ${phoneLink}</div>` : ''}
          ${addr ? `<div>📍 ${escapeHtml(addr)} &nbsp;${mapsLink}</div>` : ''}
          <div><strong>${escapeHtml(total)}</strong> · Ref ${b.id.slice(0, 8).toUpperCase()}</div>
          ${notes}
          ${internal}
        </div>
        ${opts.actions || ''}
      </div>`;
  }

  // ── AUTH GATE ──────────────────────────────────────────────────────────
  let currentUser = null;
  let isOwner = false;

  function isAdminEmail(email) {
    const e = (email || '').toLowerCase();
    return !!e && OWNER_EMAILS.some(x => x.toLowerCase() === e);
  }

  function showView(which) {
    $('gate-login').style.display = which === 'login' ? 'flex' : 'none';
    $('gate-denied').style.display = which === 'denied' ? 'flex' : 'none';
    $('dashboard').style.display = which === 'dashboard' ? 'block' : 'none';
  }

  async function checkAuthAndRoute() {
    if (!sb()) {
      console.error('[Hiraya Admin] Supabase client not ready.');
      showView('login');
      return;
    }
    const { data: { user } } = await sb().auth.getUser();
    currentUser = user;
    if (!user) {
      isOwner = false;
      showView('login');
      return;
    }
    if (!isAdminEmail(user.email)) {
      isOwner = false;
      showView('denied');
      return;
    }
    isOwner = true;
    bootDashboard();
  }

  function showErr(id, msg) {
    const el = $(id);
    if (!el) return;
    el.textContent = msg;
    el.style.display = 'block';
  }
  function hideErr(id) {
    const el = $(id);
    if (el) el.style.display = 'none';
  }

  async function doLogin() {
    if (!sb()) return;
    hideErr('gate-err');
    const email = $('gate-email').value.trim().toLowerCase();
    const pass = $('gate-pass').value;
    if (!email || !pass) {
      showErr('gate-err', 'Please enter your email and password.');
      return;
    }
    const btn = $('gate-submit');
    btn.disabled = true; btn.textContent = 'Signing in…';
    const { error } = await sb().auth.signInWithPassword({ email, password: pass });
    btn.disabled = false; btn.textContent = 'Sign in';
    if (error) {
      showErr('gate-err', error.message || 'Login failed. Check your email and password.');
      return;
    }
    // onAuthStateChange will route us to the dashboard (or denied if not allowlisted)
  }

  async function doLogout() {
    if (!sb()) return;
    await sb().auth.signOut();
    // onAuthStateChange will route us back to login
  }

  // ── DASHBOARD BOOT ─────────────────────────────────────────────────────
  async function bootDashboard() {
    showView('dashboard');
    // Greet the user
    const meta = currentUser.user_metadata || {};
    const fullName = meta.full_name || currentUser.email || '';
    const first = (fullName.split(' ')[0] || fullName).trim();
    $('admin-greet').textContent = currentUser.email;
    $('admin-first-name').textContent = first || 'back';

    // Load initial panel (pending)
    await refreshPending();
    // Load all bookings in the background so the count is ready
    refreshAll();
  }

  // ── PANEL SWITCHING ────────────────────────────────────────────────────
  let activePanel = 'pending';

  function switchPanel(name) {
    activePanel = name;
    document.querySelectorAll('.admin-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.panel === name);
    });
    document.querySelectorAll('.admin-panel').forEach(p => {
      p.classList.toggle('active', p.id === 'panel-' + name);
    });
    // Always return to list view on tab switch
    if (name === 'pending') {
      $('pending-list-view').style.display = 'block';
      $('confirm-view').style.display = 'none';
      $('decline-view').style.display = 'none';
      refreshPending();
    } else if (name === 'all') {
      $('all-list-view').style.display = 'block';
      $('owner-cancel-view').style.display = 'none';
      refreshAll();
    } else if (name === 'calendar') {
      // Re-render off whatever data we already have, then refresh in the
      // background so stale data doesn't make the user wait.
      renderCalendar();
      refreshAll();
    }
  }

  // ── PENDING ────────────────────────────────────────────────────────────
  let pendingBookings = [];

  async function refreshPending() {
    if (!sb() || !isOwner) return;
    const { data, error } = await sb().rpc('get_pending_bookings');
    if (error) {
      console.warn('get_pending_bookings failed:', error.message);
      pendingBookings = [];
    } else {
      pendingBookings = data || [];
    }
    renderPending();
  }

  function renderPending() {
    const list = $('pending-list');
    const empty = $('pending-empty');
    const tabCount = $('tab-count-pending');
    const statPending = $('stat-pending');
    if (tabCount) tabCount.textContent = pendingBookings.length;
    if (statPending) statPending.textContent = pendingBookings.length;
    if (!list) return;

    if (!pendingBookings.length) {
      list.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    list.innerHTML = pendingBookings.map(b => bookingCardHtml(b, {
      actions: `
        <div class="booking-card-actions">
          <button class="booking-card-btn" style="color:var(--rose)" onclick="HirayaAdmin.askDecline('${b.id}')">Decline</button>
          <button class="booking-card-btn" style="background:var(--sage);color:white" onclick="HirayaAdmin.askConfirm('${b.id}')">Confirm</button>
        </div>`
    })).join('');
  }

  // ── ALL BOOKINGS ───────────────────────────────────────────────────────
  let allBookings = [];

  async function refreshAll() {
    if (!sb() || !isOwner) return;
    const { data, error } = await sb().rpc('get_all_bookings');
    if (error) {
      console.warn('get_all_bookings failed:', error.message);
      allBookings = [];
    } else {
      allBookings = data || [];
    }
    renderAll();
  }

  // ── STATS ──────────────────────────────────────────────────────────────
  // Build the Mon-Sun window (local time) anchored to today, so "this week"
  // matches what Aaron sees on his phone calendar.
  function currentWeekRange() {
    const now = new Date();
    const dow = now.getDay(); // 0=Sun … 6=Sat
    const daysSinceMonday = (dow + 6) % 7;
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceMonday);
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
    // Return YYYY-MM-DD strings to compare against preferred_date directly.
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { start: fmt(monday), end: fmt(sunday) };
  }

  function currentMonthRange() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { start: fmt(start), end: fmt(end), label: now.toLocaleDateString(undefined, { month: 'long' }) };
  }

  const ACTIVE_STATUSES = ['pending_review', 'awaiting_quote', 'confirmed', 'in_progress', 'completed'];

  function renderStats() {
    const statConfirmed = $('stat-confirmed');
    const statWeek = $('stat-week');
    const statWeekSub = $('stat-week-sub');
    const statRevenue = $('stat-revenue');
    const statRevenueSub = $('stat-revenue-sub');

    if (statConfirmed) {
      const upcoming = allBookings.filter(b => b.status === 'confirmed' || b.status === 'in_progress').length;
      statConfirmed.textContent = upcoming;
    }

    if (statWeek) {
      const { start, end } = currentWeekRange();
      const inWeek = allBookings.filter(b =>
        b.preferred_date && b.preferred_date >= start && b.preferred_date <= end &&
        ACTIVE_STATUSES.includes(b.status)
      );
      statWeek.textContent = inWeek.length;
      if (statWeekSub) {
        const confirmedInWeek = inWeek.filter(b => b.status === 'confirmed' || b.status === 'in_progress' || b.status === 'completed').length;
        statWeekSub.textContent = inWeek.length === 0
          ? 'No cleans scheduled'
          : `${confirmedInWeek} confirmed · ${inWeek.length - confirmedInWeek} pending`;
      }
    }

    if (statRevenue) {
      const { start, end, label } = currentMonthRange();
      const monthBookings = allBookings.filter(b =>
        b.preferred_date && b.preferred_date >= start && b.preferred_date <= end &&
        ACTIVE_STATUSES.includes(b.status)
      );
      // Prefer final_price_cents when set (post-job actuals), fall back to estimate.
      const cents = monthBookings.reduce((sum, b) => sum + (b.final_price_cents ?? b.estimated_price_cents ?? 0), 0);
      statRevenue.textContent = '$' + Math.round(cents / 100).toLocaleString();
      if (statRevenueSub) {
        statRevenueSub.textContent = `${label} · ${monthBookings.length} ${monthBookings.length === 1 ? 'booking' : 'bookings'}`;
      }
    }
  }

  function renderAll() {
    const list = $('all-list');
    const empty = $('all-empty');
    if (!list) return;

    renderStats();
    renderCalendar();

    const filter = ($('all-status-filter')?.value || '').trim();
    const rows = filter ? allBookings.filter(b => b.status === filter) : allBookings;

    if (!rows.length) {
      list.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    list.innerHTML = rows.map(b => {
      const ownerCancellable = ['confirmed', 'in_progress'].includes(b.status);
      const actions = ownerCancellable
        ? `<div class="booking-card-actions"><button class="booking-card-btn" style="color:var(--rose)" onclick="HirayaAdmin.askOwnerCancel('${b.id}')">Cancel booking</button></div>`
        : '';
      return bookingCardHtml(b, { actions, showInternal: true });
    }).join('');
  }

  // ── CALENDAR ───────────────────────────────────────────────────────────
  // Anchor date for the visible month. We don't keep a separate selected
  // day — clicking a day temporarily highlights it and opens the drawer,
  // but switching months clears the selection.
  let calAnchor = new Date();
  let calSelected = null; // YYYY-MM-DD or null

  function ymd(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function calPrev() { calAnchor = new Date(calAnchor.getFullYear(), calAnchor.getMonth() - 1, 1); renderCalendar(); }
  function calNext() { calAnchor = new Date(calAnchor.getFullYear(), calAnchor.getMonth() + 1, 1); renderCalendar(); }
  function calToday() { calAnchor = new Date(); calSelected = ymd(new Date()); renderCalendar(); openDayDetail(calSelected); }

  function bookingsByDate() {
    const map = new Map();
    for (const b of allBookings) {
      if (!b.preferred_date) continue;
      if (!map.has(b.preferred_date)) map.set(b.preferred_date, []);
      map.get(b.preferred_date).push(b);
    }
    // Sort each day by time slot for predictable display.
    for (const arr of map.values()) {
      arr.sort((a, b) => (a.preferred_time_slot || '').localeCompare(b.preferred_time_slot || ''));
    }
    return map;
  }

  function calEventLabel(b) {
    const time = b.preferred_time_slot ? b.preferred_time_slot : '';
    const who = (b.customer_name || 'Customer').split(' ')[0];
    return time ? `${time} · ${who}` : who;
  }

  function renderCalendar() {
    const titleEl = $('cal-title');
    const grid = $('cal-grid');
    const agenda = $('cal-agenda');
    if (!grid || !titleEl) return;

    const year = calAnchor.getFullYear();
    const month = calAnchor.getMonth();
    titleEl.textContent = calAnchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

    const todayStr = ymd(new Date());
    const byDate = bookingsByDate();

    // First cell is the Monday on/before the 1st of the month.
    const first = new Date(year, month, 1);
    const dow = first.getDay();
    const offset = (dow + 6) % 7;
    const gridStart = new Date(year, month, 1 - offset);

    // Render 6 weeks (42 cells) to keep the grid height stable.
    const cells = [];
    const agendaItems = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      const key = ymd(d);
      const inMonth = d.getMonth() === month;
      const isToday = key === todayStr;
      const isSelected = key === calSelected;
      const events = byDate.get(key) || [];

      const eventHtml = events.slice(0, 3).map(b =>
        `<div class="cal-event ${escapeHtml(b.status)}" title="${escapeHtml(b.customer_name || 'Customer')} — ${escapeHtml(statusLabel(b.status))}">${escapeHtml(calEventLabel(b))}</div>`
      ).join('');
      const overflow = events.length > 3 ? `<div class="cal-overflow">+ ${events.length - 3} more</div>` : '';

      const classes = ['cal-cell'];
      if (!inMonth) classes.push('is-outside');
      if (isToday) classes.push('is-today');
      if (isSelected) classes.push('is-selected');
      if (events.length) classes.push('has-events');

      const click = events.length ? `onclick="HirayaAdmin.openDayDetail('${key}')"` : '';

      cells.push(`
        <div class="${classes.join(' ')}" ${click} data-date="${key}">
          <div class="cal-cell-date">${d.getDate()}</div>
          <div class="cal-events">${eventHtml}${overflow}</div>
        </div>
      `);

      // Agenda: only days in the current month, only days with events
      if (inMonth && events.length) {
        agendaItems.push(`
          <div class="cal-agenda-day ${isToday ? 'is-today' : ''}" onclick="HirayaAdmin.openDayDetail('${key}')">
            <div class="cal-agenda-date">${escapeHtml(d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }))}${isToday ? ' · Today' : ''}</div>
            ${events.map(b => `<div class="cal-event ${escapeHtml(b.status)}">${escapeHtml(calEventLabel(b))} — ${escapeHtml(statusLabel(b.status))}</div>`).join('')}
          </div>
        `);
      }
    }

    grid.innerHTML = cells.join('');
    if (agenda) {
      agenda.innerHTML = agendaItems.length
        ? agendaItems.join('')
        : `<div class="cal-agenda-empty">No cleans scheduled in ${escapeHtml(calAnchor.toLocaleDateString(undefined, { month: 'long' }))}.</div>`;
    }
  }

  function openDayDetail(dateStr) {
    calSelected = dateStr;
    // Update grid highlight without a full re-render
    document.querySelectorAll('#cal-grid .cal-cell').forEach(el => {
      el.classList.toggle('is-selected', el.dataset.date === dateStr);
    });

    const events = (bookingsByDate().get(dateStr) || []);
    const drawer = $('cal-day-detail');
    const list = $('cal-day-detail-list');
    const title = $('cal-day-detail-title');
    if (!drawer || !list || !title) return;

    const d = new Date(dateStr + 'T12:00:00');
    title.textContent = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    if (!events.length) {
      list.innerHTML = `<div class="empty-state">No bookings on this day.</div>`;
    } else {
      list.innerHTML = events.map(b => {
        const ownerCancellable = ['confirmed', 'in_progress'].includes(b.status);
        const isPending = b.status === 'pending_review' || b.status === 'awaiting_quote';
        let actions = '';
        if (isPending) {
          actions = `
            <div class="booking-card-actions">
              <button class="booking-card-btn" style="color:var(--rose)" onclick="HirayaAdmin.jumpToPending('${b.id}','decline')">Decline</button>
              <button class="booking-card-btn" style="background:var(--sage);color:white" onclick="HirayaAdmin.jumpToPending('${b.id}','confirm')">Confirm</button>
            </div>`;
        } else if (ownerCancellable) {
          actions = `<div class="booking-card-actions"><button class="booking-card-btn" style="color:var(--rose)" onclick="HirayaAdmin.jumpToAllAndCancel('${b.id}')">Cancel booking</button></div>`;
        }
        return bookingCardHtml(b, { actions, showInternal: true });
      }).join('');
    }
    drawer.style.display = 'block';
    drawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function closeDayDetail() {
    calSelected = null;
    document.querySelectorAll('#cal-grid .cal-cell.is-selected').forEach(el => el.classList.remove('is-selected'));
    const drawer = $('cal-day-detail');
    if (drawer) drawer.style.display = 'none';
  }

  // Bridge from a calendar event card to the pending panel's confirm/decline
  // overlay. switchPanel runs first (it resets that panel's view state),
  // then we open the overlay on top.
  function jumpToPending(id, action) {
    switchPanel('pending');
    // Defer one tick so refreshPending has a moment to populate pendingBookings
    // if it raced ahead of the click. The data is usually already loaded, but
    // this avoids a "booking not found" miss right after a status changes.
    setTimeout(() => {
      if (action === 'confirm') askConfirm(id);
      else if (action === 'decline') askDecline(id);
    }, 0);
  }
  function jumpToAllAndCancel(id) {
    switchPanel('all');
    setTimeout(() => askOwnerCancel(id), 0);
  }

  // ── CONFIRM (pending → confirmed) ──────────────────────────────────────
  let confirmingId = null;

  function askConfirm(id) {
    const b = pendingBookings.find(x => x.id === id);
    if (!b) return;
    confirmingId = id;
    $('confirm-text').textContent =
      `${b.service_name || 'this booking'} on ${formatBookingDate(b.preferred_date)} (${b.customer_name || 'Customer'})`;
    $('pending-list-view').style.display = 'none';
    $('confirm-view').style.display = 'block';
    $('decline-view').style.display = 'none';
  }

  function cancelConfirm() {
    confirmingId = null;
    $('confirm-view').style.display = 'none';
    $('pending-list-view').style.display = 'block';
  }

  async function submitConfirm() {
    if (!confirmingId || !sb()) return;
    const id = confirmingId;
    const btn = $('confirm-btn');
    btn.disabled = true; btn.textContent = 'Confirming…';
    try {
      const { data, error } = await sb().rpc('confirm_booking', { booking_id: id });
      if (error) throw error;
      if (data === false) {
        showToast('Booking already confirmed or no longer pending.', 'error');
      } else {
        showToast('Booking confirmed. Customer notified.', 'success');
        // Fire-and-forget email
        sb().functions.invoke('send-booking-email', { body: { booking_id: id, mode: 'confirmed' } })
          .then(({ error: e }) => { if (e) console.warn('confirmation email failed:', e.message || e); })
          .catch(err => console.warn('confirmation email failed:', err));
      }
      confirmingId = null;
      await refreshPending();
      refreshAll();
      cancelConfirm();
    } catch (err) {
      console.error('confirm_booking failed:', err);
      showToast(err.message || 'Could not confirm.', 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Yes, confirm';
    }
  }

  // ── DECLINE (pending → cancelled with reason) ──────────────────────────
  let decliningId = null;

  function askDecline(id) {
    const b = pendingBookings.find(x => x.id === id);
    if (!b) return;
    decliningId = id;
    $('decline-text').textContent =
      `${b.service_name || 'this booking'} on ${formatBookingDate(b.preferred_date)} (${b.customer_name || 'Customer'})`;
    $('decline-reason').value = '';
    hideErr('decline-err');
    $('pending-list-view').style.display = 'none';
    $('decline-view').style.display = 'block';
    $('confirm-view').style.display = 'none';
  }

  function cancelDecline() {
    decliningId = null;
    $('decline-view').style.display = 'none';
    $('pending-list-view').style.display = 'block';
  }

  async function submitDecline() {
    if (!decliningId || !sb()) return;
    const id = decliningId;
    const reason = ($('decline-reason').value || '').trim();
    const btn = $('decline-btn');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const { data, error } = await sb().rpc('decline_booking', { booking_id: id, reason: reason || null });
      if (error) throw error;
      if (data === false) {
        showErr('decline-err', 'Booking is no longer pending — refresh and try again.');
      } else {
        showToast('Booking declined. Customer notified.', 'success');
        sb().functions.invoke('send-booking-email', { body: { booking_id: id, mode: 'declined', reason: reason || null } })
          .then(({ error: e }) => { if (e) console.warn('decline email failed:', e.message || e); })
          .catch(err => console.warn('decline email failed:', err));
        decliningId = null;
        await refreshPending();
        refreshAll();
        cancelDecline();
      }
    } catch (err) {
      console.error('decline_booking failed:', err);
      showErr('decline-err', err.message || 'Could not decline.');
    } finally {
      btn.disabled = false; btn.textContent = 'Send decline';
    }
  }

  // ── OWNER CANCEL (confirmed/in_progress → cancelled) ───────────────────
  let ownerCancellingId = null;

  function askOwnerCancel(id) {
    const b = allBookings.find(x => x.id === id);
    if (!b) return;
    ownerCancellingId = id;
    $('owner-cancel-text').textContent =
      `${b.service_name || 'this booking'} on ${formatBookingDate(b.preferred_date)} (${b.customer_name || 'Customer'})`;
    $('owner-cancel-reason').value = '';
    hideErr('owner-cancel-err');
    $('all-list-view').style.display = 'none';
    $('owner-cancel-view').style.display = 'block';
  }

  function cancelOwnerCancel() {
    ownerCancellingId = null;
    $('owner-cancel-view').style.display = 'none';
    $('all-list-view').style.display = 'block';
  }

  async function submitOwnerCancel() {
    if (!ownerCancellingId || !sb()) return;
    const id = ownerCancellingId;
    const reason = ($('owner-cancel-reason').value || '').trim();
    const btn = $('owner-cancel-btn');
    btn.disabled = true; btn.textContent = 'Cancelling…';
    try {
      const { data, error } = await sb().rpc('owner_cancel_booking', { booking_id: id, reason: reason || null });
      if (error) throw error;
      if (data === false) {
        showErr('owner-cancel-err', 'Booking can no longer be cancelled — refresh and try again.');
      } else {
        showToast('Booking cancelled. Customer notified.', 'success');
        // Reuse 'cancelled' mode — its wording works for either side and the edge function tears down the Google Calendar event.
        sb().functions.invoke('send-booking-email', { body: { booking_id: id, mode: 'cancelled' } })
          .then(({ error: e }) => { if (e) console.warn('owner-cancel email failed:', e.message || e); })
          .catch(err => console.warn('owner-cancel email failed:', err));
        ownerCancellingId = null;
        await refreshAll();
        refreshPending();
        cancelOwnerCancel();
      }
    } catch (err) {
      console.error('owner_cancel_booking failed:', err);
      showErr('owner-cancel-err', err.message || 'Could not cancel.');
    } finally {
      btn.disabled = false; btn.textContent = 'Yes, cancel booking';
    }
  }

  // ── INIT ───────────────────────────────────────────────────────────────
  function wire() {
    if (!sb()) {
      console.error('[Hiraya Admin] Supabase client failed to initialize.');
      showView('login');
      return;
    }

    // Enter key submits the login form
    ['gate-email', 'gate-pass'].forEach(id => {
      const el = $(id);
      if (el) el.addEventListener('keydown', e => {
        if (e.key === 'Enter') doLogin();
      });
    });

    // React to login / logout from any tab
    sb().auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED' || event === 'INITIAL_SESSION') {
        checkAuthAndRoute();
      } else if (event === 'SIGNED_OUT') {
        currentUser = null;
        isOwner = false;
        showView('login');
      }
    });

    // Initial route — onAuthStateChange's INITIAL_SESSION fires too, but we
    // call this explicitly so the gate flashes the right view immediately
    // instead of waiting for the event loop.
    checkAuthAndRoute();
  }

  // ── EXPORTS ────────────────────────────────────────────────────────────
  window.HirayaAdmin = {
    doLogin,
    doLogout,
    switchPanel,
    refreshPending,
    refreshAll,
    renderAll,
    askConfirm,
    cancelConfirm,
    submitConfirm,
    askDecline,
    cancelDecline,
    submitDecline,
    askOwnerCancel,
    cancelOwnerCancel,
    submitOwnerCancel,
    // Calendar
    calPrev,
    calNext,
    calToday,
    openDayDetail,
    closeDayDetail,
    jumpToPending,
    jumpToAllAndCancel,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
