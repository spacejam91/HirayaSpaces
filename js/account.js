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

  // ── MODAL OPEN / CLOSE / VIEW SWITCH ───────────────────────────────────
  function openAddresses() {
    const modal = $('addresses-modal');
    if (!modal) return;
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
    showListView();
    refreshList();
  }
  function closeAddresses() {
    const modal = $('addresses-modal');
    if (!modal) return;
    modal.classList.remove('open');
    document.body.style.overflow = '';
    editingId = null;
    deletingId = null;
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
    $('addr-city').value = 'Waterloo';
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
    $('addr-city').value = a.city || 'Waterloo';
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
      sb().auth.onAuthStateChange((event) => {
        if (event === 'SIGNED_IN' || event === 'USER_UPDATED') {
          fetchAddresses();
        } else if (event === 'SIGNED_OUT') {
          cachedAddresses = [];
          notifyListeners();
        }
      });
    }
  }

  // ── EXPORTS ────────────────────────────────────────────────────────────
  window.HirayaAccount = {
    openAddresses,
    closeAddresses,
    openAddressForm,
    cancelAddressForm,
    saveAddressForm,
    editAddress,
    askDelete,
    cancelDelete,
    confirmDelete,
    setDefault,
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
