(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function sb() { return window.hirayaSupabase; }

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

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── STATE ───────────────────────────────────────────────────────────────
  // Cached list of the logged-in user's addresses, keyed for the booking form
  // dropdown and the modal list view. Refresh whenever the modal opens or
  // after any mutation.
  let cachedAddresses = [];
  let editingId = null;          // id of address being edited, null when adding new
  let deletingId = null;         // id of address pending delete confirmation
  let deletingLabel = '';        // display label for the delete confirmation
  let savedAddressListeners = []; // callbacks fired after the cache refreshes

  function onAddressesChanged(fn) {
    if (typeof fn === 'function') savedAddressListeners.push(fn);
  }
  function notifyListeners() {
    savedAddressListeners.forEach(fn => {
      try { fn(cachedAddresses); } catch (e) { /* swallow */ }
    });
  }

  async function fetchAddresses() {
    if (!sb()) { cachedAddresses = []; notifyListeners(); return []; }
    const { data: { user } } = await sb().auth.getUser();
    if (!user) { cachedAddresses = []; notifyListeners(); return []; }

    const { data, error } = await sb()
      .from('addresses')
      .select('id, label, street_address, unit, city, province, postal_code, is_default, created_at')
      .eq('user_id', user.id)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false });

    if (error) {
      console.warn('fetchAddresses failed:', error.message);
      cachedAddresses = [];
    } else {
      cachedAddresses = data || [];
    }
    notifyListeners();
    return cachedAddresses;
  }

  function getCachedAddresses() { return cachedAddresses.slice(); }

  // ── OWNER GATE ─────────────────────────────────────────────────────────
  // The "owners" (Aaron, the business inbox, and Jewel) see the Admin link
  // in the nav and have access to /admin. Keep this list in lockstep with
  // OWNER_EMAILS in js/admin.js AND the is_owner() function in
  // hiraya-schema.sql — all three check the same set of emails.
  const OWNER_EMAILS = [
    'aaron-thompson@outlook.com',
    'hirayaspaces@gmail.com',
    'jaeannecm@gmail.com',
  ];
  let isOwner = false;

  // ── MODAL OPEN / CLOSE / TAB SWITCH ────────────────────────────────────
  let activeTab = 'addresses';
  let cancellingBookingId = null;
  let cancellingBookingLabel = '';
  let decliningBookingId = null;
  let decliningBookingLabel = '';

  async function openAccount(tab) {
    const modal = $('addresses-modal');
    if (!modal) return;
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
    await refreshOwnerStatus();
    switchTab(tab || 'bookings');
  }
  function openAddresses() { openAccount('addresses'); }
  function openBookings() { openAccount('bookings'); }

  async function refreshOwnerStatus() {
    if (!sb()) { isOwner = false; }
    else {
      try {
        const { data: { user } } = await sb().auth.getUser();
        const email = (user?.email || '').toLowerCase();
        isOwner = !!user && OWNER_EMAILS.some(e => e.toLowerCase() === email);
      } catch (_) { isOwner = false; }
    }
    const navAdminItem = $('nav-user-menu-admin');
    if (navAdminItem) {
      navAdminItem.style.display = isOwner ? '' : 'none';
      // Inject the href only for confirmed owners so /admin never appears in
      // the static HTML source that Googlebot crawls.
      if (isOwner) navAdminItem.setAttribute('href', '/admin');
      else navAdminItem.removeAttribute('href');
    }
    const navAdminLink = $('nav-admin-link');
    if (navAdminLink) navAdminLink.style.display = isOwner ? 'inline-flex' : 'none';
  }

  function closeAddresses() {
    const modal = $('addresses-modal');
    if (!modal) return;
    modal.classList.remove('open');
    document.body.style.overflow = '';
    editingId = null;
    deletingId = null;
    cancellingBookingId = null;
  }

  function switchTab(tab) {
    activeTab = tab;
    // Tab button highlight
    document.querySelectorAll('.account-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    // Top-level tab content panels
    const bookingsTab = $('account-tab-bookings');
    const addressesTab = $('account-tab-addresses');
    if (bookingsTab) bookingsTab.style.display = tab === 'bookings' ? 'block' : 'none';
    if (addressesTab) addressesTab.style.display = tab === 'addresses' ? 'block' : 'none';
    // Reset sub-views to their list state
    if (tab === 'addresses') {
      showListView();
      refreshList();
    } else if (tab === 'bookings') {
      showBookingsListView();
      refreshBookings();
    }
  }

  function showListView() {
    $('addr-list-view').style.display = 'block';
    $('addr-form-view').style.display = 'none';
    $('addr-confirm-delete').style.display = 'none';
  }
  function showFormView() {
    $('addr-list-view').style.display = 'none';
    $('addr-form-view').style.display = 'block';
    $('addr-confirm-delete').style.display = 'none';
  }
  function showConfirmDelete() {
    $('addr-list-view').style.display = 'none';
    $('addr-form-view').style.display = 'none';
    $('addr-confirm-delete').style.display = 'block';
  }

  // Bookings sub-view toggles
  function showBookingsListView() {
    $('bookings-list-view').style.display = 'block';
    $('booking-cancel-confirm').style.display = 'none';
  }
  function showBookingCancelConfirm() {
    $('bookings-list-view').style.display = 'none';
    $('booking-cancel-confirm').style.display = 'block';
  }

  // ── RENDER LIST ────────────────────────────────────────────────────────
  async function refreshList() {
    await fetchAddresses();
    renderList();
  }

  function formatAddressLines(a) {
    const line1 = [a.street_address, a.unit].filter(Boolean).join(', ');
    const line2 = [a.city, a.province, a.postal_code].filter(Boolean).join(' ').trim();
    return { line1, line2 };
  }

  function renderList() {
    const list = $('addr-list');
    const empty = $('addr-empty');
    if (!list) return;

    if (!cachedAddresses.length) {
      list.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    list.innerHTML = cachedAddresses.map(a => {
      const { line1, line2 } = formatAddressLines(a);
      const label = a.label || (a.is_default ? 'Default address' : 'Address');
      const defaultBadge = a.is_default
        ? '<span class="addr-default-badge">Default</span>' : '';
      const setDefaultBtn = a.is_default ? ''
        : `<button class="addr-card-btn" onclick="HirayaAccount.setDefault('${a.id}')">Set default</button>`;
      return `
        <div class="addr-card ${a.is_default ? 'is-default' : ''}" data-id="${a.id}">
          <div class="addr-card-main">
            <div class="addr-card-label">${escapeHtml(label)}${defaultBadge}</div>
            <div class="addr-card-body">${escapeHtml(line1)}<br>${escapeHtml(line2)}</div>
          </div>
          <div class="addr-card-actions">
            <button class="addr-card-btn" onclick="HirayaAccount.editAddress('${a.id}')">Edit</button>
            ${setDefaultBtn}
            <button class="addr-card-btn danger" onclick="HirayaAccount.askDelete('${a.id}')">Delete</button>
          </div>
        </div>`;
    }).join('');
  }

  // ── ADD / EDIT FORM ────────────────────────────────────────────────────
  function openAddressForm() {
    editingId = null;
    $('addr-form-title').textContent = 'Add an address';
    $('addr-form-sub').textContent = "Where would you like us to clean?";
    $('addr-label').value = '';
    $('addr-street').value = '';
    $('addr-unit').value = '';
    $('addr-city').value = '';
    $('addr-postal').value = '';
    $('addr-is-default').checked = cachedAddresses.length === 0; // first one defaults to default
    $('addr-form-err').style.display = 'none';
    showFormView();
    setTimeout(() => $('addr-street').focus(), 50);
  }

  function editAddress(id) {
    const a = cachedAddresses.find(x => x.id === id);
    if (!a) return;
    editingId = id;
    $('addr-form-title').textContent = 'Edit address';
    $('addr-form-sub').textContent = 'Update the details below.';
    $('addr-label').value = a.label || '';
    $('addr-street').value = a.street_address || '';
    $('addr-unit').value = a.unit || '';
    $('addr-city').value = a.city || '';
    $('addr-postal').value = a.postal_code || '';
    $('addr-is-default').checked = !!a.is_default;
    $('addr-form-err').style.display = 'none';
    showFormView();
  }

  function cancelAddressForm() {
    editingId = null;
    showListView();
  }

  function showFormError(msg) {
    const el = $('addr-form-err');
    el.textContent = msg;
    el.style.display = 'block';
  }

  async function saveAddressForm() {
    if (!sb()) { showToast('Not connected to the database.', 'error'); return; }
    const { data: { user } } = await sb().auth.getUser();
    if (!user) {
      showToast('Please log in to save addresses.', 'error');
      return;
    }

    const label = $('addr-label').value.trim();
    const street = $('addr-street').value.trim();
    const unit = $('addr-unit').value.trim();
    const city = $('addr-city').value.trim();
    const postalRaw = $('addr-postal').value.trim().toUpperCase();
    const setDefault = $('addr-is-default').checked;

    if (!street || !city || !postalRaw) {
      showFormError('Please fill in street address, city, and postal code.');
      return;
    }
    const postalRe = /^[A-Z]\d[A-Z][ -]?\d[A-Z]\d$/;
    if (!postalRe.test(postalRaw)) {
      showFormError('Please enter a valid Canadian postal code (e.g. N2L 3G1).');
      return;
    }
    const postal = postalRaw.replace(/[ -]/g, '').replace(/^(.{3})(.{3})$/, '$1 $2');

    const btn = $('addr-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    try {
      // If setting this as default, clear is_default on the user's other addresses first.
      if (setDefault) {
        const { error: clearErr } = await sb()
          .from('addresses')
          .update({ is_default: false })
          .eq('user_id', user.id)
          .neq('id', editingId || '00000000-0000-0000-0000-000000000000');
        if (clearErr) console.warn('clearing other defaults failed:', clearErr.message);
      }

      const payload = {
        label: label || null,
        street_address: street,
        unit: unit || null,
        city,
        province: 'ON',
        postal_code: postal,
        is_default: setDefault
      };

      if (editingId) {
        const { error } = await sb()
          .from('addresses')
          .update(payload)
          .eq('id', editingId)
          .eq('user_id', user.id);
        if (error) throw error;
        showToast('Address updated.', 'success');
      } else {
        payload.user_id = user.id;
        const { error } = await sb()
          .from('addresses')
          .insert(payload);
        if (error) throw error;
        showToast('Address saved.', 'success');
      }

      editingId = null;
      await refreshList();
      showListView();
    } catch (err) {
      console.error('Save address failed:', err);
      showFormError(err.message || 'Could not save the address. Please try again.');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Save address'; }
    }
  }

  // ── DELETE ──────────────────────────────────────────────────────────────
  function askDelete(id) {
    const a = cachedAddresses.find(x => x.id === id);
    if (!a) return;
    deletingId = id;
    const { line1 } = formatAddressLines(a);
    deletingLabel = a.label || line1;
    $('addr-confirm-text').textContent = deletingLabel;
    showConfirmDelete();
  }

  function cancelDelete() {
    deletingId = null;
    showListView();
  }

  async function confirmDelete() {
    if (!deletingId || !sb()) return;
    const { data: { user } } = await sb().auth.getUser();
    if (!user) return;

    const btn = $('addr-confirm-delete-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }

    try {
      const { error } = await sb()
        .from('addresses')
        .delete()
        .eq('id', deletingId)
        .eq('user_id', user.id);
      if (error) throw error;
      showToast('Address deleted.', 'success');
      deletingId = null;
      await refreshList();
      showListView();
    } catch (err) {
      console.error('Delete failed:', err);
      // If the address is referenced by a booking, the FK will prevent delete.
      const msg = /violates foreign key/i.test(err.message || '')
        ? "Can't delete — this address is linked to one of your bookings."
        : (err.message || 'Could not delete the address.');
      showToast(msg, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Yes, delete'; }
    }
  }

  // ── SET DEFAULT (from list view) ────────────────────────────────────────
  async function setDefault(id) {
    if (!sb()) return;
    const { data: { user } } = await sb().auth.getUser();
    if (!user) return;

    try {
      // Clear all defaults for this user, then set the chosen one.
      const { error: clearErr } = await sb()
        .from('addresses')
        .update({ is_default: false })
        .eq('user_id', user.id);
      if (clearErr) throw clearErr;

      const { error } = await sb()
        .from('addresses')
        .update({ is_default: true })
        .eq('id', id)
        .eq('user_id', user.id);
      if (error) throw error;

      showToast('Default address updated.', 'success');
      await refreshList();
    } catch (err) {
      console.error('setDefault failed:', err);
      showToast(err.message || 'Could not update default.', 'error');
    }
  }

  // ── BOOKINGS ───────────────────────────────────────────────────────────
  let cachedBookings = [];

  async function fetchBookings() {
    if (!sb()) { cachedBookings = []; return []; }
    const { data: { user } } = await sb().auth.getUser();
    if (!user) { cachedBookings = []; return []; }

    const { data, error } = await sb()
      .from('bookings')
      .select(`
        id, preferred_date, preferred_time_slot, status, estimated_price_cents, travel_fee_cents,
        created_at, customer_notes,
        services ( name, slug ),
        addresses ( street_address, unit, city, postal_code ),
        booking_addons ( quantity, price_cents, addons ( name, slug, price_cents ) )
      `)
      .eq('user_id', user.id)
      .order('preferred_date', { ascending: false, nullsFirst: false })
      .limit(50);

    if (error) {
      console.warn('fetchBookings failed:', error.message);
      cachedBookings = [];
    } else {
      cachedBookings = data || [];
    }
    return cachedBookings;
  }

  async function refreshBookings() {
    await fetchBookings();
    renderBookings();
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

  function isCancellable(b) {
    return !['cancelled', 'completed', 'no_show', 'in_progress'].includes(b.status);
  }

  function isUpcoming(b) {
    if (!b.preferred_date) return false;
    if (['cancelled', 'completed', 'no_show'].includes(b.status)) return false;
    // Compare dates ignoring time (preferred_date is a YYYY-MM-DD string)
    const today = new Date().toISOString().slice(0, 10);
    return b.preferred_date >= today;
  }

  function formatBookingDate(iso) {
    if (!iso) return 'Date TBD';
    // Render in user's locale; iso is YYYY-MM-DD so anchor to UTC noon to dodge TZ shifts
    const d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' });
  }

  function formatBookingAddress(addr) {
    if (!addr) return '';
    return [
      [addr.street_address, addr.unit].filter(Boolean).join(', '),
      [addr.city, addr.postal_code].filter(Boolean).join(' '),
    ].filter(Boolean).join(' · ');
  }

  function renderBookings() {
    const list = $('bookings-list');
    const empty = $('bookings-empty');
    if (!list) return;

    if (!cachedBookings.length) {
      list.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    list.innerHTML = cachedBookings.map(b => {
      const svcName = b.services?.name || 'Cleaning service';
      const dateStr = formatBookingDate(b.preferred_date);
      const timeStr = b.preferred_time_slot ? ` at ${escapeHtml(b.preferred_time_slot)}` : '';
      const addrLine = formatBookingAddress(b.addresses);
      const total = b.estimated_price_cents != null
        ? '$' + Math.round(b.estimated_price_cents / 100)
        : 'Quote on request';
      const addonItems = (b.booking_addons || [])
        .map(ba => ba.addons ? { name: ba.addons.name, price_cents: ba.addons.price_cents } : null)
        .filter(Boolean);
      const addonsSumCents = addonItems.reduce((s, a) => s + (a.price_cents || 0), 0);
      // The stored total includes the per-visit travel fee, so it has to come
      // off here too — otherwise the SERVICE shows $25-50 more than it is.
      const travelCents = b.travel_fee_cents || 0;
      const svcPriceCents = (b.estimated_price_cents != null) ? Math.max(0, b.estimated_price_cents - addonsSumCents - travelCents) : null;
      const svcPriceStr = (svcPriceCents != null && svcPriceCents > 0) ? `$${Math.round(svcPriceCents / 100)}` : '';
      const classes = ['booking-card'];
      if (isUpcoming(b)) classes.push('is-upcoming');
      if (b.status === 'cancelled') classes.push('is-cancelled');
      const actions = isCancellable(b)
        ? `<div class="booking-card-actions"><button class="booking-card-btn" onclick="HirayaAccount.askCancelBooking('${b.id}')">Cancel booking</button></div>`
        : '';
      return `
        <div class="${classes.join(' ')}" data-id="${b.id}">
          <div class="booking-card-head">
            <div>
              <div class="booking-card-date">${escapeHtml(dateStr)}${timeStr}</div>
              <div class="booking-card-svc">${escapeHtml(svcName)}${svcPriceStr ? ` — <strong>${svcPriceStr}</strong>` : ''}</div>
              ${addonItems.length ? `<div class="booking-card-addons">${addonItems.map(a => `<div>✨ ${escapeHtml(a.name)}${a.price_cents != null ? ` — <strong>$${Math.round(a.price_cents / 100)}</strong>` : ''}</div>`).join('')}</div>` : ''}
              <span class="booking-status ${escapeHtml(b.status || 'pending_review')}">${escapeHtml(statusLabel(b.status))}</span>
            </div>
          </div>
          <div class="booking-card-body">
            ${addrLine ? `<div>📍 ${escapeHtml(addrLine)}</div>` : ''}
            <div><strong>${escapeHtml(total)}</strong> · Ref ${b.id.slice(0, 8).toUpperCase()}</div>
          </div>
          ${actions}
        </div>`;
    }).join('');
  }

  function askCancelBooking(id) {
    const b = cachedBookings.find(x => x.id === id);
    if (!b) return;
    cancellingBookingId = id;
    const svcName = b.services?.name || 'this booking';
    cancellingBookingLabel = `${svcName} on ${formatBookingDate(b.preferred_date)}`;
    $('booking-cancel-text').textContent = cancellingBookingLabel;
    showBookingCancelConfirm();
  }

  function cancelCancelBooking() {
    cancellingBookingId = null;
    showBookingsListView();
  }

  async function confirmCancelBooking() {
    if (!cancellingBookingId || !sb()) return;
    const cancelledId = cancellingBookingId;
    const btn = $('booking-cancel-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Cancelling…'; }
    try {
      const { data, error } = await sb().rpc('cancel_booking', { booking_id: cancelledId });
      if (error) throw error;
      if (data === false) {
        showToast("Couldn't cancel — booking may already be completed.", 'error');
      } else {
        showToast('Booking cancelled.', 'success');
        // Fire-and-forget: tell the edge function to send cancellation emails
        // and delete the linked calendar event. Booking is already cancelled
        // in the DB, so we don't block the UI on this.
        sb().functions.invoke('send-booking-email', {
          body: { booking_id: cancelledId, mode: 'cancelled' }
        }).then(({ error: emailErr }) => {
          if (emailErr) console.warn('cancellation notification failed:', emailErr.message || emailErr);
        }).catch(err => console.warn('cancellation notification failed:', err));
      }
      cancellingBookingId = null;
      await refreshBookings();
      showBookingsListView();
    } catch (err) {
      console.error('cancel_booking failed:', err);
      const msg = err?.message || String(err);
      if (/within_24h/i.test(msg)) {
        showToast("Bookings can't be cancelled within 24 hours of the service. Reply to your booking email or call (226) 751-4566 and we'll work something out.", 'error');
      } else {
        showToast(msg || 'Could not cancel the booking.', 'error');
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Yes, cancel'; }
    }
  }


  // ── INIT ────────────────────────────────────────────────────────────────
  function wire() {
    const modal = $('addresses-modal');
    if (modal) {
      modal.addEventListener('click', function (e) {
        if (e.target === modal) closeAddresses();
      });
    }
    // Refresh cache whenever auth state changes so the booking form's
    // saved-address picker can react.
    if (sb()) {
      // Page-load check — onAuthStateChange doesn't fire if the user was
      // already signed in from a previous session, so we need to seed the
      // owner flag (and the nav dropdown's Admin item) explicitly.
      refreshOwnerStatus();

      sb().auth.onAuthStateChange((event) => {
        if (event === 'SIGNED_IN' || event === 'USER_UPDATED') {
          fetchAddresses();
          refreshOwnerStatus();
        } else if (event === 'SIGNED_OUT') {
          cachedAddresses = [];
          cachedBookings = [];
          isOwner = false;
          notifyListeners();
        }
      });
    }
  }

  // ── EXPORTS ────────────────────────────────────────────────────────────
  window.HirayaAccount = {
    openAddresses,
    openBookings,
    openAccount,
    switchTab,
    closeAddresses,
    openAddressForm,
    cancelAddressForm,
    saveAddressForm,
    editAddress,
    askDelete,
    cancelDelete,
    confirmDelete,
    setDefault,
    // Bookings tab
    askCancelBooking,
    cancelCancelBooking,
    confirmCancelBooking,
    refreshBookings,
    // For booking.js to read the saved list and react to changes
    fetchAddresses,
    getCachedAddresses,
    onAddressesChanged
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
