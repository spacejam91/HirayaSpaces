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
    // service_name from get_all_bookings is the joined string like
    // "Regular Cleaning — 2BR/2BA · Carpet — Living room". Split it so
    // multi-service bookings show one line per service for readability.
    const rawSvc = b.service_name || 'Cleaning service';
    const svcParts = rawSvc.split(' · ');
    const svc = svcParts.length > 1
      ? svcParts.map(s => `<div>${escapeHtml(s)}</div>`).join('')
      : escapeHtml(rawSvc);
    const dateStr = formatBookingDate(b.preferred_date);
    const timeStr = b.preferred_time_slot ? ` at ${escapeHtml(b.preferred_time_slot)}` : '';
    const addr = [
      [b.street_address, b.unit].filter(Boolean).join(', '),
      [b.city, b.postal_code].filter(Boolean).join(' '),
    ].filter(Boolean).join(' · ');
    // Prefer the final/charged price once a booking is completed, otherwise
    // show the estimate. final_price_cents only gets set on Mark complete.
    const priceCents = b.final_price_cents ?? b.estimated_price_cents;
    const total = priceCents != null
      ? '$' + Math.round(priceCents / 100)
      : 'Quote on request';
    const phoneLink = b.customer_phone ? `<a href="tel:${escapeHtml(b.customer_phone.replace(/[^\d+]/g, ''))}" style="color:var(--sage)">${escapeHtml(b.customer_phone)}</a>` : '';
    const emailLink = b.customer_email ? `<a href="mailto:${escapeHtml(b.customer_email)}" style="color:var(--sage)">${escapeHtml(b.customer_email)}</a>` : '';
    const mapsLink = addr ? `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}" target="_blank" rel="noopener" style="color:var(--sage);font-size:12px">🗺 Maps →</a>` : '';
    const notes = b.customer_notes ? `<div style="margin-top:6px;font-size:12px;color:var(--muted);font-style:italic">📝 ${escapeHtml(b.customer_notes)}</div>` : '';
    const internal = (opts.showInternal && b.internal_notes) ? `<div style="margin-top:6px;font-size:12px;color:var(--muted)">🔒 ${escapeHtml(b.internal_notes)}</div>` : '';

    // Entry method — show it inline. Only "home" stays terse since it's the
    // common case; the others need the instructions text to be useful.
    const entryLabels = { home: "Customer will be home", lockbox: '🔐 Lockbox', hidden_key: '🗝 Hidden key', fob: '🏢 Building fob/code', concierge: '🛎 Concierge', other: '📋 Other' };
    let entryLine = '';
    if (b.entry_method && b.entry_method !== 'home') {
      const label = entryLabels[b.entry_method] || '📋 Other';
      const instr = b.entry_instructions ? `: ${b.entry_instructions}` : '';
      entryLine = `<div style="margin-top:6px;font-size:12px;color:var(--text);background:#fffbeb;padding:6px 10px;border-radius:8px;border-left:3px solid #b08c4a">${escapeHtml(label)}${escapeHtml(instr)}</div>`;
    } else if (b.entry_method === 'home') {
      entryLine = `<div style="margin-top:4px;font-size:11px;color:var(--muted)">🏠 Customer will be home</div>`;
    }

    // Recurring frequency badge — visible when not a one-time booking.
    const freqLabels = { weekly: 'Weekly · 20% off', biweekly: 'Every 2 weeks · 15% off', monthly: 'Monthly · 10% off' };
    const freqBadge = (b.frequency && b.frequency !== 'one_time' && freqLabels[b.frequency])
      ? `<span style="display:inline-block;font-size:10px;font-weight:600;letter-spacing:0.5px;background:var(--sage-light);color:var(--sage);padding:2px 8px;border-radius:10px;margin-left:6px">↻ ${escapeHtml(freqLabels[b.frequency])}</span>`
      : '';

    // Check-in / check-out timeline — shows what actually happened on site.
    let timeLine = '';
    if (b.check_in_at || b.check_out_at) {
      const inT = b.check_in_at ? timeOnly(b.check_in_at) : '—';
      const outT = b.check_out_at ? timeOnly(b.check_out_at) : '—';
      let duration = '';
      if (b.check_in_at && b.check_out_at) {
        const mins = Math.round((new Date(b.check_out_at) - new Date(b.check_in_at)) / 60000);
        duration = ` · <strong>${formatDuration(mins)}</strong>`;
      }
      timeLine = `<div style="margin-top:6px;font-size:12px;color:#2b5a73;background:#e0eef7;padding:4px 10px;border-radius:8px;border-left:3px solid #3b82a8">⏱ ${inT} → ${outT}${duration}</div>`;
    }

    const classes = ['booking-card'];
    if (b.status === 'cancelled' || b.status === 'no_show') classes.push('is-cancelled');
    if (['pending_review', 'awaiting_quote', 'confirmed'].includes(b.status)) classes.push('is-upcoming');

    const detailLink = `<button type="button" class="booking-card-detail-link" onclick="event.stopPropagation(); HirayaAdmin.openBookingDetail('${b.id}')">Tap for full details →</button>`;
    return `
      <div class="${classes.join(' ')}" data-id="${b.id}" onclick="HirayaAdmin.openBookingDetail('${b.id}', event)">
        <div class="booking-card-head">
          <div>
            <div class="booking-card-date">${escapeHtml(dateStr)}${timeStr}</div>
            <div class="booking-card-svc">${svc}${freqBadge}</div>
            ${(b.addon_names && b.addon_names.length) ? `<div class="booking-card-addons">✨ ${escapeHtml(b.addon_names.join(' · '))}</div>` : ''}
            <span class="booking-status ${escapeHtml(b.status || 'pending_review')}">${escapeHtml(statusLabel(b.status))}</span>
          </div>
        </div>
        <div class="booking-card-body">
          <div>👤 <strong>${escapeHtml(b.customer_name || 'Customer')}</strong></div>
          ${emailLink ? `<div>✉️ ${emailLink}</div>` : ''}
          ${phoneLink ? `<div>📞 ${phoneLink}</div>` : ''}
          ${addr ? `<div>📍 ${escapeHtml(addr)} &nbsp;${mapsLink}</div>` : ''}
          ${entryLine}
          ${timeLine}
          ${notes}
          ${internal}
          <div><strong>${escapeHtml(total)}</strong> · Ref ${b.id.slice(0, 8).toUpperCase()}</div>
        </div>
        ${detailLink}
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

    // Realtime subscription auto-refreshes the dashboard when new bookings
    // land. Browser-notification toggle was removed — email is the alert.
    startBookingsRealtime();

    // Load initial panel (pending) + services list for the new-booking form
    await refreshPending();
    // Load all bookings in the background so the count is ready
    refreshAll();
    loadServicesCache();
  }

  // ── PANEL SWITCHING ────────────────────────────────────────────────────
  let activePanel = 'pending';

  // Tabs that share the All-Bookings panel DOM but pre-apply a status filter.
  const PANEL_ALIAS = { confirmed: 'all', in_progress: 'all', completed: 'all' };

  function switchPanel(name) {
    activePanel = name;
    document.querySelectorAll('.admin-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.panel === name);
    });
    const panelId = PANEL_ALIAS[name] || name;
    document.querySelectorAll('.admin-panel').forEach(p => {
      p.classList.toggle('active', p.id === 'panel-' + panelId);
    });
    // Always return to list view on tab switch
    if (name === 'pending') {
      $('pending-list-view').style.display = 'block';
      $('confirm-view').style.display = 'none';
      $('decline-view').style.display = 'none';
      // Edit modal lives at top level now — closes on cancel, not on tab switch.
      refreshPending();
    } else if (name === 'all' || name === 'confirmed' || name === 'in_progress' || name === 'completed' || name === 'cancelled') {
      $('all-list-view').style.display = 'block';
      $('owner-cancel-view').style.display = 'none';
      const completeView = $('complete-view');
      if (completeView) completeView.style.display = 'none';
      const rescheduleView = $('reschedule-view');
      if (rescheduleView) rescheduleView.style.display = 'none';
      // Edit modal lives at top level now — closes on cancel, not on tab switch.
      // Pre-apply the status filter so each tab shows its slice. The All
      // bookings tab resets to "no filter".
      const filterSel = $('all-status-filter');
      if (filterSel) {
        if (name === 'confirmed') filterSel.value = 'confirmed';
        else if (name === 'in_progress') filterSel.value = 'in_progress';
        else if (name === 'completed') filterSel.value = 'completed';
        else if (name === 'cancelled') filterSel.value = 'cancelled';
        else filterSel.value = '';
      }
      // Update the panel heading so the customer knows which view they're on.
      const titleEl = document.querySelector('#all-list-view .panel-header h2');
      if (titleEl) {
        titleEl.textContent = name === 'confirmed' ? 'Confirmed bookings'
          : name === 'in_progress' ? 'In-progress bookings'
          : name === 'completed' ? 'Completed bookings'
          : name === 'cancelled' ? 'Cancelled bookings'
          : 'All bookings';
      }
      refreshAll();
    } else if (name === 'calendar') {
      // Re-render off whatever data we already have, then refresh in the
      // background so stale data doesn't make the user wait.
      renderCalendar();
      refreshAll();
    } else if (name === 'customers') {
      // Always return to the list view when entering the tab — closing a
      // detail drawer by switching tabs is the natural reset.
      $('customers-list-view').style.display = 'block';
      $('customer-detail-view').style.display = 'none';
      renderCustomers();
      refreshAll();
    }
  }

  // ── PENDING ────────────────────────────────────────────────────────────
  let pendingBookings = [];

  async function refreshPending() {
    if (!sb() || !isOwner) return;
    await loadAddonsCache();
    const { data, error } = await sb().rpc('get_pending_bookings');
    if (error) {
      console.warn('get_pending_bookings failed:', error.message);
      pendingBookings = [];
    } else {
      pendingBookings = data || [];
    }
    await attachAddonsToBookings(pendingBookings);
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
          <button class="booking-card-btn" onclick="event.stopPropagation(); HirayaAdmin.askEdit('${b.id}')">Edit</button>
          <button class="booking-card-btn" style="background:var(--sage);color:white" onclick="event.stopPropagation(); HirayaAdmin.askConfirm('${b.id}')">Confirm</button>
          <button class="booking-card-btn" style="background:#c0392b;color:white;border-color:#c0392b" onclick="event.stopPropagation(); HirayaAdmin.askDecline('${b.id}')">Decline</button>
        </div>`
    })).join('');
  }

  // ── ALL BOOKINGS ───────────────────────────────────────────────────────
  let allBookings = [];

  async function refreshAll() {
    if (!sb() || !isOwner) return;
    // Bookings + blocked dates + customer meta + customer roster in parallel.
    const [bookingsRes] = await Promise.all([
      sb().rpc('get_all_bookings'),
      refreshBlockedDates(),
      refreshCustomerMeta(),
      refreshCustomerRoster(),
      loadAddonsCache(),
    ]);
    const { data, error } = bookingsRes;
    if (error) {
      console.warn('get_all_bookings failed:', error.message);
      allBookings = [];
    } else {
      allBookings = data || [];
    }
    // Attach add-on names to each booking so the card can list them inline.
    await attachAddonsToBookings(allBookings);
    renderAll();
  }

  async function attachAddonsToBookings(bookings) {
    if (!bookings || !bookings.length || !sb()) return;
    const ids = bookings.map(b => b.id);
    const { data, error } = await sb()
      .from('booking_addons')
      .select('booking_id, addon_id')
      .in('booking_id', ids);
    if (error) {
      console.warn('booking_addons fetch failed:', error.message);
      return;
    }
    const addonNameById = new Map(addonsCache.map(a => [a.id, a.name]));
    const byBooking = new Map();
    (data || []).forEach(row => {
      const name = addonNameById.get(row.addon_id);
      if (!name) return;
      if (!byBooking.has(row.booking_id)) byBooking.set(row.booking_id, []);
      byBooking.get(row.booking_id).push(name);
    });
    bookings.forEach(b => { b.addon_names = byBooking.get(b.id) || []; });
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

  function currentYearRange() {
    const now = new Date();
    return {
      start: `${now.getFullYear()}-01-01`,
      end: `${now.getFullYear()}-12-31`,
      label: String(now.getFullYear()),
    };
  }

  const ACTIVE_STATUSES = ['pending_review', 'awaiting_quote', 'confirmed', 'in_progress', 'completed'];
  // For revenue calculations, "earned" = job is done. Confirmed isn't earned yet.
  const EARNED_STATUSES = ['completed'];
  const PIPELINE_STATUSES = ['confirmed', 'in_progress'];
  const bookingPrice = b => (b.final_price_cents ?? b.estimated_price_cents ?? 0);

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
      // MTD revenue counts only completed jobs. Pipeline (still confirmed)
      // is broken out separately so Aaron sees earned vs expected at a glance.
      const earnedThisMonth = allBookings.filter(b =>
        b.preferred_date && b.preferred_date >= start && b.preferred_date <= end &&
        EARNED_STATUSES.includes(b.status)
      );
      const cents = earnedThisMonth.reduce((sum, b) => sum + bookingPrice(b), 0);
      statRevenue.textContent = '$' + Math.round(cents / 100).toLocaleString();
      if (statRevenueSub) {
        statRevenueSub.textContent = `${label} · ${earnedThisMonth.length} completed`;
      }
    }

    const statRevenueYtd = $('stat-revenue-ytd');
    const statRevenueYtdSub = $('stat-revenue-ytd-sub');
    if (statRevenueYtd) {
      const { start, end, label } = currentYearRange();
      const earnedYtd = allBookings.filter(b =>
        b.preferred_date && b.preferred_date >= start && b.preferred_date <= end &&
        EARNED_STATUSES.includes(b.status)
      );
      const cents = earnedYtd.reduce((sum, b) => sum + bookingPrice(b), 0);
      statRevenueYtd.textContent = '$' + Math.round(cents / 100).toLocaleString();
      if (statRevenueYtdSub) {
        statRevenueYtdSub.textContent = `${label} · ${earnedYtd.length} completed`;
      }
    }

    const statPipeline = $('stat-pipeline');
    const statPipelineSub = $('stat-pipeline-sub');
    if (statPipeline) {
      // Pipeline = booked-but-not-yet-done. Uses estimate since these haven't
      // been completed yet (final_price_cents won't be set).
      const pipeline = allBookings.filter(b => PIPELINE_STATUSES.includes(b.status));
      const cents = pipeline.reduce((sum, b) => sum + (b.estimated_price_cents ?? 0), 0);
      statPipeline.textContent = '$' + Math.round(cents / 100).toLocaleString();
      if (statPipelineSub) {
        statPipelineSub.textContent = pipeline.length === 0
          ? 'Nothing booked yet'
          : `${pipeline.length} booking${pipeline.length === 1 ? '' : 's'} to deliver`;
      }
    }

    // Tab count chips for Confirmed / In progress / Completed.
    const tabConfirmed = $('tab-count-confirmed');
    if (tabConfirmed) {
      tabConfirmed.textContent = allBookings.filter(b => b.status === 'confirmed').length;
    }
    const tabInProgress = $('tab-count-in_progress');
    if (tabInProgress) {
      tabInProgress.textContent = allBookings.filter(b => b.status === 'in_progress').length;
    }
    const tabCompleted = $('tab-count-completed');
    if (tabCompleted) {
      tabCompleted.textContent = allBookings.filter(b => b.status === 'completed').length;
    }
    const tabCancelled = $('tab-count-cancelled');
    if (tabCancelled) {
      tabCancelled.textContent = allBookings.filter(b => b.status === 'cancelled').length;
    }
  }

  function renderAll() {
    const list = $('all-list');
    const empty = $('all-empty');
    if (!list) return;

    renderStats();
    renderCalendar();
    // Only re-render customers if the panel is actually visible — avoids
    // a flicker when refreshAll runs from other tabs.
    if (activePanel === 'customers') renderCustomers();

    const filter = ($('all-status-filter')?.value || '').trim();
    const sortDir = ($('all-sort')?.value || 'newest');
    const filtered = filter ? allBookings.filter(b => b.status === filter) : allBookings.slice();
    const rows = filtered.sort((a, b) => {
      const da = new Date(a.preferred_date || a.created_at || 0).getTime();
      const db = new Date(b.preferred_date || b.created_at || 0).getTime();
      return sortDir === 'oldest' ? da - db : db - da;
    });

    if (!rows.length) {
      list.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    list.innerHTML = rows.map(b => {
      const reschedulable = ['pending_review', 'awaiting_quote', 'confirmed', 'in_progress'].includes(b.status);
      const editable = ['pending_review', 'awaiting_quote', 'confirmed', 'in_progress'].includes(b.status);
      const ownerCancellable = ['confirmed', 'in_progress'].includes(b.status);
      const completable = ['confirmed', 'in_progress'].includes(b.status);
      const canCheckIn = b.status === 'confirmed' && !b.check_in_at;
      const canCheckOut = b.status === 'in_progress' && b.check_in_at && !b.check_out_at;
      const canInvoice = b.status === 'completed';
      let actions = '';
      if (canCheckIn || canCheckOut || completable || ownerCancellable || reschedulable || canInvoice || editable) {
        const parts = [];
        if (canCheckIn) {
          parts.push(`<button class="booking-card-btn" style="background:#3b82a8;color:white" onclick="HirayaAdmin.checkInBooking('${b.id}')">▶ Check in</button>`);
        }
        if (canCheckOut) {
          parts.push(`<button class="booking-card-btn" style="background:#3b82a8;color:white" onclick="HirayaAdmin.checkOutBooking('${b.id}')">⏹ Check out</button>`);
        }
        if (completable) {
          parts.push(`<button class="booking-card-btn" style="background:var(--sage);color:white" onclick="HirayaAdmin.askComplete('${b.id}')">Mark complete</button>`);
        }
        if (canInvoice) {
          parts.push(`<button class="booking-card-btn" style="background:var(--sage);color:white" onclick="HirayaAdmin.sendInvoice('${b.id}')">Send invoice</button>`);
          parts.push(`<button class="booking-card-btn" onclick="HirayaAdmin.viewInvoice('${b.id}')">View invoice</button>`);
        }
        if (editable) {
          parts.push(`<button class="booking-card-btn" onclick="HirayaAdmin.askEdit('${b.id}')">Edit</button>`);
        }
        if (reschedulable) {
          parts.push(`<button class="booking-card-btn" onclick="HirayaAdmin.askReschedule('${b.id}')">Reschedule</button>`);
        }
        if (ownerCancellable) {
          parts.push(`<button class="booking-card-btn" style="color:var(--rose)" onclick="HirayaAdmin.askOwnerCancel('${b.id}')">Cancel booking</button>`);
        }
        actions = `<div class="booking-card-actions">${parts.join('')}</div>`;
      }
      return bookingCardHtml(b, { actions, showInternal: true });
    }).join('');
  }

  // ── CUSTOMER META (per-customer notes + tags) ──────────────────────────
  let customerMetaMap = new Map(); // user_id → { notes, tags }

  async function refreshCustomerMeta() {
    if (!sb() || !isOwner) { customerMetaMap = new Map(); return; }
    const { data, error } = await sb()
      .from('customer_meta')
      .select('user_id, notes, tags');
    if (error) {
      console.warn('customer_meta fetch failed:', error.message);
      customerMetaMap = new Map();
      return;
    }
    customerMetaMap = new Map((data || []).map(r => [r.user_id, { notes: r.notes || '', tags: r.tags || [] }]));
  }

  async function saveCustomerMeta(userId, notes, tags) {
    if (!sb() || !isOwner) return;
    try {
      const { error } = await sb().rpc('admin_upsert_customer_meta', {
        p_user_id: userId,
        p_notes: notes || null,
        p_tags: tags,
      });
      if (error) throw error;
      customerMetaMap.set(userId, { notes: notes || '', tags });
      showToast('Customer notes saved.', 'success');
      renderCustomers();
    } catch (err) {
      console.error('admin_upsert_customer_meta failed:', err);
      showToast(err.message || 'Could not save.', 'error');
    }
  }

  // ── CUSTOMERS ──────────────────────────────────────────────────────────
  // Group allBookings by user_id into a customer summary. We also seed the
  // map from get_all_customers() so people who signed up but haven't booked
  // yet still appear here.
  const COUNTED_FOR_LTV = ['confirmed', 'in_progress', 'completed'];

  let allCustomers = []; // raw rows from get_all_customers()

  async function refreshCustomerRoster() {
    if (!sb() || !isOwner) { allCustomers = []; return; }
    const { data, error } = await sb().rpc('get_all_customers');
    if (error) {
      console.warn('get_all_customers failed:', error.message);
      allCustomers = [];
      return;
    }
    allCustomers = data || [];
  }

  function aggregateCustomers() {
    const map = new Map();
    // Seed with everyone who has a profile — even no-booking signups.
    for (const u of allCustomers) {
      if (!u.user_id) continue;
      map.set(u.user_id, {
        user_id: u.user_id,
        name: u.full_name || u.email || 'Customer',
        email: u.email || '',
        phone: u.phone || '',
        signup_at: u.created_at || null,
        bookings: [],
        addresses: new Map(),
        ltv_cents: 0,
        first_booking: null,
        last_booking: null,
        status_counts: {},
        avg_ticket_cents: 0,
        earned_count: 0,
        avg_gap_days: null,
      });
    }
    for (const b of allBookings) {
      if (!b.user_id) continue;
      let c = map.get(b.user_id);
      if (!c) {
        c = {
          user_id: b.user_id,
          name: b.customer_name || 'Customer',
          email: b.customer_email || '',
          phone: b.customer_phone || '',
          bookings: [],
          addresses: new Map(),
          ltv_cents: 0,
          first_booking: null,
          last_booking: null,
          status_counts: {},
          // Set in the second pass below — needs the full bookings list.
          avg_ticket_cents: 0,
          earned_count: 0,
          avg_gap_days: null,
        };
        map.set(b.user_id, c);
      }
      c.bookings.push(b);
      if (COUNTED_FOR_LTV.includes(b.status)) {
        c.ltv_cents += (b.final_price_cents ?? b.estimated_price_cents ?? 0);
      }
      // Earliest preferred_date = "member since" (closest to signup we can
      // get without joining auth.users.created_at).
      if (b.preferred_date) {
        if (!c.first_booking || b.preferred_date < c.first_booking) c.first_booking = b.preferred_date;
        if (!c.last_booking || b.preferred_date > c.last_booking) c.last_booking = b.preferred_date;
      }
      c.status_counts[b.status] = (c.status_counts[b.status] || 0) + 1;

      // Dedupe addresses by full string — same person sometimes books from
      // different addresses (home + parents', etc.), and we want to show all.
      if (b.street_address) {
        const key = [b.street_address, b.unit, b.city, b.postal_code].filter(Boolean).join('|');
        if (!c.addresses.has(key)) {
          c.addresses.set(key, {
            street_address: b.street_address,
            unit: b.unit,
            city: b.city,
            postal_code: b.postal_code,
          });
        }
      }
    }

    // Second pass: profitability metrics that need the full per-customer set.
    const todayStr = ymd(new Date());
    const REBOOK_THRESHOLD_DAYS = 30;
    for (const c of map.values()) {
      // Average ticket: divide by earned bookings only, not pending/cancelled.
      const earned = c.bookings.filter(b => EARNED_STATUSES.includes(b.status));
      c.earned_count = earned.length;
      c.avg_ticket_cents = earned.length ? Math.round(c.ltv_cents / earned.length) : 0;

      // Rebook cadence: average days between consecutive completed bookings.
      // Needs at least 2 completed bookings to be meaningful.
      const completedDates = earned
        .filter(b => b.preferred_date)
        .map(b => b.preferred_date)
        .sort();
      if (completedDates.length > 1) {
        const gaps = [];
        for (let i = 1; i < completedDates.length; i++) {
          const prev = new Date(completedDates[i - 1] + 'T12:00:00');
          const curr = new Date(completedDates[i] + 'T12:00:00');
          gaps.push(Math.round((curr - prev) / 86400000));
        }
        c.avg_gap_days = Math.round(gaps.reduce((s, x) => s + x, 0) / gaps.length);
      }

      // Due-for-rebook: customer with completed history but no booking on the
      // books, where the last clean was 30+ days ago. Skipping people with a
      // pending or confirmed booking avoids nudging customers who already
      // have one in flight.
      c.last_completed = completedDates.length ? completedDates[completedDates.length - 1] : null;
      c.has_upcoming = c.bookings.some(b =>
        b.preferred_date && b.preferred_date >= todayStr &&
        ['pending_review', 'awaiting_quote', 'confirmed', 'in_progress'].includes(b.status)
      );
      if (c.last_completed && !c.has_upcoming) {
        const last = new Date(c.last_completed + 'T12:00:00');
        const today = new Date(todayStr + 'T12:00:00');
        c.days_since_last = Math.round((today - last) / 86400000);
        c.due_for_rebook = c.days_since_last >= REBOOK_THRESHOLD_DAYS;
      } else {
        c.days_since_last = null;
        c.due_for_rebook = false;
      }
    }
    return Array.from(map.values());
  }

  function customerInitials(name) {
    const parts = String(name || 'Customer').trim().split(/\s+/);
    const first = parts[0]?.[0] || 'C';
    const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
    return (first + last).toUpperCase();
  }

  function formatLtv(cents) {
    return '$' + Math.round((cents || 0) / 100).toLocaleString();
  }

  function renderCustomers() {
    const list = $('customers-list');
    const empty = $('customers-empty');
    const count = $('customers-count');
    if (!list) return;

    const customers = aggregateCustomers();
    const q = ($('customers-search')?.value || '').trim().toLowerCase();
    const sort = $('customers-sort')?.value || 'recent';

    let rows = customers;
    if (q) {
      rows = rows.filter(c =>
        c.name.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q) ||
        (c.phone && c.phone.toLowerCase().includes(q))
      );
    }

    if (sort === 'due') {
      // Filter to only those due for rebook; sort by oldest-last-clean first
      // so Aaron tackles the coldest customers first.
      rows = rows
        .filter(c => c.due_for_rebook)
        .sort((a, b) => (b.days_since_last || 0) - (a.days_since_last || 0));
    } else {
      rows.sort((a, b) => {
        if (sort === 'value') return b.ltv_cents - a.ltv_cents;
        if (sort === 'count') return b.bookings.length - a.bookings.length;
        if (sort === 'name') return a.name.localeCompare(b.name);
        // recent: by last_booking desc, falling back to bookings array (already newest-first from RPC)
        const la = a.last_booking || '';
        const lb = b.last_booking || '';
        if (la === lb) return 0;
        return la < lb ? 1 : -1;
      });
    }

    if (count) {
      count.textContent = q
        ? `· ${rows.length} of ${customers.length}`
        : `· ${customers.length}`;
    }

    if (!rows.length) {
      list.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    list.innerHTML = rows.map(c => {
      const lastStr = c.last_booking ? formatBookingDate(c.last_booking) : '—';
      const dueBadge = c.due_for_rebook
        ? `<span class="customer-due-badge" title="${c.days_since_last} days since last clean">Due ${c.days_since_last}d</span>`
        : '';
      const meta = customerMetaMap.get(c.user_id);
      const tagChips = (meta?.tags || []).slice(0, 4).map(t =>
        `<span style="display:inline-block;font-size:10px;font-weight:500;background:var(--warm);color:var(--text);padding:2px 7px;border-radius:8px;margin-right:4px">${escapeHtml(t)}</span>`
      ).join('');
      return `
        <div class="customer-card" onclick="HirayaAdmin.openCustomerDetail('${c.user_id}')">
          <div class="customer-card-head">
            <div style="display:flex;gap:12px;align-items:flex-start;min-width:0">
              <div class="customer-avatar">${escapeHtml(customerInitials(c.name))}</div>
              <div style="min-width:0">
                <div class="customer-card-name">${escapeHtml(c.name)}${dueBadge}</div>
                <div class="customer-card-email">${escapeHtml(c.email || 'No email')}</div>
                ${c.phone ? `<div class="customer-card-phone">${escapeHtml(c.phone)}</div>` : ''}
                ${tagChips ? `<div style="margin-top:6px">${tagChips}</div>` : ''}
              </div>
            </div>
          </div>
          <div class="customer-card-body">
            <div>
              <div class="customer-card-stat-label">Bookings</div>
              <div class="customer-card-stat-value">${c.bookings.length}</div>
            </div>
            <div>
              <div class="customer-card-stat-label">Lifetime (est.)</div>
              <div class="customer-card-stat-value">${escapeHtml(formatLtv(c.ltv_cents))}</div>
            </div>
            <div>
              <div class="customer-card-stat-label">Last clean</div>
              <div class="customer-card-stat-value" style="font-size:12px;font-weight:500">${escapeHtml(lastStr)}</div>
            </div>
          </div>
        </div>`;
    }).join('');
  }

  function openCustomerDetail(userId) {
    const customers = aggregateCustomers();
    const c = customers.find(x => x.user_id === userId);
    if (!c) return;

    $('customers-list-view').style.display = 'none';
    $('customer-detail-view').style.display = 'block';

    $('customer-detail-name').textContent = c.name;
    const metaParts = [];
    if (c.email) metaParts.push(`<a href="mailto:${escapeHtml(c.email)}">✉️ ${escapeHtml(c.email)}</a>`);
    if (c.phone) {
      const dialable = c.phone.replace(/[^\d+]/g, '');
      metaParts.push(`<a href="tel:${escapeHtml(dialable)}">📞 ${escapeHtml(c.phone)}</a>`);
    }
    $('customer-detail-meta').innerHTML = metaParts.join('') || '<span>No contact info on file</span>';

    // Rebook nudge banner — only when due (30+ days since last clean, no upcoming).
    const banner = $('customer-nudge-banner');
    const bannerText = $('customer-nudge-text');
    const bannerBtn = $('customer-nudge-btn');
    if (banner && bannerText && bannerBtn) {
      if (c.due_for_rebook && c.email) {
        bannerText.innerHTML = `<strong>${escapeHtml(c.name.split(' ')[0])}</strong> hasn't booked in <strong>${c.days_since_last} days</strong> — last clean was ${escapeHtml(formatBookingDate(c.last_completed))}. Send a friendly nudge?`;
        const subject = encodeURIComponent('Time for another clean?');
        const firstName = c.name.split(' ')[0];
        const body = encodeURIComponent(
`Hi ${firstName},

It's been about ${c.days_since_last} days since your last clean with Hiraya Spaces — hope your space has been treating you well!

If you'd like to book another one (regular, deep, or just an hourly tidy-up), you can grab a slot any time at https://hirayaspaces.ca/#booking — or just reply to this email and I'll get you on the schedule.

Talk soon,
Aaron
Hiraya Spaces`
        );
        bannerBtn.href = `mailto:${c.email}?subject=${subject}&body=${body}`;
        banner.style.display = 'flex';
      } else {
        banner.style.display = 'none';
      }
    }

    // Customer meta editor — pre-fill from cache.
    const meta = customerMetaMap.get(c.user_id) || { notes: '', tags: [] };
    const notesEl = $('customer-meta-notes');
    const tagsEl = $('customer-meta-tags');
    const regularEl = $('customer-meta-regular');
    if (notesEl) notesEl.value = meta.notes || '';
    // Pre-check "Regular" if the tag is on file; keep it out of the visible
    // tag text input so admins don't see duplicate "regular" chips.
    const otherTags = (meta.tags || []).filter(t => t.toLowerCase() !== 'regular');
    if (tagsEl) tagsEl.value = otherTags.join(', ');
    if (regularEl) regularEl.checked = (meta.tags || []).some(t => t.toLowerCase() === 'regular');
    // Stash the user_id on a known DOM node so the save button can find it.
    if (notesEl) notesEl.dataset.userId = c.user_id;

    $('customer-stat-bookings').textContent = c.bookings.length;
    $('customer-stat-ltv').textContent = formatLtv(c.ltv_cents);
    $('customer-stat-since').textContent = c.first_booking ? formatBookingDate(c.first_booking) : '—';

    const avgTicketEl = $('customer-stat-avg-ticket');
    if (avgTicketEl) {
      avgTicketEl.textContent = c.earned_count > 0 ? formatLtv(c.avg_ticket_cents) : '—';
    }
    const cadenceEl = $('customer-stat-cadence');
    if (cadenceEl) {
      if (c.avg_gap_days != null) {
        // Express in the most human-friendly unit.
        let txt;
        if (c.avg_gap_days < 14) txt = `${c.avg_gap_days}d`;
        else if (c.avg_gap_days < 60) txt = `${Math.round(c.avg_gap_days / 7)} wks`;
        else txt = `${Math.round(c.avg_gap_days / 30)} mo`;
        cadenceEl.textContent = txt;
        // Keep the serif style consistent with the other stat values.
        cadenceEl.style.fontSize = '';
        cadenceEl.style.fontWeight = '';
        cadenceEl.style.fontFamily = '';
      } else {
        cadenceEl.textContent = c.earned_count > 1 ? '—' : 'First-time';
        cadenceEl.style.fontSize = '14px';
        cadenceEl.style.fontWeight = '500';
        cadenceEl.style.fontFamily = "'Jost', sans-serif";
      }
    }

    const mix = Object.entries(c.status_counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([s, n]) => `${n} ${statusLabel(s).toLowerCase()}`)
      .join(' · ');
    $('customer-stat-mix').textContent = mix || '—';
    $('customer-stat-mix').style.fontSize = '13px';
    $('customer-stat-mix').style.fontWeight = '500';
    $('customer-stat-mix').style.fontFamily = "'Jost', sans-serif";

    // Addresses
    const addrEl = $('customer-addresses');
    if (!c.addresses.size) {
      addrEl.innerHTML = `<div class="customer-no-addresses">No saved addresses yet.</div>`;
    } else {
      addrEl.innerHTML = Array.from(c.addresses.values()).map(a => {
        const street = [a.street_address, a.unit].filter(Boolean).join(', ');
        const cityLine = [a.city, a.postal_code].filter(Boolean).join(' ');
        const full = [street, cityLine].filter(Boolean).join(' · ');
        return `
          <div class="customer-address">
            <div class="customer-address-street">${escapeHtml(street)}</div>
            ${cityLine ? `<div class="customer-address-line">${escapeHtml(cityLine)}</div>` : ''}
            ${full ? `<a class="customer-address-maps" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(full)}" target="_blank" rel="noopener">🗺 Open in Maps →</a>` : ''}
          </div>`;
      }).join('');
    }

    // Bookings — newest first (preferred_date desc, then created_at desc)
    const sortedBookings = [...c.bookings].sort((a, b) => {
      const da = a.preferred_date || '';
      const db = b.preferred_date || '';
      if (da !== db) return da < db ? 1 : -1;
      return (b.created_at || '').localeCompare(a.created_at || '');
    });

    $('customer-bookings').innerHTML = sortedBookings.map(b => {
      const ownerCancellable = ['confirmed', 'in_progress'].includes(b.status);
      const isPending = b.status === 'pending_review' || b.status === 'awaiting_quote';
      let actions = '';
      if (isPending) {
        actions = `
          <div class="booking-card-actions">
            <button class="booking-card-btn" style="color:var(--rose)" onclick="event.stopPropagation(); HirayaAdmin.jumpToPending('${b.id}','decline')">Decline</button>
            <button class="booking-card-btn" style="background:var(--sage);color:white" onclick="event.stopPropagation(); HirayaAdmin.jumpToPending('${b.id}','confirm')">Confirm</button>
          </div>`;
      } else if (ownerCancellable) {
        actions = `<div class="booking-card-actions"><button class="booking-card-btn" style="color:var(--rose)" onclick="event.stopPropagation(); HirayaAdmin.jumpToAllAndCancel('${b.id}')">Cancel booking</button></div>`;
      }
      return bookingCardHtml(b, { actions, showInternal: true });
    }).join('');

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function closeCustomerDetail() {
    $('customer-detail-view').style.display = 'none';
    $('customers-list-view').style.display = 'block';
  }

  function saveCustomerMetaFromForm() {
    const notesEl = $('customer-meta-notes');
    const tagsEl = $('customer-meta-tags');
    const regularEl = $('customer-meta-regular');
    if (!notesEl) return;
    const userId = notesEl.dataset.userId;
    if (!userId) return;
    const notes = notesEl.value.trim();
    // Manual tags from the comma input, minus any stray 'regular' the admin
    // typed — the checkbox is the source of truth for that one.
    const manualTags = tagsEl.value.split(',')
      .map(t => t.trim())
      .filter(Boolean)
      .filter(t => t.toLowerCase() !== 'regular');
    const tags = regularEl?.checked ? ['regular', ...manualTags] : manualTags;
    saveCustomerMeta(userId, notes, tags);
  }

  // ── NOTIFICATIONS (realtime + browser Notification API) ────────────────
  // Aaron opts in by clicking the bell — we don't auto-request permission on
  // page load because Chrome shows a scary banner if you do that aggressively.
  // Preference persists in localStorage so once turned on, it stays on across
  // /admin visits.
  let realtimeChannel = null;

  function startBookingsRealtime() {
    if (realtimeChannel || !sb()) return;
    realtimeChannel = sb()
      .channel('admin-bookings')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'bookings' }, async () => {
        // Refetch via the authorized RPC — realtime payload may be partial.
        await refreshPending();
        refreshAll();
      })
      .subscribe();
  }

  function stopBookingsRealtime() {
    if (realtimeChannel && sb()) {
      sb().removeChannel(realtimeChannel);
    }
    realtimeChannel = null;
  }

  // ── NEW BOOKING (admin-initiated, on behalf of an existing customer) ───
  // Services list is loaded once on dashboard boot. Limited to existing
  // customers (must have a profile in our DB) because creating an auth user
  // requires the service role key, which can't safely live in the browser.
  let servicesCache = [];
  let addonsCache = [];
  let nbSelectedCustomer = null;
  let nbSelectedAddresses = [];

  async function loadServicesCache() {
    if (servicesCache.length || !sb()) return;
    const { data, error } = await sb()
      .from('services')
      .select('id, slug, name, starting_price_cents, sort_order, is_active, requires_quote, category_id')
      .eq('is_active', true)
      .order('sort_order');
    if (error) {
      console.warn('services fetch failed:', error.message);
      return;
    }
    servicesCache = data || [];
    populateServiceSelect();
    // Pull addons too — used by the Edit Booking modal so the admin can add
    // or remove extras like Inside Oven / Fridge / Eco Products.
    loadAddonsCache();
  }

  async function loadAddonsCache() {
    if (addonsCache.length || !sb()) return;
    const { data, error } = await sb()
      .from('addons')
      .select('id, slug, name, price_cents, is_active, sort_order')
      .eq('is_active', true)
      .order('sort_order');
    if (error) {
      console.warn('addons fetch failed:', error.message);
      return;
    }
    addonsCache = data || [];
  }

  function populateServiceSelect() {
    const sel = $('nb-service');
    if (!sel) return;
    // Skip requires_quote services — those need a human pricing conversation.
    const items = servicesCache.filter(s => !s.requires_quote);
    sel.innerHTML = '<option value="">Pick a service…</option>'
      + items.map(s => {
          const price = s.slug === 'hourly-flexible'
            ? '$50/hr'
            : (s.starting_price_cents != null ? '$' + Math.round(s.starting_price_cents / 100) : '');
          return `<option value="${escapeHtml(s.slug)}" data-price="${s.starting_price_cents ?? ''}">${escapeHtml(s.name)}${price ? ' — ' + price : ''}</option>`;
        }).join('');
  }

  function openNewBooking() {
    if (!isOwner) return;
    // Reset everything so reopening doesn't carry stale state.
    nbSelectedCustomer = null;
    nbSelectedAddresses = [];
    $('nb-customer-search').value = '';
    $('nb-customer-results').classList.remove('open');
    $('nb-customer-results').innerHTML = '';
    $('nb-customer-search-wrap').style.display = '';
    $('nb-customer-selected').style.display = 'none';
    $('nb-service').value = '';
    $('nb-hourly-wrap').style.display = 'none';
    $('nb-hours').value = 3;
    $('nb-price-hint').textContent = '';
    $('nb-date').value = '';
    $('nb-time').value = '';
    $('nb-address').innerHTML = '<option value="">Select a customer first…</option>';
    $('nb-customer-notes').value = '';
    $('nb-internal-notes').value = '';
    hideErr('nb-err');
    $('nb-overlay').classList.add('open');
    document.body.style.overflow = 'hidden';
    loadServicesCache();
  }

  function closeNewBooking() {
    $('nb-overlay').classList.remove('open');
    document.body.style.overflow = '';
  }
  function closeNewBookingIfBackdrop(e) {
    if (e.target.id === 'nb-overlay') closeNewBooking();
  }

  function searchCustomers() {
    const q = $('nb-customer-search').value.trim().toLowerCase();
    const results = $('nb-customer-results');
    if (!q) {
      results.classList.remove('open');
      return;
    }
    const customers = aggregateCustomers();
    const matches = customers.filter(c =>
      c.name.toLowerCase().includes(q) ||
      c.email.toLowerCase().includes(q) ||
      (c.phone && c.phone.toLowerCase().includes(q))
    ).slice(0, 8);
    if (!matches.length) {
      results.innerHTML = `<div class="nb-customer-result" style="cursor:default;color:var(--muted)">No matches. They may need to sign up on the public site first.</div>`;
      results.classList.add('open');
      return;
    }
    results.innerHTML = matches.map(c => `
      <div class="nb-customer-result" onclick="HirayaAdmin.pickCustomer('${c.user_id}')">
        <div class="nb-customer-result-name">${escapeHtml(c.name)}</div>
        <div class="nb-customer-result-email">${escapeHtml(c.email || 'no email')}${c.phone ? ' · ' + escapeHtml(c.phone) : ''}</div>
      </div>
    `).join('');
    results.classList.add('open');
  }

  async function pickCustomer(userId) {
    const c = aggregateCustomers().find(x => x.user_id === userId);
    if (!c) return;
    nbSelectedCustomer = c;
    $('nb-customer-search-wrap').style.display = 'none';
    $('nb-selected-name').textContent = c.name;
    $('nb-selected-email').textContent = c.email + (c.phone ? ' · ' + c.phone : '');
    $('nb-customer-selected').style.display = 'flex';

    // Pull this customer's saved addresses via the admin RPC.
    const addrSel = $('nb-address');
    addrSel.innerHTML = '<option value="">Loading addresses…</option>';
    try {
      const { data, error } = await sb().rpc('admin_list_addresses', { p_user_id: userId });
      if (error) throw error;
      nbSelectedAddresses = data || [];
      if (!nbSelectedAddresses.length) {
        addrSel.innerHTML = '<option value="">No saved addresses — ask customer to add one on the site</option>';
      } else {
        addrSel.innerHTML = '<option value="">Pick an address…</option>'
          + nbSelectedAddresses.map(a => {
              const parts = [
                [a.street_address, a.unit].filter(Boolean).join(', '),
                [a.city, a.postal_code].filter(Boolean).join(' '),
              ].filter(Boolean).join(' · ');
              const label = a.label ? `${a.label}: ${parts}` : parts;
              return `<option value="${a.id}">${escapeHtml(label)}</option>`;
            }).join('');
        // Auto-select the default address if there's exactly one.
        const def = nbSelectedAddresses.find(a => a.is_default) || nbSelectedAddresses[0];
        if (def) addrSel.value = def.id;
      }
    } catch (err) {
      console.warn('admin_list_addresses failed:', err);
      addrSel.innerHTML = `<option value="">Couldn't load addresses</option>`;
    }
  }

  function clearCustomer() {
    nbSelectedCustomer = null;
    nbSelectedAddresses = [];
    $('nb-customer-search-wrap').style.display = '';
    $('nb-customer-selected').style.display = 'none';
    $('nb-customer-search').value = '';
    $('nb-customer-search').focus();
    $('nb-address').innerHTML = '<option value="">Select a customer first…</option>';
  }

  function onServicePicked() {
    const slug = $('nb-service').value;
    const isHourly = slug === 'hourly-flexible';
    $('nb-hourly-wrap').style.display = isHourly ? 'block' : 'none';
    updatePriceHint();
  }

  function updatePriceHint() {
    const slug = $('nb-service').value;
    const hint = $('nb-price-hint');
    if (!slug) { hint.textContent = ''; return; }
    if (slug === 'hourly-flexible') {
      const hrs = Math.max(3, Math.min(8, Number($('nb-hours').value) || 3));
      hint.textContent = `Estimated price: ${hrs} × $50 = $${hrs * 50}`;
      return;
    }
    const svc = servicesCache.find(s => s.slug === slug);
    if (svc && svc.starting_price_cents != null) {
      hint.textContent = `Estimated price: $${Math.round(svc.starting_price_cents / 100)}`;
    } else {
      hint.textContent = '';
    }
  }

  async function submitNewBooking() {
    hideErr('nb-err');
    if (!nbSelectedCustomer) { showErr('nb-err', 'Pick a customer first.'); return; }
    const slug = $('nb-service').value;
    if (!slug) { showErr('nb-err', 'Pick a service.'); return; }
    const date = $('nb-date').value;
    if (!date) { showErr('nb-err', 'Pick a date.'); return; }
    const time = $('nb-time').value;
    if (!time) { showErr('nb-err', 'Pick a time slot.'); return; }
    const addressId = $('nb-address').value;
    if (!addressId) { showErr('nb-err', 'Pick an address.'); return; }

    let priceCents = null;
    if (slug === 'hourly-flexible') {
      const hrs = Math.max(3, Math.min(8, Number($('nb-hours').value) || 3));
      priceCents = hrs * 5000;
    } else {
      const svc = servicesCache.find(s => s.slug === slug);
      priceCents = svc?.starting_price_cents ?? null;
    }

    const btn = $('nb-submit');
    btn.disabled = true; btn.textContent = 'Creating…';
    try {
      const { data, error } = await sb().rpc('admin_create_booking', {
        p_user_id: nbSelectedCustomer.user_id,
        p_service_slug: slug,
        p_address_id: addressId,
        p_preferred_date: date,
        p_preferred_time_slot: time,
        p_estimated_price_cents: priceCents,
        p_customer_notes: $('nb-customer-notes').value.trim() || null,
        p_internal_notes: $('nb-internal-notes').value.trim() || null,
        p_status: 'confirmed',
      });
      if (error) throw error;
      showToast('Booking created and confirmed.', 'success');
      closeNewBooking();
      await refreshAll();
      refreshPending();
    } catch (err) {
      console.error('admin_create_booking failed:', err);
      showErr('nb-err', err.message || 'Could not create the booking.');
    } finally {
      btn.disabled = false; btn.textContent = 'Create confirmed booking';
    }
  }

  // ── CHECK-IN / CHECK-OUT (cleaner timestamps on-site) ──────────────────
  async function checkInBooking(id) {
    if (!sb()) return;
    try {
      const { data, error } = await sb().rpc('checkin_booking', { booking_id: id });
      if (error) throw error;
      if (data === false) {
        showToast('Could not check in — booking is not confirmed.', 'error');
        return;
      }
      showToast('Checked in. Have a great clean!', 'success');
      // Fire the "cleaner has arrived" email to the customer.
      sb().functions.invoke('send-booking-email', { body: { booking_id: id, mode: 'checked_in' } })
        .catch(err => console.warn('checked_in email failed:', err));
      await refreshAll();
      refreshPending();
    } catch (err) {
      console.error('checkin_booking failed:', err);
      showToast(err.message || 'Could not check in.', 'error');
    }
  }

  async function checkOutBooking(id) {
    if (!sb()) return;
    try {
      const { data, error } = await sb().rpc('checkout_booking', { booking_id: id });
      if (error) throw error;
      if (data === false) {
        showToast('Could not check out — booking is not in progress.', 'error');
        return;
      }
      showToast('Checked out. Don\'t forget to Mark Complete with the final price.', 'success');
      await refreshAll();
    } catch (err) {
      console.error('checkout_booking failed:', err);
      showToast(err.message || 'Could not check out.', 'error');
    }
  }

  function formatDuration(mins) {
    if (mins == null || mins < 0) return '';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h && m) return `${h}h ${m}m`;
    if (h) return `${h}h`;
    return `${m}m`;
  }
  function timeOnly(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  // ── MANUAL EDIT (admin can adjust any pending/active booking) ──────────
  let editingId = null;

  async function askEdit(id) {
    // Source of truth is allBookings (which has joined service_name etc).
    // Pending bookings come from pendingBookings, so fall back if needed.
    const b = allBookings.find(x => x.id === id) || pendingBookings.find(x => x.id === id);
    if (!b) return;
    editingId = id;

    // Make sure caches are loaded — the modal may be opened before the
    // user has navigated to anything that triggered loadServicesCache.
    if (!servicesCache.length || !addonsCache.length) {
      await loadServicesCache();
    }

    // Populate the service tier dropdown from the cached services list.
    const svcSel = $('edit-service');
    if (svcSel) {
      svcSel.innerHTML = servicesCache.map(s => {
        const price = s.requires_quote ? 'Quote' : '$' + Math.round((s.starting_price_cents || 0) / 100);
        return `<option value="${s.id}" data-slug="${s.slug}">${s.name} — ${price}</option>`;
      }).join('');
      // Pre-select the current service by matching name (we don't store
      // service_id in allBookings — only service_name).
      const match = servicesCache.find(s => s.name === b.service_name);
      if (match) svcSel.value = match.id;
    }

    // Fetch this booking's current addons so we can pre-check them.
    let currentAddonIds = new Set();
    try {
      const { data: addonRows } = await sb()
        .from('booking_addons')
        .select('addon_id')
        .eq('booking_id', id);
      currentAddonIds = new Set((addonRows || []).map(r => r.addon_id));
    } catch (e) {
      console.warn('booking_addons fetch failed:', e);
    }

    // Fetch the booking's extra services (anything beyond the primary). Each
    // row gets its own line in the Additional services list.
    let currentExtras = [];
    try {
      const { data: extraRows, error: extraErr } = await sb().rpc('admin_get_booking_services', { p_booking_id: id });
      if (extraErr) throw extraErr;
      currentExtras = extraRows || [];
    } catch (e) {
      console.warn('admin_get_booking_services failed:', e);
    }
    renderEditExtras(currentExtras);

    // Render addon checkboxes. Each is a labeled checkbox with the price hint.
    const addonsEl = $('edit-addons');
    if (addonsEl) {
      addonsEl.innerHTML = addonsCache.map(a => {
        const checked = currentAddonIds.has(a.id) ? 'checked' : '';
        const priceLabel = a.price_cents ? ` (+$${Math.round(a.price_cents / 100)})` : '';
        return `<label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
          <input type="checkbox" class="edit-addon-cb" value="${a.id}" data-price="${a.price_cents || 0}" ${checked} onchange="HirayaAdmin.recalcEditPrice()">
          <span>${escapeHtml(a.name)}${priceLabel}</span>
        </label>`;
      }).join('') || '<div style="color:var(--muted);font-size:13px">No add-ons available.</div>';
    }

    // Recalc price when service tier changes too.
    if (svcSel) svcSel.onchange = recalcEditPrice;

    $('edit-date').value = b.preferred_date || '';
    $('edit-time').value = b.preferred_time_slot || '8:00 am';
    $('edit-price').value = b.estimated_price_cents != null ? Math.round(b.estimated_price_cents / 100) : '';
    $('edit-customer-notes').value = b.customer_notes || '';
    $('edit-internal-notes').value = b.internal_notes || '';

    $('edit-text').textContent =
      `${b.service_name || 'Booking'} — ${b.customer_name || 'Customer'} (currently ${formatBookingDate(b.preferred_date)}${b.preferred_time_slot ? ' at ' + b.preferred_time_slot : ''})`;
    hideErr('edit-err');

    // Edit modal is a top-level overlay (.nb-overlay pattern) — works from
    // any tab. Just add the .open class to show it.
    const overlay = $('edit-overlay');
    if (overlay) overlay.classList.add('open');
  }

  function cancelEdit() {
    editingId = null;
    const overlay = $('edit-overlay');
    if (overlay) overlay.classList.remove('open');
  }

  function closeEditIfBackdrop(event) {
    if (event.target.id === 'edit-overlay') cancelEdit();
  }

  // Recompute the estimated price field whenever the tier, addons, OR
  // additional services change. Catalog base + extras + checked addons.
  // Admin can still type a custom override after.
  function recalcEditPrice() {
    const svcSel = $('edit-service');
    if (!svcSel) return;
    const selectedId = parseInt(svcSel.value, 10);
    const svc = servicesCache.find(s => s.id === selectedId);
    const baseCents = svc?.starting_price_cents || 0;
    const addonsCents = Array.from(document.querySelectorAll('.edit-addon-cb'))
      .filter(cb => cb.checked)
      .reduce((sum, cb) => sum + (parseInt(cb.dataset.price, 10) || 0), 0);
    const extrasCents = Array.from(document.querySelectorAll('.edit-extra-row'))
      .reduce((sum, row) => {
        const priceInput = row.querySelector('.edit-extra-price');
        const v = priceInput ? Number(priceInput.value) : 0;
        return sum + (Number.isFinite(v) ? Math.round(v * 100) : 0);
      }, 0);
    const totalDollars = Math.round((baseCents + addonsCents + extrasCents) / 100);
    const priceEl = $('edit-price');
    if (priceEl) priceEl.value = totalDollars;
  }

  // ── Edit modal: additional services UI ─────────────────────────────────
  // Each extra row carries: service_id (number), tier_slug, tier_name,
  // price_cents. We re-render the list whenever it changes so the indexes
  // stay clean for collection at save time.

  function renderEditExtras(rows) {
    const host = $('edit-extras-list');
    if (!host) return;
    host.innerHTML = '';
    (rows || []).forEach(row => host.appendChild(buildEditExtraRow(row)));
    if (!rows || !rows.length) {
      const hint = document.createElement('div');
      hint.style.cssText = 'color:var(--muted);font-size:13px;font-style:italic';
      hint.textContent = 'No additional services. Click below to add one.';
      hint.id = 'edit-extras-empty';
      host.appendChild(hint);
    }
  }

  function buildEditExtraRow(initial) {
    const row = document.createElement('div');
    row.className = 'edit-extra-row';
    row.style.cssText = 'display:grid;grid-template-columns:1fr 110px 36px;gap:8px;align-items:center';

    const svcSel = document.createElement('select');
    svcSel.className = 'nb-input edit-extra-svc';
    svcSel.innerHTML = '<option value="">Pick a service…</option>' + servicesCache.map(s => {
      const price = s.requires_quote ? 'Quote' : '$' + Math.round((s.starting_price_cents || 0) / 100);
      return `<option value="${s.id}" data-slug="${escapeHtml(s.slug)}" data-name="${escapeHtml(s.name)}" data-price="${s.starting_price_cents || 0}">${escapeHtml(s.name)} — ${price}</option>`;
    }).join('');
    if (initial?.service_id) svcSel.value = String(initial.service_id);

    const priceInput = document.createElement('input');
    priceInput.type = 'number';
    priceInput.min = '0';
    priceInput.step = '1';
    priceInput.className = 'nb-input edit-extra-price';
    priceInput.placeholder = '$';
    if (initial?.price_cents != null) {
      priceInput.value = Math.round(initial.price_cents / 100);
    }

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn-ghost';
    removeBtn.style.cssText = 'padding:6px 10px;color:var(--rose);font-size:18px;line-height:1';
    removeBtn.title = 'Remove this service';
    removeBtn.textContent = '×';
    removeBtn.onclick = () => { row.remove(); recalcEditPrice(); maybeShowExtrasEmpty(); };

    svcSel.onchange = () => {
      // Auto-fill price from catalog when user picks a service.
      const opt = svcSel.selectedOptions[0];
      const cents = parseInt(opt?.dataset.price || '0', 10);
      if (cents) priceInput.value = Math.round(cents / 100);
      recalcEditPrice();
    };
    priceInput.oninput = recalcEditPrice;

    row.appendChild(svcSel);
    row.appendChild(priceInput);
    row.appendChild(removeBtn);
    return row;
  }

  function addEditExtra() {
    const empty = $('edit-extras-empty');
    if (empty) empty.remove();
    const host = $('edit-extras-list');
    if (!host) return;
    host.appendChild(buildEditExtraRow(null));
    recalcEditPrice();
  }

  function maybeShowExtrasEmpty() {
    const host = $('edit-extras-list');
    if (!host) return;
    if (!host.querySelector('.edit-extra-row') && !$('edit-extras-empty')) {
      const hint = document.createElement('div');
      hint.style.cssText = 'color:var(--muted);font-size:13px;font-style:italic';
      hint.textContent = 'No additional services. Click below to add one.';
      hint.id = 'edit-extras-empty';
      host.appendChild(hint);
    }
  }

  function collectEditExtras() {
    return Array.from(document.querySelectorAll('.edit-extra-row')).map(row => {
      const svcSel = row.querySelector('.edit-extra-svc');
      const priceInput = row.querySelector('.edit-extra-price');
      if (!svcSel?.value) return null;
      const opt = svcSel.selectedOptions[0];
      const priceCents = priceInput?.value ? Math.round(Number(priceInput.value) * 100) : null;
      return {
        service_id: parseInt(svcSel.value, 10),
        tier_slug: opt?.dataset.slug || null,
        tier_name: opt?.dataset.name || null,
        price_cents: priceCents,
        duration_minutes: null, // unknown from catalog row alone
        quantity: 1,
      };
    }).filter(Boolean);
  }

  async function submitEdit() {
    if (!editingId || !sb()) return;
    const id = editingId;

    const svcSel = $('edit-service');
    const serviceId = svcSel && svcSel.value ? parseInt(svcSel.value, 10) : null;
    const newDate = $('edit-date').value || null;
    const newTime = $('edit-time').value || null;
    const priceRaw = $('edit-price').value.trim();
    let priceCents = null;
    if (priceRaw !== '') {
      const num = Number(priceRaw);
      if (!Number.isFinite(num) || num < 0) {
        showErr('edit-err', 'Enter a valid price or leave blank.');
        return;
      }
      priceCents = Math.round(num * 100);
    }
    const customerNotes = $('edit-customer-notes').value.trim() || null;
    const internalNotes = $('edit-internal-notes').value.trim() || null;

    // Collect the currently-checked addon IDs.
    const addonIds = Array.from(document.querySelectorAll('.edit-addon-cb'))
      .filter(cb => cb.checked)
      .map(cb => parseInt(cb.value, 10))
      .filter(n => Number.isFinite(n));

    const btn = $('edit-btn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const { data, error } = await sb().rpc('admin_update_booking', {
        p_booking_id: id,
        p_service_id: serviceId,
        p_preferred_date: newDate,
        p_preferred_time_slot: newTime,
        p_estimated_price_cents: priceCents,
        p_customer_notes: customerNotes,
        p_internal_notes: internalNotes,
      });
      if (error) throw error;
      if (data === false) {
        showErr('edit-err', 'Booking is not editable (only pending/confirmed/in-progress can be edited).');
        return;
      }
      // Sync addons in a second call. Booking_addons get fully replaced with
      // whatever was checked in the modal. If the function doesn't exist yet
      // (SQL migration not run), show a clear hint instead of just dying.
      const { error: addonErr } = await sb().rpc('admin_set_booking_addons', {
        p_booking_id: id,
        p_addon_ids: addonIds,
      });
      if (addonErr) {
        const msg = addonErr.message || String(addonErr);
        if (/does not exist|not found/i.test(msg)) {
          showErr('edit-err', 'Booking saved, but add-ons could not sync — admin_set_booking_addons SQL function is missing. Paste the latest migration into Supabase SQL editor.');
        } else {
          showErr('edit-err', 'Booking saved, but add-ons failed: ' + msg);
        }
        await refreshAll();
        refreshPending();
        return;
      }
      // Sync additional services (booking_services rows).
      const extrasPayload = collectEditExtras();
      const { error: bsErr } = await sb().rpc('admin_set_booking_services', {
        p_booking_id: id,
        p_services: extrasPayload,
      });
      if (bsErr) {
        const msg = bsErr.message || String(bsErr);
        if (/does not exist|not found/i.test(msg)) {
          showErr('edit-err', 'Booking + add-ons saved, but additional services could not sync — admin_set_booking_services SQL function is missing.');
        } else {
          showErr('edit-err', 'Booking saved, but additional services failed: ' + msg);
        }
        await refreshAll();
        refreshPending();
        return;
      }
      showToast('Booking updated.', 'success');

      // Notify the customer if the checkbox is on (default). Fire-and-forget
      // so a slow email send doesn't block the modal close.
      const notify = $('edit-notify')?.checked;
      if (notify) {
        sb().functions.invoke('send-booking-email', { body: { booking_id: id, mode: 'updated' } })
          .then(async ({ data: d, error: e }) => {
            let debug = d?.debug || d?.error || '';
            if (e) {
              try {
                const resp = e.context?.response;
                if (resp && typeof resp.json === 'function') {
                  const body = await resp.json();
                  debug = body?.debug || body?.error || debug;
                }
              } catch (_) {}
            }
            if (e || debug) {
              showToast('Edit saved, but update email failed: ' + (debug || e?.message || 'unknown'), 'error');
            }
          })
          .catch(err => {
            showToast('Edit saved, but update email failed: ' + (err?.message || err), 'error');
          });
      }

      editingId = null;
      await refreshAll();
      refreshPending();
      cancelEdit();
    } catch (err) {
      console.error('admin_update_booking failed:', err);
      showErr('edit-err', err.message || 'Could not save.');
    } finally {
      btn.disabled = false; btn.textContent = 'Save changes';
    }
  }

  // ── RESCHEDULE (edit date/time without losing the booking) ─────────────
  let reschedulingId = null;

  function askReschedule(id) {
    const b = allBookings.find(x => x.id === id);
    if (!b) return;
    reschedulingId = id;
    $('reschedule-text').textContent =
      `${b.service_name || 'this booking'} — currently ${formatBookingDate(b.preferred_date)}${b.preferred_time_slot ? ' at ' + b.preferred_time_slot : ''} (${b.customer_name || 'Customer'})`;
    $('reschedule-date').value = b.preferred_date || '';
    $('reschedule-time').value = ''; // default to "Keep current"
    hideErr('reschedule-err');
    $('all-list-view').style.display = 'none';
    $('owner-cancel-view').style.display = 'none';
    const completeView = $('complete-view'); if (completeView) completeView.style.display = 'none';
    $('reschedule-view').style.display = 'block';
  }

  function cancelReschedule() {
    reschedulingId = null;
    $('reschedule-view').style.display = 'none';
    $('all-list-view').style.display = 'block';
  }

  async function submitReschedule() {
    if (!reschedulingId || !sb()) return;
    const id = reschedulingId;
    const newDate = $('reschedule-date').value;
    const newTime = $('reschedule-time').value || null;
    if (!newDate) {
      showErr('reschedule-err', 'Pick a new date.');
      return;
    }
    // Capture the original booking for the mailto body before refresh wipes it.
    const original = allBookings.find(x => x.id === id);
    const btn = $('reschedule-btn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const { data, error } = await sb().rpc('reschedule_booking', {
        booking_id: id, new_date: newDate, new_time_slot: newTime
      });
      if (error) throw error;
      if (data === false) {
        showErr('reschedule-err', 'Booking is no longer eligible — refresh and try again.');
        return;
      }
      showToast('Booking rescheduled. Emailing the customer…', 'success');
      // Fire the 'rescheduled' email via Gmail SMTP through the edge function.
      // Replaces the old mailto auto-click which Safari blocks as "auto-
      // composing an email." Old date/time are passed in the body because
      // the booking row has already been overwritten with the new values.
      if (original?.customer_email) {
        sb().functions.invoke('send-booking-email', {
          body: {
            booking_id: id,
            mode: 'rescheduled',
            old_date: original.preferred_date,
            old_time_slot: original.preferred_time_slot,
          },
        }).then(async ({ data: d, error: e }) => {
          let debug = d?.debug || d?.error || '';
          if (e) {
            try {
              const resp = e.context?.response;
              if (resp) {
                const clone = typeof resp.clone === 'function' ? resp.clone() : resp;
                const text = await clone.text();
                try { const j = JSON.parse(text); debug = j?.debug || j?.error || text; }
                catch (_) { debug = text; }
              }
            } catch (_) {}
          }
          if (e || debug) {
            showToast('Rescheduled, but the customer email returned a warning — verify if needed.', 'success');
          }
        }).catch(err => {
          showToast('Rescheduled, but the customer email returned a warning: ' + (err?.message || err), 'success');
        });
      }
      reschedulingId = null;
      await refreshAll();
      refreshPending();
      cancelReschedule();
    } catch (err) {
      console.error('reschedule_booking failed:', err);
      showErr('reschedule-err', err.message || 'Could not reschedule.');
    } finally {
      btn.disabled = false; btn.textContent = 'Save new date';
    }
  }

  // ── MARK COMPLETE (confirmed/in_progress → completed + final price) ────
  let completingId = null;

  function askComplete(id) {
    const b = allBookings.find(x => x.id === id);
    if (!b) return;
    completingId = id;
    $('complete-text').textContent =
      `${b.service_name || 'this booking'} on ${formatBookingDate(b.preferred_date)} (${b.customer_name || 'Customer'})`;
    // Pre-fill with the estimate so a one-click "yes that's right" works.
    const estDollars = b.estimated_price_cents != null ? Math.round(b.estimated_price_cents / 100) : '';
    $('complete-amount').value = estDollars;
    $('complete-est-hint').textContent = b.estimated_price_cents != null
      ? `Estimate was $${estDollars}`
      : 'No estimate on file.';
    hideErr('complete-err');
    $('all-list-view').style.display = 'none';
    $('owner-cancel-view').style.display = 'none';
    $('complete-view').style.display = 'block';
  }

  function cancelComplete() {
    completingId = null;
    $('complete-view').style.display = 'none';
    $('all-list-view').style.display = 'block';
  }

  async function submitComplete() {
    if (!completingId || !sb()) return;
    const id = completingId;
    const raw = $('complete-amount').value.trim();
    // Treat blank as "keep the existing final_price_cents" (the RPC uses
    // coalesce). Validate non-blank values as a non-negative integer-ish.
    let finalCents = null;
    if (raw !== '') {
      const num = Number(raw);
      if (!Number.isFinite(num) || num < 0) {
        showErr('complete-err', 'Enter a valid amount or leave blank.');
        return;
      }
      finalCents = Math.round(num * 100);
    }
    const btn = $('complete-btn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const { data, error } = await sb().rpc('complete_booking', { booking_id: id, final_cents: finalCents });
      if (error) throw error;
      if (data === false) {
        showErr('complete-err', 'Booking is no longer eligible — refresh and try again.');
      } else {
        showToast('Booking marked complete. Sending thank-you email…', 'success');
        // Surface email failures to admin instead of silent console.warn —
        // the customer not getting a thank-you is something Aaron needs to know.
        sb().functions.invoke('send-booking-email', { body: { booking_id: id, mode: 'completed' } })
          .then(async ({ data, error: e }) => {
            let debug = data?.debug || data?.error || '';
            if (e) {
              try {
                const resp = e.context?.response;
                if (resp) {
                  const clone = typeof resp.clone === 'function' ? resp.clone() : resp;
                  const text = await clone.text();
                  try {
                    const j = JSON.parse(text);
                    debug = j?.debug || j?.error || text;
                  } catch (_) { debug = text; }
                }
              } catch (_) {}
            }
            if (e || debug) {
              console.warn('completed email warning:', e?.message || debug || e);
              // Some SMTP errors fire after Gmail already accepted the message,
              // so the email often DID land. Word the toast accordingly.
              showToast('Booking complete. Thank-you email returned a warning — verify with the customer if needed.', 'success');
            }
          })
          .catch(err => {
            console.warn('completed email warning:', err);
            showToast('Booking complete. Thank-you email returned a warning — verify with the customer if needed.', 'success');
          });
        completingId = null;
        await refreshAll();
        refreshPending();
        cancelComplete();
      }
    } catch (err) {
      console.error('complete_booking failed:', err);
      showErr('complete-err', err.message || 'Could not save.');
    } finally {
      btn.disabled = false; btn.textContent = 'Mark complete';
    }
  }

  // Send a formal invoice email to the customer for a completed booking.
  // The edge function inserts an invoices row on first send and re-uses the
  // same row + invoice_number on subsequent sends.
  async function sendInvoice(id) {
    if (!sb() || !isOwner) return;
    const b = allBookings.find(x => x.id === id);
    if (!b) return;
    if (b.status !== 'completed') {
      showToast('Only completed bookings can be invoiced.', 'error');
      return;
    }
    const confirmed = window.confirm(`Send invoice to ${b.customer_name || 'customer'} (${b.customer_email || 'no email'})?`);
    if (!confirmed) return;
    showToast('Sending invoice…', 'success');
    try {
      const { data, error } = await sb().functions.invoke('send-booking-email', {
        body: { booking_id: id, mode: 'invoice' },
      });
      // Supabase's FunctionsHttpError swallows the response body and just says
      // "non-2xx status code" — try several paths to get the real reason.
      if (error) {
        let debug = '';
        try {
          const resp = error.context?.response;
          if (resp) {
            // Clone first so the body can still be read if the client consumed it.
            const clone = typeof resp.clone === 'function' ? resp.clone() : resp;
            const text = await clone.text();
            try {
              const j = JSON.parse(text);
              debug = j?.debug || j?.error || text;
            } catch (_) {
              debug = text;
            }
          }
        } catch (_) { /* body unreadable */ }
        console.error('sendInvoice non-2xx:', error, 'debug:', debug);
        // Map common server errors to actionable hints for Aaron.
        if (/booking_services|relation .* does not exist/i.test(debug)) {
          showToast('Invoice failed: missing booking_services SQL table. Run the latest migration in Supabase.', 'error');
        } else {
          showToast('Invoice failed: ' + (debug || error.message || 'Unknown'), 'error');
        }
        return;
      }
      const fallbackDebug = data?.debug || data?.error;
      if (fallbackDebug) {
        showToast('Invoice failed: ' + fallbackDebug, 'error');
        return;
      }
      const invNum = data?.invoice_number ? ` (${data.invoice_number})` : '';
      showToast('Invoice sent' + invNum + '.', 'success');
    } catch (err) {
      console.error('sendInvoice failed:', err);
      showToast('Invoice failed: ' + (err?.message || err), 'error');
    }
  }

  // Download the current All-Bookings view as CSV. Respects the active
  // status filter so each tab (Confirmed / Completed / All) exports its slice.
  function exportBookingsCsv() {
    const filter = ($('all-status-filter')?.value || '').trim();
    const rows = filter ? allBookings.filter(b => b.status === filter) : allBookings;
    if (!rows.length) {
      showToast('Nothing to export.', 'error');
      return;
    }
    const headers = [
      'Ref', 'Status', 'Service', 'Date', 'Time',
      'Customer', 'Email', 'Phone',
      'Street', 'Unit', 'City', 'Postal code',
      'Estimated price', 'Final price',
      'Frequency', 'Entry method', 'Entry instructions',
      'Check-in', 'Check-out', 'Created',
      'Customer notes', 'Internal notes',
    ];
    const csvCell = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const dollars = (c) => (c == null || c === '') ? '' : (c / 100).toFixed(2);
    const lines = [headers.map(csvCell).join(',')];
    for (const b of rows) {
      const ref = String(b.id || '').slice(0, 8).toUpperCase();
      lines.push([
        ref,
        b.status || '',
        b.service_name || '',
        b.preferred_date || '',
        b.preferred_time_slot || '',
        b.customer_name || '',
        b.customer_email || '',
        b.customer_phone || '',
        b.street_address || '',
        b.unit || '',
        b.city || '',
        b.postal_code || '',
        dollars(b.estimated_price_cents),
        dollars(b.final_price_cents),
        b.frequency || '',
        b.entry_method || '',
        b.entry_instructions || '',
        b.check_in_at || '',
        b.check_out_at || '',
        b.created_at || '',
        b.customer_notes || '',
        b.internal_notes || '',
      ].map(csvCell).join(','));
    }
    // Prepend UTF-8 BOM so Excel opens it with proper accent rendering.
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const today = new Date().toISOString().slice(0, 10);
    a.download = `hiraya-bookings-${filter || 'all'}-${today}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`Exported ${rows.length} booking${rows.length === 1 ? '' : 's'}.`, 'success');
  }

  // ── VIEW INVOICE ───────────────────────────────────────────────────────
  let viewingInvoiceBookingId = null;
  let viewingInvoice = null; // populated row from admin_get_invoice_for_booking

  async function viewInvoice(id) {
    if (!sb() || !isOwner) return;
    const b = allBookings.find(x => x.id === id);
    if (!b) return;
    viewingInvoiceBookingId = id;
    viewingInvoice = null;

    $('invoice-text').textContent = `${b.service_name || 'Booking'} — ${b.customer_name || 'Customer'} · ${formatBookingDate(b.preferred_date)}`;
    hideErr('invoice-err');
    $('invoice-empty').style.display = 'none';
    $('invoice-body').style.display = 'none';
    $('invoice-overlay').classList.add('open');

    try {
      const { data, error } = await sb().rpc('admin_get_invoice_for_booking', { p_booking_id: id });
      if (error) throw error;
      const inv = Array.isArray(data) ? data[0] : data;
      if (!inv) {
        $('invoice-empty').style.display = 'block';
        return;
      }
      viewingInvoice = inv;
      $('invoice-num').textContent = inv.invoice_number || '—';
      const statusColor = inv.status === 'paid' ? 'var(--sage)' : inv.status === 'unpaid' ? 'var(--text)' : 'var(--rose)';
      $('invoice-status').textContent = inv.status.toUpperCase();
      $('invoice-status').style.color = statusColor;
      $('invoice-total').textContent = '$' + Math.round((inv.total_cents || 0) / 100);
      $('invoice-issued').textContent = inv.created_at
        ? new Date(inv.created_at).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' })
        : '—';
      if (inv.paid_at) {
        $('invoice-paid-at-wrap').style.display = '';
        $('invoice-paid-at').textContent = new Date(inv.paid_at).toLocaleString('en-CA', { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      } else {
        $('invoice-paid-at-wrap').style.display = 'none';
      }
      const paidBtn = $('invoice-paid-btn');
      if (paidBtn) {
        paidBtn.textContent = inv.status === 'paid' ? 'Mark as unpaid' : 'Mark as paid';
      }
      $('invoice-body').style.display = 'block';
    } catch (err) {
      console.error('admin_get_invoice_for_booking failed:', err);
      const msg = err?.message || String(err);
      if (/does not exist|not found/i.test(msg)) {
        showErr('invoice-err', 'Missing admin_get_invoice_for_booking SQL function — paste the latest migration into Supabase.');
      } else {
        showErr('invoice-err', msg);
      }
      $('invoice-body').style.display = 'block';
    }
  }

  function closeInvoiceView() {
    viewingInvoiceBookingId = null;
    viewingInvoice = null;
    $('invoice-overlay').classList.remove('open');
  }

  function closeInvoiceIfBackdrop(event) {
    if (event.target.id === 'invoice-overlay') closeInvoiceView();
  }

  async function toggleInvoicePaid() {
    if (!viewingInvoice || !sb()) return;
    const next = viewingInvoice.status === 'paid' ? 'unpaid' : 'paid';
    const btn = $('invoice-paid-btn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const { error } = await sb().rpc('admin_set_invoice_status', {
        p_invoice_id: viewingInvoice.id,
        p_status: next,
      });
      if (error) throw error;
      showToast(`Marked ${next}.`, 'success');
      // Reopen to refresh the displayed status.
      const bookingId = viewingInvoiceBookingId;
      closeInvoiceView();
      viewInvoice(bookingId);
    } catch (err) {
      console.error('admin_set_invoice_status failed:', err);
      showErr('invoice-err', err?.message || 'Could not update status.');
      btn.disabled = false;
      btn.textContent = viewingInvoice.status === 'paid' ? 'Mark as unpaid' : 'Mark as paid';
    }
  }

  function resendInvoice() {
    if (!viewingInvoiceBookingId) return;
    sendInvoice(viewingInvoiceBookingId);
  }

  async function downloadInvoicePdf() {
    if (!viewingInvoiceBookingId || !sb()) return;
    const btn = $('invoice-pdf-btn');
    const original = btn.textContent;
    btn.disabled = true; btn.textContent = 'Generating PDF…';
    try {
      const { data, error } = await sb().functions.invoke('send-booking-email', {
        body: { booking_id: viewingInvoiceBookingId, mode: 'invoice', download_pdf: true },
      });
      // Pull the real error reason out of the FunctionsHttpError context.
      if (error) {
        let debug = '';
        try {
          const resp = error.context?.response;
          if (resp) {
            const clone = typeof resp.clone === 'function' ? resp.clone() : resp;
            const text = await clone.text();
            try {
              const j = JSON.parse(text);
              debug = j?.debug || j?.error || text;
            } catch (_) {
              debug = text;
            }
          }
        } catch (_) {}
        throw new Error(debug || error.message || 'Unknown');
      }
      if (!data?.pdf_base64) {
        throw new Error(data?.debug || data?.error || 'No PDF returned');
      }
      // Decode base64 → bytes → Blob → object URL → click.
      const bin = atob(data.pdf_base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = data.pdf_filename || `invoice-${viewingInvoiceBookingId.slice(0, 8)}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('PDF downloaded.', 'success');
    } catch (err) {
      console.error('downloadInvoicePdf failed:', err);
      showErr('invoice-err', 'PDF download failed: ' + (err?.message || err));
    } finally {
      btn.disabled = false; btn.textContent = original;
    }
  }

  // ── BLOCKED DATES ──────────────────────────────────────────────────────
  // Cached Map<YYYY-MM-DD, { reason }>. Refreshed alongside allBookings so
  // the calendar grid and the day detail drawer stay in sync after a toggle.
  let blockedDates = new Map();

  async function refreshBlockedDates() {
    if (!sb() || !isOwner) { blockedDates = new Map(); return; }
    const { data, error } = await sb()
      .from('blocked_dates')
      .select('date, reason');
    if (error) {
      console.warn('blocked_dates fetch failed:', error.message);
      blockedDates = new Map();
      return;
    }
    blockedDates = new Map((data || []).map(r => [r.date, { reason: r.reason || '' }]));
  }

  async function toggleBlockedDate(dateStr) {
    if (!sb() || !isOwner) return;
    const already = blockedDates.has(dateStr);
    try {
      if (already) {
        const { error } = await sb().from('blocked_dates').delete().eq('date', dateStr);
        if (error) throw error;
        blockedDates.delete(dateStr);
        showToast('Day re-opened for bookings.', 'success');
      } else {
        const { error } = await sb().from('blocked_dates').insert({ date: dateStr, reason: null });
        if (error) throw error;
        blockedDates.set(dateStr, { reason: '' });
        showToast('Day blocked. Customers can no longer book it.', 'success');
      }
      renderCalendar();
      // Re-open the same day so the toggle button reflects the new state.
      openDayDetail(dateStr);
    } catch (err) {
      console.error('toggleBlockedDate failed:', err);
      showToast(err.message || 'Could not change availability.', 'error');
    }
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

      const isBlocked = blockedDates.has(key);
      const classes = ['cal-cell'];
      if (!inMonth) classes.push('is-outside');
      if (isToday) classes.push('is-today');
      if (isSelected) classes.push('is-selected');
      if (events.length) classes.push('has-events');
      if (isBlocked) classes.push('is-blocked');

      // Any day in the current month is clickable (so Aaron can block empty
      // days too). Out-of-month days stay non-interactive.
      const click = inMonth ? `onclick="HirayaAdmin.openDayDetail('${key}')"` : '';
      if (inMonth) classes.push('has-events'); // reuses the hover cursor style

      const blockedBadge = isBlocked ? `<div class="cal-blocked-tag">Blocked</div>` : '';
      cells.push(`
        <div class="${classes.join(' ')}" ${click} data-date="${key}">
          <div class="cal-cell-date">${d.getDate()}</div>
          ${blockedBadge}
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

    // Availability toggle — surfaces a block/unblock action that lives in
    // the same drawer as the day's bookings (one place for everything
    // related to "this day").
    const isBlocked = blockedDates.has(dateStr);
    const blockToggleHtml = `
      <div class="cal-availability">
        <div>
          <div class="cal-availability-label">Availability</div>
          <div class="cal-availability-state">${isBlocked ? '🚫 Blocked — no new bookings' : '✅ Open for bookings'}</div>
        </div>
        <button class="btn-ghost" onclick="HirayaAdmin.toggleBlockedDate('${dateStr}')">
          ${isBlocked ? 'Re-open this day' : 'Block this day'}
        </button>
      </div>`;

    const bookingsHtml = !events.length
      ? `<div class="empty-state" style="margin-top:1rem">No bookings on this day.</div>`
      : events.map(b => {
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

    list.innerHTML = blockToggleHtml + (events.length ? '<div style="margin-top:1rem"></div>' : '') + bookingsHtml;
    drawer.style.display = 'block';
    drawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function closeDayDetail() {
    calSelected = null;
    document.querySelectorAll('#cal-grid .cal-cell.is-selected').forEach(el => el.classList.remove('is-selected'));
    const drawer = $('cal-day-detail');
    if (drawer) drawer.style.display = 'none';
  }

  // Build a plain-text summary of today's bookings and open a pre-filled
  // mailto to the logged-in admin. v1 is manual — for a true scheduled
  // email, set up a pg_cron job that calls send-booking-email with a
  // mode='daily_summary'. Doing it client-side keeps things simple.
  function emailDailySummary() {
    if (!currentUser?.email) {
      showToast('No admin email on file.', 'error');
      return;
    }
    const todayStr = ymd(new Date());
    const events = (bookingsByDate().get(todayStr) || [])
      .filter(b => ['confirmed', 'in_progress', 'pending_review', 'awaiting_quote'].includes(b.status))
      .sort((a, b) => (a.preferred_time_slot || '').localeCompare(b.preferred_time_slot || ''));

    const dateLabel = new Date(todayStr + 'T12:00:00')
      .toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    let body = `Hiraya Spaces — schedule for ${dateLabel}\n\n`;
    if (!events.length) {
      body += `No bookings on the books today. Enjoy the day off!\n`;
    } else {
      const revenue = events.reduce((sum, b) => sum + (b.estimated_price_cents || 0), 0);
      body += `${events.length} ${events.length === 1 ? 'job' : 'jobs'} · est. $${Math.round(revenue / 100)}\n`;
      body += `${'─'.repeat(40)}\n\n`;
      events.forEach((b, i) => {
        const time = b.preferred_time_slot || 'time TBD';
        const who = b.customer_name || 'Customer';
        const phone = b.customer_phone || '';
        const addr = [
          [b.street_address, b.unit].filter(Boolean).join(', '),
          [b.city, b.postal_code].filter(Boolean).join(' '),
        ].filter(Boolean).join(', ');
        const svc = b.service_name || 'Cleaning';
        const status = statusLabel(b.status);
        body += `${i + 1}. ${time} — ${who} (${status})\n`;
        body += `   ${svc}\n`;
        if (addr) body += `   📍 ${addr}\n`;
        if (phone) body += `   📞 ${phone}\n`;
        if (b.entry_method && b.entry_method !== 'home') {
          const labels = { lockbox: 'Lockbox', hidden_key: 'Hidden key', fob: 'Fob/code', concierge: 'Concierge', other: 'Entry' };
          body += `   🔑 ${labels[b.entry_method] || 'Entry'}: ${b.entry_instructions || '(see customer)'}\n`;
        }
        if (b.customer_notes) body += `   📝 ${b.customer_notes}\n`;
        if (b.internal_notes) body += `   🔒 ${b.internal_notes}\n`;
        body += `\n`;
      });
    }
    body += `\nFull dashboard: https://hirayaspaces.ca/admin\n`;

    const subject = encodeURIComponent(`Hiraya schedule — ${dateLabel}`);
    const mailto = `mailto:${currentUser.email}?subject=${subject}&body=${encodeURIComponent(body)}`;
    window.location.href = mailto;
  }

  // Print a clean, paper-friendly schedule for one day. Defaults to the
  // currently-selected day, or today if nothing is selected. Opens a new
  // window with its own minimal stylesheet so it prints well without
  // dragging in all of /admin's chrome.
  function printDay() {
    const dateStr = calSelected || ymd(new Date());
    const d = new Date(dateStr + 'T12:00:00');
    const dateLabel = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const events = (bookingsByDate().get(dateStr) || [])
      .filter(b => ACTIVE_STATUSES.includes(b.status));
    const blocked = blockedDates.has(dateStr);

    const rows = events.length === 0
      ? `<tr><td colspan="5" class="empty">No active bookings on this day.</td></tr>`
      : events.map(b => {
          const time = b.preferred_time_slot || '—';
          const addr = [
            [b.street_address, b.unit].filter(Boolean).join(', '),
            [b.city, b.postal_code].filter(Boolean).join(' '),
          ].filter(Boolean).join(' · ');
          const mapsHref = addr ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}` : '';
          const phone = b.customer_phone || '';
          const notes = b.customer_notes || '';
          const internal = b.internal_notes || '';
          const status = statusLabel(b.status);
          return `
            <tr>
              <td class="time">${escapeHtml(time)}</td>
              <td>
                <div class="customer">${escapeHtml(b.customer_name || 'Customer')}</div>
                ${phone ? `<div class="meta">${escapeHtml(phone)}</div>` : ''}
                ${b.customer_email ? `<div class="meta">${escapeHtml(b.customer_email)}</div>` : ''}
              </td>
              <td>
                <div class="service">${escapeHtml(b.service_name || 'Cleaning')}</div>
                <div class="meta">${escapeHtml(status)}</div>
              </td>
              <td>
                ${addr ? `<div>${escapeHtml(addr)}</div>` : '<div class="meta">No address on file</div>'}
                ${mapsHref ? `<div class="meta"><a href="${mapsHref}">${escapeHtml(mapsHref)}</a></div>` : ''}
              </td>
              <td>
                ${b.entry_method && b.entry_method !== 'home' ? `<div class="entry-print"><strong>${escapeHtml({lockbox:'Lockbox',hidden_key:'Hidden key',fob:'Fob/code',concierge:'Concierge',other:'Entry'}[b.entry_method] || 'Entry')}:</strong> ${escapeHtml(b.entry_instructions || '(see customer)')}</div>` : ''}
                ${notes ? `<div>${escapeHtml(notes)}</div>` : ''}
                ${internal ? `<div class="internal">🔒 ${escapeHtml(internal)}</div>` : ''}
                ${!notes && !internal && !b.entry_method ? '<div class="meta">—</div>' : ''}
              </td>
            </tr>`;
        }).join('');

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Hiraya Schedule — ${escapeHtml(dateLabel)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif; color: #1a2e1e; padding: 24px; max-width: 1000px; margin: 0 auto; }
  header { border-bottom: 2px solid #1e4d2b; padding-bottom: 12px; margin-bottom: 18px; display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; }
  h1 { font-size: 22px; font-weight: 600; }
  h1 span { color: #1e4d2b; }
  .meta-top { font-size: 12px; color: #555; text-align: right; }
  .blocked-banner { background: #f6e6e6; border: 1px solid #c97a7a; color: #7a3a3a; padding: 10px 14px; border-radius: 6px; margin-bottom: 16px; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  thead th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: #555; border-bottom: 1px solid #ccc; padding: 8px 6px; }
  tbody td { border-bottom: 1px solid #e5e5e5; padding: 10px 6px; vertical-align: top; }
  tbody td.time { font-weight: 600; white-space: nowrap; }
  .customer { font-weight: 600; }
  .service { font-weight: 500; }
  .meta { font-size: 11px; color: #666; }
  .internal { background: #fffbeb; border-left: 3px solid #b08c4a; padding: 4px 8px; margin-top: 4px; font-size: 11px; }
  .entry-print { background: #e4f0e9; border-left: 3px solid #1e4d2b; padding: 4px 8px; margin-bottom: 4px; font-size: 11px; }
  .empty { text-align: center; padding: 30px; color: #888; font-style: italic; }
  footer { margin-top: 24px; padding-top: 12px; border-top: 1px solid #ccc; font-size: 10px; color: #888; text-align: center; }
  a { color: #1e4d2b; text-decoration: none; }
  .print-btn { background: #1e4d2b; color: white; border: none; padding: 8px 16px; border-radius: 6px; font-size: 12px; cursor: pointer; }
  @media print {
    body { padding: 0; }
    .print-btn { display: none; }
    a { color: #000; }
  }
</style>
</head>
<body>
  <header>
    <div>
      <h1>Hiraya Spaces <span>· Schedule</span></h1>
      <div style="font-size:15px;margin-top:4px;color:#1e4d2b;font-weight:500">${escapeHtml(dateLabel)}</div>
    </div>
    <div class="meta-top">
      ${events.length} ${events.length === 1 ? 'booking' : 'bookings'}<br>
      Generated ${new Date().toLocaleString()}<br>
      <button class="print-btn" onclick="window.print()" style="margin-top:8px">🖨 Print</button>
    </div>
  </header>
  ${blocked ? '<div class="blocked-banner">⚠️ This day is marked as blocked in the admin calendar.</div>' : ''}
  <table>
    <thead>
      <tr>
        <th style="width:90px">Time</th>
        <th style="width:23%">Customer</th>
        <th style="width:22%">Service</th>
        <th>Address</th>
        <th style="width:25%">Notes</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <footer>hirayaspaces.ca</footer>
</body>
</html>`;

    const win = window.open('', '_blank');
    if (!win) {
      showToast('Pop-up blocked — allow pop-ups for /admin and try again.', 'error');
      return;
    }
    win.document.write(html);
    win.document.close();
    // Give the new window a tick to render before auto-prompting print.
    setTimeout(() => { try { win.focus(); win.print(); } catch (_) {} }, 250);
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
        stopBookingsRealtime();
        showView('login');
      }
    });

    // Initial route — onAuthStateChange's INITIAL_SESSION fires too, but we
    // call this explicitly so the gate flashes the right view immediately
    // instead of waiting for the event loop.
    checkAuthAndRoute();
  }

  // ── BOOKING DETAIL MODAL ───────────────────────────────────────────────
  function openBookingDetail(id, event) {
    // Bail if the click came from a button/link inside the card — those
    // already have their own action handlers.
    if (event && event.target && event.target.closest('button, a')) return;
    const b = allBookings.find(x => x.id === id) || pendingBookings.find(x => x.id === id);
    if (!b) return;
    const overlay = $('detail-overlay');
    if (!overlay) return;

    const dateStr = formatBookingDate(b.preferred_date);
    const timeStr = b.preferred_time_slot ? ` at ${b.preferred_time_slot}` : '';
    const priceCents = b.final_price_cents ?? b.estimated_price_cents;
    const total = priceCents != null ? '$' + Math.round(priceCents / 100) : 'Quote on request';
    const addr = [
      [b.street_address, b.unit].filter(Boolean).join(', '),
      [b.city, b.postal_code].filter(Boolean).join(' '),
    ].filter(Boolean).join(' · ');
    const mapsLink = addr ? `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}" target="_blank" rel="noopener" style="font-size:12px">🗺 Open in Maps →</a>` : '';

    $('detail-subtitle').textContent = `Ref ${b.id.slice(0, 8).toUpperCase()} · ${statusLabel(b.status)}`;
    $('detail-service').innerHTML = escapeHtml(b.service_name || 'Cleaning service');
    $('detail-when').innerHTML = `<strong>${escapeHtml(dateStr)}</strong>${escapeHtml(timeStr)}`;

    const addons = b.addon_names || [];
    $('detail-addons').innerHTML = addons.length
      ? addons.map(n => `<div>✨ ${escapeHtml(n)}</div>`).join('')
      : '<span style="color:var(--muted)">No add-ons</span>';

    const phoneLink = b.customer_phone ? `<a href="tel:${escapeHtml(b.customer_phone.replace(/[^\d+]/g, ''))}">${escapeHtml(b.customer_phone)}</a>` : '';
    const emailLink = b.customer_email ? `<a href="mailto:${escapeHtml(b.customer_email)}">${escapeHtml(b.customer_email)}</a>` : '';
    $('detail-customer').innerHTML = `
      <div><strong>${escapeHtml(b.customer_name || 'Customer')}</strong></div>
      ${emailLink ? `<div>✉️ ${emailLink}</div>` : ''}
      ${phoneLink ? `<div>📞 ${phoneLink}</div>` : ''}
    `;
    $('detail-address').innerHTML = addr
      ? `<div>📍 ${escapeHtml(addr)}</div><div style="margin-top:4px">${mapsLink}</div>`
      : '<span style="color:var(--muted)">No address on file</span>';

    const entryLabels = { home: '🏠 Customer will be home', lockbox: '🔐 Lockbox', hidden_key: '🗝 Hidden key', fob: '🏢 Building fob/code', concierge: '🛎 Concierge', other: '📋 Other' };
    let entryHtml = entryLabels[b.entry_method] || '—';
    if (b.entry_instructions) entryHtml += `<div style="margin-top:4px;color:var(--muted);font-size:13px">${escapeHtml(b.entry_instructions)}</div>`;
    $('detail-entry').innerHTML = entryHtml;

    const notesWrap = $('detail-notes-wrap');
    if (b.customer_notes) {
      $('detail-notes').textContent = b.customer_notes;
      notesWrap.style.display = '';
    } else {
      notesWrap.style.display = 'none';
    }
    const internalWrap = $('detail-internal-wrap');
    if (b.internal_notes) {
      $('detail-internal').textContent = b.internal_notes;
      internalWrap.style.display = '';
    } else {
      internalWrap.style.display = 'none';
    }

    $('detail-price').innerHTML = `<strong style="font-size:18px">${escapeHtml(total)}</strong>`;

    // Mirror the card's action buttons inside the modal so the admin/cleaner
    // can act without closing the modal first.
    const card = document.querySelector(`.booking-card[data-id="${b.id}"] .booking-card-actions`);
    const actionsEl = $('detail-actions');
    if (actionsEl) {
      actionsEl.innerHTML = card ? card.innerHTML : '';
      // After tapping any action button, close the modal so the workflow
      // (askEdit, askConfirm, etc.) can take focus cleanly.
      actionsEl.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', () => setTimeout(closeBookingDetail, 50));
      });
    }

    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeBookingDetail() {
    const overlay = $('detail-overlay');
    if (overlay) overlay.classList.remove('open');
    document.body.style.overflow = '';
  }
  function closeDetailIfBackdrop(event) {
    if (event.target.id === 'detail-overlay') closeBookingDetail();
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
    askComplete,
    cancelComplete,
    submitComplete,
    askEdit,
    cancelEdit,
    closeEditIfBackdrop,
    submitEdit,
    recalcEditPrice,
    addEditExtra,
    sendInvoice,
    viewInvoice,
    closeInvoiceView,
    closeInvoiceIfBackdrop,
    toggleInvoicePaid,
    resendInvoice,
    downloadInvoicePdf,
    exportBookingsCsv,
    askReschedule,
    cancelReschedule,
    submitReschedule,
    checkInBooking,
    checkOutBooking,
    // Calendar
    calPrev,
    calNext,
    calToday,
    openDayDetail,
    closeDayDetail,
    jumpToPending,
    jumpToAllAndCancel,
    toggleBlockedDate,
    printDay,
    emailDailySummary,
    // Customers
    renderCustomers,
    openCustomerDetail,
    closeCustomerDetail,
    saveCustomerMetaFromForm,
    // Booking detail modal
    openBookingDetail,
    closeBookingDetail,
    closeDetailIfBackdrop,
    // New booking
    openNewBooking,
    closeNewBooking,
    closeNewBookingIfBackdrop,
    searchCustomers,
    pickCustomer,
    clearCustomer,
    onServicePicked,
    updatePriceHint,
    submitNewBooking,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
