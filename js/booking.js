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
    oven:               'inside-oven',
    fridge:             'inside-fridge',
    'windows-small':    'windows-small',
    'windows-standard': 'windows-standard',
    'windows-large':    'windows-large',
    laundry:            'laundry-folding',
    pets:               'pet-hair-removal',
    walls:              'wall-spot-cleaning',
    basement:           'basement-cleaning',
    cupboards:          'inside-cupboards',
    balcony:            'balcony-tidy',
    eco:                'eco-friendly'
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
    const street = $('f-street').value.trim();
    const unit = $('f-unit').value.trim();
    const city = $('f-city').value.trim();
    const postal = $('f-postal').value.trim().toUpperCase();
    const savedAddrSel = $('f-saved-addr');
    const savedAddressId = (savedAddrSel && savedAddrSel.value && savedAddrSel.value !== '__new__')
      ? savedAddrSel.value : null;
    const saveCheckbox = $('f-save-addr');
    const saveToAccount = !!(saveCheckbox && saveCheckbox.checked && saveCheckbox.offsetParent !== null);

    if (!name || !phone || !email) {
      return { error: 'Please fill in your name, phone, and email.' };
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { error: 'Please enter a valid email address.' };
    }
    if (!savedAddressId) {
      if (!street || !city || !postal) {
        return { error: 'Please fill in street, city, and postal code.' };
      }
      // Canadian postal: A1A 1A1 (space optional)
      const postalRe = /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/;
      if (!postalRe.test(postal)) {
        return { error: 'Please enter a valid Canadian postal code (e.g. N2L 3G1).' };
      }
    }
    // Multi-service: pull every chosen tier from the page. Hourly returns a
    // single virtual line. getSelectedServiceLines is defined in index.html.
    const svcLines = (typeof getSelectedServiceLines === 'function')
      ? getSelectedServiceLines()
      : (selSvc && selTier ? [{ svc: SERVICES.find(s => s.id === selSvc) || { id: selSvc, name: 'Service', icon: '🧹' }, tier: selTier }] : []);
    if (!svcLines.length) {
      if (!selSvc && (!selSvcs || !selSvcs.size)) {
        return { error: 'Please choose a service before booking.' };
      }
      return { error: 'Please pick a specific option for each selected service.' };
    }
    if (typeof selDay === 'undefined' || !selDay || !selTime) {
      return { error: 'Please pick a date and time on the calendar.' };
    }

    // Normalize postal to "A1A 1A1" with single space
    const normalizedPostal = postal.replace(/[ -]/g, '').replace(/^(.{3})(.{3})$/, '$1 $2');
    const addrDisplay = savedAddressId
      ? savedAddrSel.options[savedAddrSel.selectedIndex].dataset.full || savedAddrSel.options[savedAddrSel.selectedIndex].textContent
      : [street, unit, city, normalizedPostal].filter(Boolean).join(', ');

    // Primary service line = the first one picked. Backwards-compat for the
    // bookings.service_id column and any code that still expects a single svc.
    const primary = svcLines[0];
    const svc = primary.svc;
    const addons = selAddons
      .map(id => ADDONS.find(a => a.id === id))
      .filter(Boolean);

    // The tier's slug is the authoritative DB service identifier.
    const dbServiceSlug = primary.tier.slug;
    const dbAddonSlugs = selAddons
      .map(id => ADDON_SLUG_MAP[id])
      .filter(Boolean);

    if (!dbServiceSlug) {
      return { error: 'This service is not available in our catalog yet. Please pick another.' };
    }

    // Every selected service line, ready to insert into booking_services for
    // all-but-the-primary. Carries enough to render rich invoice/email lines
    // without re-joining the services table.
    const extraServiceLines = svcLines.slice(1).map(l => ({
      slug: l.tier.slug,
      tier_name: l.tier.name,
      price_cents: Math.round((l.tier.basePrice || 0) * 100),
      duration_minutes: l.tier.durationMin || null,
      display_name: `${l.svc.name} — ${l.tier.name}`,
    }));

    // Per-addon quantities (windows, fridge, laundry, etc). Multiplied into
    // the line totals and passed through to booking_addons.quantity.
    const addonQtyOf = (id) => {
      if (typeof addonQtys !== 'undefined' && addonQtys?.get) {
        const v = addonQtys.get(id);
        return Number.isFinite(v) && v > 0 ? v : 1;
      }
      return 1;
    };
    const basePrice = svcLines.reduce((sum, l) => sum + (l.tier.basePrice || 0), 0);
    const addonTotal = addons.reduce((s, a) => s + ((a.addonPrice || 0) * addonQtyOf(a.id)), 0);
    const subtotal = basePrice + addonTotal;

    // Recurring discount (matches the FREQUENCY_DISCOUNTS map in index.html).
    // Discount only kicks in on the customer's SECOND booking onward — the
    // server-side count happens in saveBookingFor. Here we send the FULL
    // price; the server may apply the discount on save if priors > 0.
    const frequencyEl = $('f-frequency');
    const frequency = frequencyEl ? frequencyEl.value : 'one_time';
    const discountPct = ({ one_time: 0, weekly: 20, biweekly: 15, monthly: 10 })[frequency] || 0;
    const discountAmount = 0;
    const total = subtotal;

    // Entry method — defaults to "home" so customers who skip the picker
    // (e.g. on an older cached page load) don't break submission.
    const entryMethod = ($('f-entry-method')?.value || 'home').trim();
    const entryInstructions = ($('f-entry-instructions')?.value || '').trim();

    const dateLabel = `${MONTHS[calM]} ${selDay}, ${calY}`;
    const isoDate = new Date(calY, calM, selDay).toISOString().slice(0, 10);

    // Combined service name for the bookings row + email summaries. Joins
    // all selected services so the admin card / customer email show the
    // full scope at a glance ("Regular Cleaning — 2BR/2BA · Sofa · Carpet
    // Living Room").
    const combinedServiceName = svcLines
      .map(l => `${l.svc.name} — ${l.tier.name}`)
      .join(' · ');

    return {
      form: {
        customer_name: name,
        customer_email: email,
        customer_phone: phone,
        customer_address: addrDisplay,
        // Structured address parts — populated only when entering a new address.
        // When savedAddressId is set, address_id alone is used and these are ignored.
        address_parts: savedAddressId ? null : {
          street_address: street,
          unit: unit || null,
          city,
          postal_code: normalizedPostal
        },
        saved_address_id: savedAddressId,
        save_to_account: saveToAccount,
        service_id_page: svc.id,
        service_name: combinedServiceName,
        addon_ids_page: selAddons.slice(),
        // {addonId: quantity} so booking_addons rows carry the right counts.
        addon_qty_map: Object.fromEntries(selAddons.map(id => [id, addonQtyOf(id)])),
        preferred_date: isoDate,
        preferred_time_slot: selTime,
        dbServiceSlug,
        dbAddonSlugs,
        // All non-primary service lines — booking.js inserts these into
        // booking_services after the bookings row is created.
        extraServiceLines,
        estimated_total_dollars: total,
        // New: entry method + frequency
        entry_method: entryMethod,
        entry_instructions: entryInstructions || null,
        frequency,
        recurring_discount_pct: discountPct,
      },
      display: {
        dateLabel,
        serviceIcon: svc?.icon || '🧹',
        basePrice,
        addonTotal,
        addons, // each has {id, name, addonPrice}
        discountPct,
        discountAmount,
        frequency,
        // Per-service lines for the review modal: each entry is the same
        // shape getSelectedServiceLines returns.
        svcLines,
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
    // Fresh booking attempt → reset the in-flight guard + restore the button
    // so the user can submit. (After a prior successful booking we leave them
    // disabled to block double-submits.)
    submittingInFlight = false;
    const submitBtn = $('br-submit');
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Confirm booking'; }
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
      : '';
    $('br-addons').innerHTML = addonsHtml;

    // One line per selected service in the total box. d.svcLines is the
    // array of { svc, tier } from getSelectedServiceLines(). Falls back to
    // a single-line render if the page didn't supply it (defensive).
    const svcLinesEl = $('br-svc-lines');
    if (svcLinesEl) {
      const lines = (d.svcLines && d.svcLines.length)
        ? d.svcLines.map(({ svc, tier }) => ({
            label: `${svc.icon || ''} ${tier.name}`.trim(),
            price: tier.basePrice != null ? '$' + tier.basePrice : 'Quote',
          }))
        : [{ label: 'Service', price: d.basePrice ? '$' + d.basePrice : 'Quote on request' }];
      svcLinesEl.innerHTML = lines
        .map(l => `<div class="br-line"><span>${escapeHtml(l.label)}</span><span>${escapeHtml(l.price)}</span></div>`)
        .join('');
    }

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
  let submittingInFlight = false;
  async function confirmAndSubmit() {
    if (submittingInFlight) return;
    if (!pendingBooking) return;
    if (!sb()) {
      showToast('Booking system is not configured yet.', 'error');
      return;
    }

    // Look up the current user FIRST. We only flip submittingInFlight once
    // we know we're going to actually save — previously, an exception or
    // a not-logged-in branch could leave the flag stuck at true, which made
    // every subsequent "Confirm booking" tap a no-op.
    let user = null;
    try {
      const { data } = await sb().auth.getUser();
      user = data?.user || null;
    } catch (e) {
      console.error('auth.getUser failed:', e);
      showToast('Could not check your session. Please try again.', 'error');
      return;
    }

    if (!user) {
      // Not logged in → save the pending booking and prompt signup.
      // Force-save the address to their new account on resume — they just
      // created the account, it'd be weird NOT to remember their address.
      if (pendingBooking.form.address_parts) {
        pendingBooking.form.save_to_account = true;
      }
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

    // Now we're committed to saving — set the in-flight guard and go.
    submittingInFlight = true;
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

      // 3. Resolve the address:
      //    a) Saved address picked → use its id directly, no insert.
      //    b) New address + "save to account" checked → insert into addresses table.
      //    c) New address + checkbox unchecked → don't pollute saved list; null address_id
      //       and the address goes into customer_notes for the cleaner to see.
      let addressId = null;
      if (f.saved_address_id) {
        addressId = f.saved_address_id;
      } else if (f.save_to_account && f.address_parts) {
        const p = f.address_parts;
        const { data: addrRow, error: addrErr } = await sb()
          .from('addresses')
          .insert({
            user_id: user.id,
            label: p.unit ? `${p.street_address}, ${p.unit}` : p.street_address,
            street_address: p.street_address,
            unit: p.unit,
            city: p.city,
            province: 'ON',
            postal_code: p.postal_code
          })
          .select()
          .single();
        if (!addrErr && addrRow) {
          addressId = addrRow.id;
        } else if (addrErr) {
          console.warn('addresses insert failed:', addrErr.message);
        }
      }

      // 4. Calculate estimated total in cents.
      // Prefer the client-side total (already includes all selected services,
      // addons, and any recurring discount). Fall back to primary + addons
      // only if the client total is missing for some reason.
      let clientTotalCents = (typeof f.estimated_total_dollars === 'number')
        ? Math.round(f.estimated_total_dollars * 100)
        : null;

      // Recurring discount policy: 20%/15%/10% only applies starting with
      // the customer's SECOND booking. The client sends full price; here
      // we check prior bookings and apply the discount if eligible.
      let appliedDiscountPct = 0;
      const declaredPct = f.recurring_discount_pct || 0;
      if (declaredPct > 0) {
        try {
          const { count: priorCount } = await sb()
            .from('bookings')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', user.id);
          if (priorCount && priorCount > 0) {
            // 2nd+ booking on a recurring schedule — apply the discount.
            appliedDiscountPct = declaredPct;
            if (clientTotalCents != null) {
              clientTotalCents = Math.round(clientTotalCents * (1 - declaredPct / 100));
            }
          }
        } catch (countErr) {
          console.warn('prior booking count failed:', countErr.message || countErr);
        }
      }

      const totalCents = clientTotalCents ?? (
        (svcRow.starting_price_cents || 0)
        + addonRows.reduce((s, a) => s + (a.price_cents || 0), 0)
      );

      // 5. Insert booking row.
      // customer_notes is reserved for actual notes the customer types in
      // the booking flow. Until that input exists, leave it null — the
      // cleaner sees name/phone/address via the joined customer + address
      // columns on the admin dashboard.
      const customerNotes = (f.customer_notes && f.customer_notes.trim()) || null;

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
          customer_notes: customerNotes,
          entry_method: f.entry_method || 'home',
          entry_instructions: f.entry_instructions || null,
          frequency: f.frequency || 'one_time',
          recurring_discount_pct: appliedDiscountPct,
        })
        .select()
        .single();
      if (bkErr) throw bkErr;

      // 6. Insert booking_addons rows (best effort — booking is already saved)
      if (addonRows.length) {
        // Map slug → page id so we can look up quantities per row.
        const slugToPageId = Object.fromEntries(
          Object.entries(ADDON_SLUG_MAP || {}).map(([k, v]) => [v, k])
        );
        const qtyMap = f.addon_qty_map || {};
        const addonsToInsert = addonRows.map(a => {
          const pageId = slugToPageId[a.slug];
          const qty = (pageId && qtyMap[pageId]) ? qtyMap[pageId] : 1;
          return {
            booking_id: bookingRow.id,
            addon_id: a.id,
            quantity: qty,
            price_cents: a.price_cents,
          };
        });
        const { error: bkAddonErr } = await sb()
          .from('booking_addons')
          .insert(addonsToInsert);
        if (bkAddonErr) console.warn('booking_addons insert failed:', bkAddonErr.message);
      }

      // 6b. Insert booking_services rows for any extra services the customer
      // picked beyond the primary one (e.g. Regular + Carpet + Sofa).
      const extras = Array.isArray(f.extraServiceLines) ? f.extraServiceLines : [];
      if (extras.length) {
        const extraSlugs = extras.map(e => e.slug).filter(Boolean);
        const { data: extraSvcRows, error: extraLookupErr } = await sb()
          .from('services')
          .select('id, slug')
          .in('slug', extraSlugs);
        if (extraLookupErr) {
          console.warn('extra services lookup failed:', extraLookupErr.message);
        } else if (extraSvcRows?.length) {
          const slugToId = new Map(extraSvcRows.map(r => [r.slug, r.id]));
          const toInsert = extras
            .filter(e => slugToId.has(e.slug))
            .map(e => ({
              booking_id: bookingRow.id,
              service_id: slugToId.get(e.slug),
              tier_slug: e.slug,
              tier_name: e.tier_name,
              price_cents: e.price_cents,
              duration_minutes: e.duration_minutes,
              quantity: 1,
            }));
          if (toInsert.length) {
            const { error: bsErr } = await sb().from('booking_services').insert(toInsert);
            if (bsErr) console.warn('booking_services insert failed:', bsErr.message);
          }
        }
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

      // If we just saved a new address to the user's account, refresh the
      // picker so it's there on their next booking.
      if (f.save_to_account && f.address_parts && window.HirayaAccount) {
        window.HirayaAccount.fetchAddresses();
      }
      // Success path: leave the submit button disabled — the review modal is
      // closed and the confirmation modal is showing. Re-enabling would let
      // a stuck/scrolled-off modal turn into a 7x duplicate-submission.
      if (btn) btn.textContent = 'Booked ✓';
    } catch (err) {
      console.error('Booking failed:', err);
      const msg = (err && err.message) || 'Could not save booking. Please try again.';
      showToast(msg, 'error');
      // Only re-enable on real failure so the customer can correct & retry.
      if (btn) { btn.disabled = false; btn.textContent = 'Confirm booking'; }
      submittingInFlight = false;
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

  // ── SAVED-ADDRESS PICKER (booking form) ────────────────────────────────
  // Tracks whether a user is logged in so we know whether to show the
  // "Save this address to my account" checkbox alongside new-address entry.
  let isLoggedIn = false;

  function formatAddrShort(a) {
    return [a.street_address, a.unit].filter(Boolean).join(', ');
  }
  function formatAddrFull(a) {
    const line1 = [a.street_address, a.unit].filter(Boolean).join(', ');
    const line2 = [a.city, a.province, a.postal_code].filter(Boolean).join(' ').trim();
    return line1 + ', ' + line2;
  }

  function setAddressFieldsLocked(locked) {
    ['f-street', 'f-unit', 'f-city', 'f-postal'].forEach(function (id) {
      const el = $(id);
      if (!el) return;
      el.readOnly = locked;
      el.classList.toggle('locked', locked);
    });
  }

  function updateSaveCheckboxVisibility() {
    const saveGroup = $('f-save-addr-group');
    if (!saveGroup) return;
    const select = $('f-saved-addr');
    const pickingSaved = select && select.value && select.value !== '__new__';
    saveGroup.style.display = (isLoggedIn && !pickingSaved) ? '' : 'none';
  }

  function applySavedAddressSelection() {
    const select = $('f-saved-addr');
    if (!select) return;
    const id = select.value;
    if (id && id !== '__new__' && window.HirayaAccount) {
      const addr = window.HirayaAccount.getCachedAddresses().find(a => a.id === id);
      if (addr) {
        $('f-street').value = addr.street_address || '';
        $('f-unit').value = addr.unit || '';
        $('f-city').value = addr.city || '';
        $('f-postal').value = addr.postal_code || '';
        setAddressFieldsLocked(true);
      }
    } else {
      // "Enter a different address" — unlock and clear so the user can type.
      $('f-street').value = '';
      $('f-unit').value = '';
      $('f-city').value = '';
      $('f-postal').value = '';
      setAddressFieldsLocked(false);
      setTimeout(() => { const s = $('f-street'); if (s) s.focus(); }, 30);
    }
    updateSaveCheckboxVisibility();
  }

  function refreshSavedAddressPicker(addresses) {
    const group = $('f-saved-addr-group');
    const select = $('f-saved-addr');
    if (!group || !select) return;
    const list = addresses || (window.HirayaAccount ? window.HirayaAccount.getCachedAddresses() : []);

    if (isLoggedIn && list.length > 0) {
      const previousValue = select.value; // preserve selection across re-renders
      const defaultAddr = list.find(a => a.is_default) || list[0];
      let html = '';
      list.forEach(function (a) {
        const label = a.label || formatAddrShort(a);
        const isSelected = (previousValue === a.id) || (!previousValue && a === defaultAddr);
        html += '<option value="' + a.id + '" data-full="' + escapeHtml(formatAddrFull(a)) + '"'
              + (isSelected ? ' selected' : '') + '>'
              + escapeHtml(label) + ' — ' + escapeHtml(formatAddrShort(a))
              + '</option>';
      });
      html += '<option value="__new__"' + (previousValue === '__new__' ? ' selected' : '') + '>+ Enter a different address</option>';
      select.innerHTML = html;
      group.style.display = '';
      applySavedAddressSelection();
    } else {
      group.style.display = 'none';
      select.innerHTML = '';
      setAddressFieldsLocked(false);
      updateSaveCheckboxVisibility();
    }
  }

  function clearBookingAddressFields() {
    ['f-street', 'f-unit', 'f-city', 'f-postal'].forEach(function (id) {
      const el = $(id); if (el) el.value = '';
    });
    setAddressFieldsLocked(false);
  }

  function wireSavedAddressPicker() {
    const select = $('f-saved-addr');
    if (select) select.addEventListener('change', applySavedAddressSelection);

    // Subscribe to account-level cache changes (login, address mutations).
    if (window.HirayaAccount && typeof window.HirayaAccount.onAddressesChanged === 'function') {
      window.HirayaAccount.onAddressesChanged(refreshSavedAddressPicker);
    }

    if (!sb()) return;

    // Initial login state — drives the save-checkbox visibility.
    // .catch swallows the harmless "AuthSessionMissingError" that
    // supabase-js logs for every anonymous visitor on page load.
    sb().auth.getUser().then(function (res) {
      isLoggedIn = !!(res && res.data && res.data.user);
      if (isLoggedIn && window.HirayaAccount) {
        window.HirayaAccount.fetchAddresses();
      } else {
        refreshSavedAddressPicker([]);
      }
    }).catch(function () {
      isLoggedIn = false;
      refreshSavedAddressPicker([]);
    });

    sb().auth.onAuthStateChange(function (event) {
      if (event === 'SIGNED_IN' || event === 'USER_UPDATED') {
        isLoggedIn = true;
        // account.js will refresh and notify; we'll respond to that.
      } else if (event === 'SIGNED_OUT') {
        isLoggedIn = false;
        clearBookingAddressFields();
        refreshSavedAddressPicker([]);
      }
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
  function boot() {
    wireAuthResume();
    wireSavedAddressPicker();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
