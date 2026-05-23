(function () {
  'use strict';

  // ── PAGE → DB SLUG MAPS ────────────────────────────────────────────────
  // Page services use ids like 'standard', 'deep'. The DB has tiered services
  // like 'regular-1br'. Pick the cheapest/starting tier so the page's "From $X"
  // matches the DB's starting_price_cents.
  const SERVICE_SLUG_MAP = {
    standard:   'regular-1br',
    deep:       'deep-small',
    moveinout:  'movein-apt',
    carpet:     'carpet-single-room',
    upholstery: 'loveseat',
    commercial: 'commercial-cleaning'
  };
  const ADDON_SLUG_MAP = {
    oven:     'inside-oven',
    fridge:   'inside-fridge',
    windows:  'interior-windows',
    laundry:  'laundry-folding',
    pets:     'pet-hair-removal',
    walls:    'wall-spot-cleaning',
    basement: 'basement-cleaning',
    eco:      'eco-friendly'
  };

  const PENDING_KEY = 'hiraya:pendingBooking';
  const PENDING_TTL_MS = 30 * 60 * 1000; // 30 min — drop stale pending bookings

  function $(id) { return document.getElementById(id); }
  function sb() { return window.hirayaSupabase; }

  function fmt(cents) {
    if (cents == null) return 'Quote on request';
    return '$' + (Number(cents) / 100).toFixed(0);
  }
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

  // ── COLLECT BOOKING FROM PAGE STATE ────────────────────────────────────
  // SERVICES, ADDONS, MONTHS, selSvc, selAddons, selDay, selTime, calM, calY
  // are declared with let/const in index.html's inline <script> — accessible
  // here by bare name via shared global lexical scope.
  function gatherBooking() {
    const name = $('f-name').value.trim();
    const phone = $('f-phone').value.trim();
    const email = $('f-email').value.trim().toLowerCase();
    const addr = $('f-addr').value.trim();

    if (!name || !phone || !email || !addr) {
      return { error: 'Please fill in your name, phone, email, and address.' };
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { error: 'Please enter a valid email address.' };
    }
    if (typeof selSvc === 'undefined' || !selSvc) {
      return { error: 'Please choose a service before booking.' };
    }
    if (typeof selDay === 'undefined' || !selDay || !selTime) {
      return { error: 'Please pick a date and time on the calendar.' };
    }

    const svc = SERVICES.find(s => s.id === selSvc);
    const addons = selAddons
      .map(id => ADDONS.find(a => a.id === id))
      .filter(Boolean);

    const dbServiceSlug = SERVICE_SLUG_MAP[selSvc];
    const dbAddonSlugs = selAddons
      .map(id => ADDON_SLUG_MAP[id])
      .filter(Boolean);

    if (!dbServiceSlug) {
      return { error: 'This service is not available in our catalog yet. Please pick another.' };
    }

    const basePrice = svc?.basePrice || 0;
    const addonTotal = addons.reduce((s, a) => s + (a.addonPrice || 0), 0);
    const total = basePrice + addonTotal;

    const dateLabel = `${MONTHS[calM]} ${selDay}, ${calY}`;
    const isoDate = new Date(calY, calM, selDay).toISOString().slice(0, 10);

    return {
      form: {
        customer_name: name,
        customer_email: email,
        customer_phone: phone,
        customer_address: addr,
        service_id_page: selSvc,
        service_name: svc?.name || 'General Clean',
        addon_ids_page: selAddons.slice(),
        preferred_date: isoDate,
        preferred_time_slot: selTime,
        dbServiceSlug,
        dbAddonSlugs,
        estimated_total_dollars: total
      },
      display: {
        dateLabel,
        serviceIcon: svc?.icon || '🧹',
        basePrice,
        addonTotal,
        addons // each has {id, name, addonPrice}
      }
    };
  }

  // ── REVIEW MODAL ────────────────────────────────────────────────────────
  let pendingBooking = null;

  function openReview() {
    const result = gatherBooking();
    if (result.error) { showToast(result.error, 'error'); return; }
    pendingBooking = result;
    populateReviewModal(result);
    $('booking-review-modal').classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function populateReviewModal(result) {
    const f = result.form;
    const d = result.display;

    $('br-service-icon').textContent = d.serviceIcon;
    $('br-service-name').textContent = f.service_name;
    $('br-date').textContent = `${d.dateLabel} at ${f.preferred_time_slot}`;
    $('br-name').textContent = f.customer_name;
    $('br-email').textContent = f.customer_email;
    $('br-phone').textContent = f.customer_phone;
    $('br-addr').textContent = f.customer_address;

    const addonsHtml = d.addons.length
      ? d.addons.map(a => `<div class="br-line"><span>${escapeHtml(a.name)}</span><span>${a.addonPrice ? '$' + a.addonPrice : 'On request'}</span></div>`).join('')
      : '<div class="br-line br-muted"><span>No add-ons</span><span>—</span></div>';
    $('br-addons').innerHTML = addonsHtml;

    $('br-base').textContent = d.basePrice ? '$' + d.basePrice : 'Quote on request';
    $('br-addon-total').textContent = d.addonTotal ? '$' + d.addonTotal : '$0';
    $('br-total').textContent = f.estimated_total_dollars ? '$' + f.estimated_total_dollars : 'Quote on request';
  }

  function closeReview() {
    $('booking-review-modal').classList.remove('open');
    document.body.style.overflow = '';
  }

  // ── CONFIRMATION MODAL ──────────────────────────────────────────────────
  function openConfirmation(booking, display) {
    const m = $('booking-confirm-modal');
    $('bc-id').textContent = booking.id ? String(booking.id).slice(0, 8).toUpperCase() : 'PENDING';
    $('bc-service').textContent = display.serviceName;
    $('bc-date').textContent = display.dateLabel;
    $('bc-total').textContent = fmt(booking.estimated_price_cents);
    $('bc-email').textContent = display.customerEmail;

    // Always logged-in now (booking requires auth) — hide the create-account CTA
    const signupBlock = $('bc-signup-block');
    if (signupBlock) signupBlock.style.display = 'none';

    m.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeConfirmation() {
    $('booking-confirm-modal').classList.remove('open');
    document.body.style.overflow = '';
  }

  // ── PERSIST PENDING BOOKING ACROSS EMAIL-CONFIRMATION REDIRECT ─────────
  function savePendingForAuth(result) {
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify({
        result,
        savedAt: Date.now()
      }));
    } catch (e) { /* localStorage might be unavailable */ }
  }

  function loadPendingForAuth() {
    try {
      const raw = localStorage.getItem(PENDING_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (Date.now() - parsed.savedAt > PENDING_TTL_MS) {
        localStorage.removeItem(PENDING_KEY);
        return null;
      }
      return parsed.result;
    } catch (e) { return null; }
  }

  function clearPendingForAuth() {
    try { localStorage.removeItem(PENDING_KEY); } catch (e) {}
  }

  // ── SUBMIT ──────────────────────────────────────────────────────────────
  async function confirmAndSubmit() {
    if (!pendingBooking) return;
    if (!sb()) {
      showToast('Booking system is not configured yet.', 'error');
      return;
    }

    const { data: { user } } = await sb().auth.getUser();

    if (!user) {
      // Not logged in → save the pending booking and prompt signup
      savePendingForAuth(pendingBooking);
      closeReview();

      const f = pendingBooking.form;
      // Pre-fill the signup form with what they typed in the booking form
      const suName = $('su-name'); if (suName) suName.value = f.customer_name;
      const suEmail = $('su-email'); if (suEmail) suEmail.value = f.customer_email;
      const suPhone = $('su-phone'); if (suPhone) suPhone.value = f.customer_phone;

      if (window.HirayaAuth) {
        window.HirayaAuth.openAuthModal('signup');
      }
      showToast('Create an account or log in to confirm your booking.', 'success');
      return;
    }

    await saveBookingFor(user, pendingBooking);
  }

  async function saveBookingFor(user, bookingData) {
    const btn = $('br-submit');
    if (btn) { btn.disabled = true; btn.textContent = 'Booking…'; }

    const f = bookingData.form;
    const d = bookingData.display;

    try {
      // 1. Look up service id + price from DB
      const { data: svcRow, error: svcErr } = await sb()
        .from('services')
        .select('id, name, starting_price_cents, requires_quote')
        .eq('slug', f.dbServiceSlug)
        .single();
      if (svcErr || !svcRow) {
        throw new Error('Service not found in catalog. Has the database schema been set up?');
      }

      // 2. Look up addon ids + prices (batch)
      let addonRows = [];
      if (f.dbAddonSlugs.length) {
        const { data, error } = await sb()
          .from('addons')
          .select('id, slug, name, price_cents')
          .in('slug', f.dbAddonSlugs);
        if (error) throw error;
        addonRows = data || [];
      }

      // 3. Best-effort address insert. If the addresses schema rejects (e.g. NOT NULL postal_code),
      //    fall back to a null address_id and stash the address text in customer_notes.
      let addressId = null;
      const { data: addrRow, error: addrErr } = await sb()
        .from('addresses')
        .insert({
          user_id: user.id,
          label: 'Booking address',
          street_address: f.customer_address,
          city: 'Waterloo',
          province: 'ON'
        })
        .select()
        .single();
      if (!addrErr && addrRow) {
        addressId = addrRow.id;
      } else if (addrErr) {
        console.warn('addresses insert skipped:', addrErr.message);
      }

      // 4. Calculate estimated total in cents (service + addons)
      const totalCents = (svcRow.starting_price_cents || 0)
        + addonRows.reduce((s, a) => s + (a.price_cents || 0), 0);

      // 5. Insert booking row
      const notesParts = [];
      notesParts.push(`Name: ${f.customer_name}`);
      notesParts.push(`Phone: ${f.customer_phone}`);
      if (!addressId) notesParts.push(`Address: ${f.customer_address}`);
      const customerNotes = notesParts.join(' · ');

      const status = svcRow.requires_quote ? 'awaiting_quote' : 'pending_review';

      const { data: bookingRow, error: bkErr } = await sb()
        .from('bookings')
        .insert({
          user_id: user.id,
          service_id: svcRow.id,
          address_id: addressId,
          preferred_date: f.preferred_date,
          preferred_time_slot: f.preferred_time_slot,
          estimated_price_cents: svcRow.requires_quote ? null : totalCents,
          status,
          customer_notes: customerNotes
        })
        .select()
        .single();
      if (bkErr) throw bkErr;

      // 6. Insert booking_addons rows (best effort — booking is already saved)
      if (addonRows.length) {
        const addonsToInsert = addonRows.map(a => ({
          booking_id: bookingRow.id,
          addon_id: a.id,
          quantity: 1,
          price_cents: a.price_cents
        }));
        const { error: bkAddonErr } = await sb()
          .from('booking_addons')
          .insert(addonsToInsert);
        if (bkAddonErr) console.warn('booking_addons insert failed:', bkAddonErr.message);
      }

      // 7. Show confirmation modal
      closeReview();
      openConfirmation(bookingRow, {
        dateLabel: `${d.dateLabel} at ${f.preferred_time_slot}`,
        serviceName: svcRow.name,
        customerEmail: f.customer_email
      });

      // 8. Fire-and-forget confirmation email
      sb().functions.invoke('send-booking-email', { body: { booking_id: bookingRow.id } })
        .then(({ error: emailErr }) => {
          if (emailErr) console.warn('Booking saved, email failed:', emailErr.message || emailErr);
        })
        .catch(err => console.warn('Booking saved, email failed:', err));

      pendingBooking = null;
      clearPendingForAuth();
    } catch (err) {
      console.error('Booking failed:', err);
      const msg = (err && err.message) || 'Could not save booking. Please try again.';
      showToast(msg, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Confirm booking'; }
    }
  }

  // After login/signup completes, resume any pending booking
  function wireAuthResume() {
    if (!sb()) return;
    sb().auth.onAuthStateChange(async (event, session) => {
      if (event !== 'SIGNED_IN' || !session?.user) return;
      const pending = loadPendingForAuth();
      if (!pending) return;
      // Re-open review modal with the saved data so the user sees what's about to save
      pendingBooking = pending;
      populateReviewModal(pending);
      await saveBookingFor(session.user, pending);
    });
  }

  function promptSignup() {
    closeConfirmation();
    if (window.HirayaAuth) window.HirayaAuth.openAuthModal('signup');
  }

  // ── EXPORTS ─────────────────────────────────────────────────────────────
  window.HirayaBooking = {
    openReview,
    closeReview,
    confirmAndSubmit,
    closeConfirmation,
    promptSignup
  };

  // Boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireAuthResume);
  } else {
    wireAuthResume();
  }
})();
