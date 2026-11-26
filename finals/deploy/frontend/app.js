/* ==========================================================================
   SIBAT NA — frontend/app.js
   SECTIONS
     0. boot + engine status
     1. login / registration flow  (screens data-step 0 … 6)
     2. passenger ride dashboard   (search, route, book, queue, fare)
     3. operations center          (overview, CRUD, queues, simulation, text)
     4. keyboard shortcuts + teardown
   The browser is only a view — fare, queue and matching run in C++.
   ========================================================================== */
(function () {
  'use strict';

  const S = window.SIBAT;
  const { $, $$ } = S;

  // ---------------------------------------------------------------------
  //  Shared application state
  // ---------------------------------------------------------------------
  const login = {
    step: 0,
    role: 'passenger',
    phone: '',
    name: '',
    email: '',
    emergency: '',
    docs: {},
    idImage: '',
    idName: '',
    account: null
  };

  const app = {
    account: null,
    state: null,
    opsState: null,
    settings: null,
    ui: {},
    map: null,
    mapInitialized: false,
    activeRideId: null,
    pinMode: true,
    pickup: null,
    destination: null,
    route: null,
    routeSeq: 0,
    seats: 1,
    pollTimer: null,
    polling: false,
    demoTimer: null,
    autoRideId: null,
    demoPaused: false,
    demoRetries: 0,
    mapPickMode: false,
    lastPopup: new Set(),
    reverseTimer: null,
    searchTimer: null,
    localNoticeShown: false,
    lastRenderedStatus: ''
  };

  // ---------------------------------------------------------------------
  //  Small helpers
  // ---------------------------------------------------------------------
  function digits(value) {
    return String(value || '').replace(/\D/g, '');
  }

  function formatPhone(value) {
    const d = digits(value).slice(0, 10);
    if (d.length <= 3) return d;
    if (d.length <= 6) return d.slice(0, 3) + ' ' + d.slice(3);
    return d.slice(0, 3) + ' ' + d.slice(3, 6) + ' ' + d.slice(6);
  }

  function initials(name) {
    return String(name || 'Sibat Na').trim().split(/\s+/).slice(0, 2)
      .map(part => part.charAt(0).toUpperCase()).join('') || 'SN';
  }

  function firstName(name) {
    return String(name || 'there').trim().split(/\s+/)[0] || 'there';
  }

  function areaFromLabel(label) {
    const parts = String(label || '').split(',').map(p => p.trim()).filter(Boolean);
    return parts.length > 1 ? parts[parts.length - 2] : (parts[0] || 'Shared');
  }

  function statusLabel(status) {
    return ({
      pending: 'Queued',
      offered: 'Ride found',
      arriving: 'Driver on the way',
      at_pickup: 'Driver arrived',
      on_trip: 'On the trip',
      completed: 'Completed',
      cancelled: 'Cancelled'
    })[status] || status;
  }

  // =====================================================================
  //  0. ENGINE STATUS + BOOT
  // =====================================================================
  function updateEnginePills() {
    const online = S.engine.online;
    const local = S.engine.local;
    $$('#enginePill, #enginePillFoot').forEach(pill => {
      // The demo is always usable: C++ when available, browser engine otherwise.
      pill.classList.add('is-online');
      pill.classList.remove('is-local', 'is-offline');
      const label = pill.querySelector('span:last-child');
      if (label) label.textContent = 'engine live';
      pill.title = local
        ? 'Browser local engine (C++ server not running) — always online for the demo'
        : 'C++ engine connected on ' + (S.API_BASE || location.origin);
    });
    const banner = $('#engineBanner');
    if (banner) banner.hidden = true;
  }

  async function checkEngine(retry) {
    if (S.engine.local) { updateEnginePills(); return false; }
    const ok = await S.ping();
    updateEnginePills();
    if (ok && retry) {
      S.toast('C++ engine is back online.', 'success');
      refreshPassenger();
    }
    return ok;
  }

  async function reconnectEngine() {
    if (!S.engine.local) { checkEngine(true); return; }
    const ok = await S.tryEngine();
    if (ok) {
      S.toast('C++ engine connected — reloading.', 'success', 1800);
      setTimeout(() => location.reload(), 700);
    } else {
      S.toast('Engine still offline. Local demo mode keeps working.', 'info', 4200);
    }
  }

  function bindGlobal() {
    S.applyTheme();
    S.onEngineChange(updateEnginePills);

    window.addEventListener('sibat:theme', () => {
      if (app.map) app.map.applyRouteTheme();
    });

    $('#engineRetry').addEventListener('click', reconnectEngine);

    // Day/night toggle — previously the icons updated but no click handler existed.
    $$('[data-theme-toggle]').forEach(btn => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        S.toggleTheme();
      });
    });

    window.addEventListener('sibat:local', () => {
      updateEnginePills();
    });

    window.addEventListener('sibat:driver-closed', () => {
      // Back on the passenger dashboard: let the demo continue if a ride is active.
      app.demoPaused = false;
      if (app.activeRideId && app.state) {
        const ride = app.state.rides.find(r => r.id === app.activeRideId);
        if (ride && !['completed', 'cancelled'].includes(ride.status)) {
          startDemoTimeline(ride, 1200);
        }
      }
    });

    $('#logoutBtn').addEventListener('click', () => {
      const account = S.getAccount();
      S.openModal(
        '<h2>Log out of Sibat Na?</h2>' +
        '<p>This clears <code>sibatNaAccount</code> and your active ride on this device. The demo engine keeps its data.</p>' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn btn-ghost" data-modal-close>Stay</button>' +
          '<button type="button" class="btn btn-danger" id="confirmLogout">Log out</button>' +
        '</div>'
      );
      $('#confirmLogout').addEventListener('click', () => {
        if (window.SIBAT_DRIVER) window.SIBAT_DRIVER.close();
        S.clearAccount();
        location.reload();
      }, { once: true });
      void account;
    });

    $('#userChip').addEventListener('click', showAccountModal);

    // clicking anywhere outside the search dropdown closes it
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.search-card')) hideSearchResults();
    });
  }

  function showAccountModal() {
    const account = S.getAccount();
    if (!account) return;
    const docs = account.role === 'driver'
      ? '<div><dt>Plate</dt><dd>' + S.escapeHtml(account.plate || '—') + '</dd></div>' +
        '<div><dt>Vehicle</dt><dd>' + S.escapeHtml(account.vehicle || '—') + '</dd></div>' +
        '<div><dt>Licence</dt><dd>' + S.escapeHtml(account.license || '—') + '</dd></div>' +
        '<div><dt>NBI</dt><dd>' + S.escapeHtml(account.nbi || '—') + '</dd></div>' +
        '<div><dt>OR / CR</dt><dd>' + S.escapeHtml(account.orcr || '—') + '</dd></div>' +
        '<div><dt>LTFRB</dt><dd>' + S.escapeHtml(account.ltfrb || '—') + '</dd></div>'
      : '';
    S.openModal(
      '<h2>' + S.escapeHtml(account.name || 'Passenger') + '</h2>' +
      '<p>' + S.escapeHtml(account.role || 'passenger') + ' · ' + S.escapeHtml(account.phone || '') + '</p>' +
      '<dl class="summary-list" style="margin-top:16px">' +
        '<div><dt>Email</dt><dd>' + S.escapeHtml(account.email || '—') + '</dd></div>' +
        '<div><dt>Emergency</dt><dd>' + S.escapeHtml(account.emergency || '—') + '</dd></div>' +
        docs +
        '<div><dt>Account ID</dt><dd>' + S.escapeHtml(account.id || 'local') + '</dd></div>' +
      '</dl>' +
      '<div class="modal-actions">' +
        '<button type="button" class="btn btn-ghost" data-modal-close>Close</button>' +
        '<button type="button" class="btn btn-primary" id="modalOpenOps">Operations</button>' +
      '</div>'
    );
    $('#modalOpenOps').addEventListener('click', () => { S.closeModal(); openOps(); });
  }

  // =====================================================================
  //  1. LOGIN FLOW  (step 0 → step 6)
  // =====================================================================
  function showStep(step) {
    login.step = step;
    $$('.auth-step').forEach(section => {
      section.classList.toggle('is-active', Number(section.dataset.step) === step);
    });
    $$('#authProgress li').forEach((dot, index) => {
      dot.classList.toggle('is-active', index === step);
      dot.classList.toggle('is-done', index < step);
    });
    const section = $('.auth-step[data-step="' + step + '"]');
    if (!section) return;
    const autofocus = section.querySelector('input:not([type="file"]), button.btn-primary');
    if (autofocus && step !== 0) setTimeout(() => autofocus.focus({ preventScroll: true }), 120);
  }

  function setRole(role) {
    login.role = role;
    $$('.role-card').forEach(card => {
      const selected = card.dataset.role === role;
      card.classList.toggle('is-selected', selected);
      card.setAttribute('aria-checked', String(selected));
    });
    $('#roleContinue').textContent = 'Continue as ' + (role === 'driver' ? 'Driver' : 'Passenger');
    $('#driverDocs').hidden = role !== 'driver';
  }

  function bindLogin() {
    $$('.role-card').forEach(card => {
      card.addEventListener('click', () => setRole(card.dataset.role));
    });

    $('#roleContinue').addEventListener('click', () => {
      showStep(1);
      setTimeout(() => $('#phoneInput').focus(), 150);
    });

    $('#authHome').addEventListener('click', () => showStep(0));
    $$('[data-goto]').forEach(btn => btn.addEventListener('click', () => showStep(Number(btn.dataset.goto))));

    // ---- STEP 1: mobile number ----
    const phoneInput = $('#phoneInput');
    phoneInput.addEventListener('input', () => {
      login.phone = digits(phoneInput.value).slice(0, 10);
      phoneInput.value = formatPhone(login.phone);
      $('#phoneError').textContent = '';
    });
    phoneInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); sendOtp(); }
    });
    $('#sendOtpBtn').addEventListener('click', sendOtp);

    // ---- STEP 2: OTP boxes ----
    const otpInputs = $$('#otpRow .otp-digit');
    otpInputs.forEach((input, index) => {
      input.addEventListener('input', () => {
        input.value = digits(input.value).slice(-1);
        if (input.value && index < otpInputs.length - 1) otpInputs[index + 1].focus();
        $('#otpError').textContent = '';
        if (getOtp().length === 6) verifyOtp();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !input.value && index > 0) {
          otpInputs[index - 1].focus();
          otpInputs[index - 1].value = '';
        }
        if (e.key === 'ArrowLeft' && index > 0) otpInputs[index - 1].focus();
        if (e.key === 'ArrowRight' && index < otpInputs.length - 1) otpInputs[index + 1].focus();
        if (e.key === 'Enter') { e.preventDefault(); verifyOtp(); }
      });
      input.addEventListener('paste', (e) => {
        const text = digits((e.clipboardData || window.clipboardData).getData('text')).slice(0, 6);
        if (!text) return;
        e.preventDefault();
        otpInputs.forEach((box, i) => { box.value = text[i] || ''; });
        if (text.length === 6) verifyOtp(); else otpInputs[Math.min(text.length, 5)].focus();
      });
    });
    $('#fillOtpBtn').addEventListener('click', () => {
      otpInputs.forEach((box, i) => { box.value = '123456'[i]; });
      verifyOtp();
    });
    $('#verifyOtpBtn').addEventListener('click', verifyOtp);
    $('#resendOtp').addEventListener('click', () => {
      otpInputs.forEach(box => { box.value = ''; });
      $('#otpError').textContent = '';
      otpInputs[0].focus();
      S.toast('Demo code re-sent: 123456', 'info');
    });

    // ---- STEP 3: personal info ----
    $('#saveInfoBtn').addEventListener('click', savePersonalInfo);

    // ---- STEP 4: optional ID ----
    $('#idUpload').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) handleIdFile(file);
    });
    const zone = $('#uploadZone');
    ['dragenter', 'dragover'].forEach(evt => zone.addEventListener(evt, (e) => {
      e.preventDefault(); zone.classList.add('is-drag');
    }));
    ['dragleave', 'drop'].forEach(evt => zone.addEventListener(evt, (e) => {
      e.preventDefault(); zone.classList.remove('is-drag');
      if (evt === 'drop' && e.dataTransfer.files[0]) handleIdFile(e.dataTransfer.files[0]);
    }));
    $('#removeIdBtn').addEventListener('click', clearId);
    $('#skipIdBtn').addEventListener('click', () => { clearId(); showStep(5); populateWelcome(); });
    $('#saveIdBtn').addEventListener('click', () => { showStep(5); populateWelcome(); });

    // ---- STEP 5: profile ready ----
    $('#finishLoginBtn').addEventListener('click', finishLogin);

    // ---- STEP 6: destination ----
    $('#step6Back').addEventListener('click', () => showStep(5));
  }

  function getOtp() {
    return $$('#otpRow .otp-digit').map(input => input.value).join('');
  }

  function sendOtp() {
    const phone = digits($('#phoneInput').value).slice(0, 10);
    login.phone = phone;
    if (!/^9\d{9}$/.test(phone)) {
      $('#phoneError').textContent = 'Enter a 10-digit mobile number starting with 9 (demo).';
      $('#phoneInput').focus();
      return;
    }
    $('#phoneError').textContent = '';
    $('#otpPhone').textContent = '+63 ' + formatPhone(phone);
    $$('#otpRow .otp-digit').forEach(box => { box.value = ''; });
    $('#otpError').textContent = '';
    showStep(2);
    setTimeout(() => $$('#otpRow .otp-digit')[0].focus(), 150);
    S.toast('Demo OTP sent: 123456', 'info', 4200);
  }

  function verifyOtp() {
    const code = getOtp();
    if (code.length < 6) {
      $('#otpError').textContent = 'Enter all 6 digits.';
      return;
    }
    if (code !== '123456') {
      $('#otpError').textContent = 'Incorrect code. This demo accepts only 123456.';
      const row = $('#otpRow');
      row.classList.remove('is-error');
      void row.offsetWidth;
      row.classList.add('is-error');
      return;
    }
    $('#otpError').textContent = '';
    $('#otpRow').classList.remove('is-error');
    S.toast('Mobile verified.', 'success', 2000);
    showStep(3);
  }

  function savePersonalInfo() {
    const name = $('#fullName').value.trim();
    const email = $('#emailInput').value.trim();
    const emergency = $('#emergencyInput').value.trim();
    const error = $('#infoError');

    if (name.length < 2) { error.textContent = 'Please enter your full name.'; $('#fullName').focus(); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      error.textContent = 'Enter a valid email address.'; $('#emailInput').focus(); return;
    }

    const docs = {
      license: $('#licenseInput').value.trim(),
      nbi: $('#nbiInput').value.trim(),
      orcr: $('#orcrInput').value.trim(),
      ltfrb: $('#ltfrbInput').value.trim(),
      otherDocs: $('#otherDocsInput').value.trim(),
      plate: $('#plateInput').value.trim(),
      vehicle: $('#vehicleInput').value.trim()
    };

    if (login.role === 'driver') {
      const missing = [];
      if (!docs.license) missing.push('licence');
      if (!docs.nbi) missing.push('NBI');
      if (!docs.orcr) missing.push('OR / CR');
      if (!docs.ltfrb) missing.push('LTFRB');
      if (!docs.plate) missing.push('plate number');
      if (!docs.vehicle) missing.push('vehicle');
      if (missing.length) {
        error.textContent = 'Drivers must fill: ' + missing.join(', ') + '.';
        return;
      }
    }

    error.textContent = '';
    login.name = name;
    login.email = email;
    login.emergency = emergency;
    login.docs = docs;
    showStep(4);
  }

  function handleIdFile(file) {
    if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) {
      S.toast('Use a PNG, JPG or WEBP image.', 'error');
      return;
    }
    if (file.size > 1.5 * 1024 * 1024) {
      S.toast('That image is over 1.5 MB — pick a smaller one.', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      login.idImage = String(reader.result || '');
      login.idName = file.name;
      $('#idPreview').src = login.idImage;
      $('#idFileName').textContent = file.name;
      $('#idPreviewWrap').hidden = false;
      $('#saveIdBtn').disabled = false;
      S.toast('ID attached — it never leaves this demo.', 'success', 2200);
    };
    reader.onerror = () => S.toast('Could not read that image.', 'error');
    reader.readAsDataURL(file);
  }

  function clearId() {
    login.idImage = '';
    login.idName = '';
    $('#idPreviewWrap').hidden = true;
    $('#idPreview').removeAttribute('src');
    $('#idUpload').value = '';
    $('#saveIdBtn').disabled = true;
  }

  function populateWelcome() {
    const role = login.role;
    $('#welcomeInitials').textContent = initials(login.name);
    $('#welcomeName').textContent = firstName(login.name);
    $('#welcomeRole').textContent = role;
    $('#sumPhone').textContent = '+63 ' + formatPhone(login.phone);
    $('#sumEmail').textContent = login.email || '—';
    $('#sumEmergency').textContent = login.emergency || '—';
    $('#sumDocsRow').hidden = role !== 'driver';
    if (role === 'driver') {
      $('#sumDocs').textContent = [login.docs.plate, login.docs.vehicle, login.docs.ltfrb]
        .filter(Boolean).join(' · ') || '—';
    }
  }

  async function finishLogin() {
    const button = $('#finishLoginBtn');
    button.disabled = true;
    const original = button.textContent;
    button.textContent = 'Saving profile…';

    // Reuse the previous account id when the phone number matches.
    const previous = S.getAccount();
    const account = {
      id: previous && previous.phone && digits(previous.phone).slice(-10) === login.phone ? previous.id : '',
      role: login.role,
      name: login.name,
      email: login.email,
      phone: '+63 ' + formatPhone(login.phone),
      emergency: login.emergency,
      plate: login.docs.plate || '',
      vehicle: login.docs.vehicle || '',
      license: login.docs.license || '',
      nbi: login.docs.nbi || '',
      orcr: login.docs.orcr || '',
      ltfrb: login.docs.ltfrb || '',
      otherDocs: login.docs.otherDocs || '',
      idImage: login.idImage,
      status: 'offline',
      lat: 14.5995,
      lng: 120.9842
    };

    // The spec requires this write even if the engine is offline.
    S.setAccount(account);

    try {
      const res = await S.api('/accounts', { method: 'POST', body: account });
      if (res.account && res.account.id) {
        Object.assign(account, {
          id: res.account.id,
          lat: res.account.lat,
          lng: res.account.lng,
          earnings: res.account.earnings,
          trips: res.account.trips,
          rating: res.account.rating
        });
        S.setAccount(account);
      }
      S.toast('Profile saved to the ' + (S.engine.local ? 'local demo engine.' : 'C++ engine.'), 'success');
    } catch (err) {
      if (!account.id) {
        account.id = (login.role === 'driver' ? 'DRV-LOCAL-' : 'PAS-LOCAL-') + Date.now().toString(36).toUpperCase();
        S.setAccount(account);
      }
      S.toast('Saved locally — the server engine is not reachable.', 'info', 4200);
    }

    login.account = account;
    button.disabled = false;
    button.textContent = original;

    const isDriver = account.role === 'driver';
    $('#step6Title').textContent = isDriver ? 'Driver mode is unlocked.' : 'Your ride dashboard is ready.';
    $('#step6Copy').textContent = isDriver
      ? 'Go straight to the Grab-style driver panel, or peek at the passenger dashboard.'
      : 'Your queue position, driver match and fare all come from the C++ engine.';
    $('#launchPrimaryTitle').textContent = isDriver ? 'Open driver mode' : 'Open the ride dashboard';
    $('#launchPrimaryCopy').textContent = isDriver
      ? 'Go online, accept an offer and run the trip phases.'
      : 'Search a destination and join the shared queue.';
    $('#launchSecondaryTitle').textContent = isDriver ? 'Open ride dashboard' : 'Open Operations Center';
    $('#launchSecondaryCopy').textContent = isDriver
      ? 'See the passenger side of the same shared state.'
      : 'Serve the queue, edit locations and run a simulation.';
    $('#launchIcon').textContent = isDriver ? '◉' : '➜';

    $('#launchPrimary').onclick = () => {
      if (isDriver) enterPassengerThenDriver(account);
      else enterPassenger();
    };
    $('#launchSecondary').onclick = () => {
      enterPassenger();
      if (isDriver) return;
      openOps();
    };

    showStep(6);
    S.toast('Welcome, ' + firstName(account.name) + '.', 'success');
  }

  function enterPassenger() {
    $('#authScreen').hidden = true;
    $('#appShell').hidden = false;
    document.body.classList.remove('auth-open');
    window.scrollTo(0, 0);
    initPassenger(S.getAccount());
  }

  function enterPassengerThenDriver(account) {
    enterPassenger();
    if (window.SIBAT_DRIVER) {
      window.SIBAT_DRIVER.open({ account: account, skipGate: true });
    }
  }

  // =====================================================================
  //  2. PASSENGER DASHBOARD
  // =====================================================================
  function updateUserChrome(account) {
    if (!account) return;
    $('#userName').textContent = account.name || 'Passenger';
    $('#userRole').textContent = account.role || 'passenger';
    $('#userInitials').textContent = initials(account.name);
    $('#greeting').innerHTML = 'Kumusta, <span>' + S.escapeHtml(firstName(account.name)) + '</span>!';
    updateGreetingTime();
  }

  function updateGreetingTime() {
    const hour = new Date().getHours();
    $('#greetingTime').textContent =
      hour < 5 ? 'Still up' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  }

  function initPassenger(account) {
    if (!account) return;
    if (!account.id) {
      account.id = (account.role === 'driver' ? 'DRV-LOCAL-' : 'PAS-LOCAL-') +
        Date.now().toString(36).toUpperCase();
      S.setAccount(account);
    }
    app.account = account;
    app.state = null;
    app.activeRideId = localStorage.getItem(S.KEYS.activeRide) || null;
    app.seats = 1;
    app.lastPopup = new Set();
    app.pinMode = true;
    updateUserChrome(account);
    $('#seatsValue').textContent = '1';

    if (!app.mapInitialized) {
      app.mapInitialized = true;
      initPassengerMap();
      bindPassengerUI();
    }

    refreshPassenger();
    startPolling();
  }

  function initPassengerMap() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(S.KEYS.lastCenter) || 'null'); } catch (_) { saved = null; }
    const center = saved && saved.lat ? saved : S.DEFAULTS.center;
    app.pickup = { lat: center.lat, lng: center.lng, label: 'Pinned location' };
    updatePickupUI();

    app.map = new S.SibatMap('#passengerMap', {
      center: center,
      zoom: 13,
      onPickup: (lat, lng) => {
        if (!app.pinMode) return;
        app.pickup = { lat: lat, lng: lng, label: app.pickup ? app.pickup.label : 'Pinned location' };
        localStorage.setItem(S.KEYS.lastCenter, JSON.stringify({ lat, lng }));
        updatePickupUI();
        clearTimeout(app.reverseTimer);
        app.reverseTimer = setTimeout(async () => {
          const result = await S.reverseGeocode(lat, lng);
          if (!result || !result.label) return;
          if (!app.pinMode) return;
          app.pickup.label = result.label;
          app.pickup.area = (result.detail && result.detail.city) || areaFromLabel(result.label);
          updatePickupUI();
          if (app.destination) updateRoute();
        }, 500);
      },
      onMapClick: (lat, lng) => handleMapClick(lat, lng),
      onReady: () => refreshPickupLabel()
    });
  }

  async function refreshPickupLabel() {
    if (!app.pickup) return;
    const result = await S.reverseGeocode(app.pickup.lat, app.pickup.lng);
    if (!result || !result.label) {
      app.pickup.label = app.pickup.label === 'Pinned location'
        ? 'Pinned pickup · ' + app.pickup.lat.toFixed(4) + ', ' + app.pickup.lng.toFixed(4)
        : app.pickup.label;
      updatePickupUI();
      return;
    }
    app.pickup.label = result.label;
    app.pickup.area = (result.detail && result.detail.city) || areaFromLabel(result.label);
    updatePickupUI();
  }

  function updatePickupUI() {
    if (!app.pickup) return;
    $('#pickupLabel').textContent = app.pickup.label || 'Pinned location';
    $('#pickupCoords').textContent = app.pickup.lat.toFixed(4) + ', ' + app.pickup.lng.toFixed(4);
  }

  function bindPassengerUI() {
    const search = $('#destSearch');
    search.addEventListener('input', () => {
      const query = search.value.trim();
      clearTimeout(app.searchTimer);
      if (query.length < 3) { hideSearchResults(); return; }
      app.searchTimer = setTimeout(() => runSearch(query), 320);
    });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideSearchResults();
    });
    $('#searchResults').addEventListener('click', (e) => {
      const button = e.target.closest('.search-result');
      if (!button) return;
      const index = Number(button.dataset.index);
      const places = app.searchPlaces || [];
      if (places[index]) selectDestination(places[index]);
    });

    $('#clearDestBtn').addEventListener('click', clearDestination);
    $('#seatsMinus').addEventListener('click', () => setSeats(app.seats - 1));
    $('#seatsPlus').addEventListener('click', () => setSeats(app.seats + 1));
    $('#bookBtn').addEventListener('click', bookRide);
    $('#cancelRideBtn').addEventListener('click', confirmCancelRide);
    $('#ridePopupClose').addEventListener('click', hideRidePopup);
    $('#locateBtn').addEventListener('click', locateMe);
    $('#fitRouteBtn').addEventListener('click', () => {
      if (app.route && app.map) app.map.drawRoute(app.route);
      else S.toast('Pick a destination first.', 'info');
    });
    $('#editPickupBtn').addEventListener('click', togglePinMode);
    $('#pinDestBtn').addEventListener('click', toggleMapPick);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && app.mapPickMode) {
        app.mapPickMode = false;
        updateMapPickUI();
      }
    });
    $('#brandHome').addEventListener('click', (e) => {
      e.preventDefault();
      closeOps();
      const scroll = document.querySelector('.panel-scroll');
      if (scroll) scroll.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  async function runSearch(query) {
    $('#searchSpinner').hidden = false;
    try {
      const places = await S.searchPlaces(query, app.pickup);
      app.searchPlaces = places;
      renderSearchResults(places);
    } catch (_) {
      $('#searchResults').hidden = false;
      $('#searchResults').innerHTML =
        '<li class="search-empty">Search needs internet (Photon). You can still use the pinned pickup.</li>';
    } finally {
      $('#searchSpinner').hidden = true;
    }
  }

  function renderSearchResults(places) {
    const list = $('#searchResults');
    if (!places.length) {
      list.hidden = false;
      list.innerHTML = '<li class="search-empty">No places found. Try a landmark or city.</li>';
      return;
    }
    list.hidden = false;
    list.innerHTML = places.map((place, index) =>
      '<li><button type="button" class="search-result" data-index="' + index + '">' +
        '<span class="result-pin">◉</span>' +
        '<span class="result-body"><strong>' + S.escapeHtml(place.label) + '</strong>' +
        '<small>' + S.escapeHtml(place.detail || (place.lat.toFixed(4) + ', ' + place.lng.toFixed(4))) + '</small></span>' +
        '<span class="result-kind">' + S.escapeHtml(place.kind) + '</span>' +
      '</button></li>'
    ).join('');
  }

  function hideSearchResults() {
    $('#searchResults').hidden = true;
  }

  function selectDestination(place) {
    hideSearchResults();
    app.mapPickMode = false;
    updateMapPickUI();
    $('#destSearch').value = place.label;
    app.destination = {
      lat: place.lat,
      lng: place.lng,
      label: place.label,
      area: areaFromLabel(place.label)
    };
    $('#destLabel').textContent = place.label;
    $('#destDetail').textContent = (place.detail || '') + ' · ' + place.lat.toFixed(4) + ', ' + place.lng.toFixed(4);
    $('#clearDestBtn').hidden = false;

    if (app.pinMode) lockPickup();
    if (app.map) app.map.setDestination({ lat: place.lat, lng: place.lng }, place.label);
    updateRoute();
  }

  // Destination-pin tool: enable it, then click anywhere on the map.
  function toggleMapPick() {
    if (!app.map || app.map.mode === 'schematic') {
      S.toast('Map tiles are offline — use the destination search instead.', 'info', 3600);
      return;
    }
    app.mapPickMode = !app.mapPickMode;
    updateMapPickUI();
    if (app.mapPickMode) {
      if (app.pinMode) lockPickup();
      S.toast('Click the map to set your destination pin.', 'info', 3200);
    }
  }

  function updateMapPickUI() {
    const btn = $('#pinDestBtn');
    if (btn) {
      btn.classList.toggle('is-active', app.mapPickMode);
      btn.setAttribute('aria-pressed', String(app.mapPickMode));
    }
    if (app.map && app.map.gl) {
      app.map.gl.getCanvas().style.cursor = app.mapPickMode ? 'crosshair' : '';
    }
  }

  function handleMapClick(lat, lng) {
    if (!app.mapPickMode) return;
    app.mapPickMode = false;
    updateMapPickUI();
    setDestinationPoint(lat, lng, 'Pinned destination');
    S.toast('Destination pinned — fare updated.', 'success', 2200);
  }

  function setDestinationPoint(lat, lng, label) {
    if (app.pinMode) lockPickup();
    app.destination = { lat, lng, label: label || 'Pinned destination', area: '' };
    $('#destLabel').textContent = app.destination.label;
    $('#destDetail').textContent = lat.toFixed(5) + ', ' + lng.toFixed(5) + ' · resolving…';
    $('#destSearch').value = '';
    $('#clearDestBtn').hidden = false;
    if (app.map) app.map.setDestination({ lat, lng }, app.destination.label);
    updateRoute();

    // Improve the pinned label with reverse geocoding (Photon), keeping coords as fallback.
    S.reverseGeocode(lat, lng).then(result => {
      if (!result || !result.label || !app.destination) return;
      if (Math.abs(app.destination.lat - lat) > 1e-9 || Math.abs(app.destination.lng - lng) > 1e-9) return;
      app.destination.label = result.label;
      app.destination.area = (result.detail && result.detail.city) || areaFromLabel(result.label);
      $('#destLabel').textContent = result.label;
      $('#destSearch').value = result.label;
      $('#destDetail').textContent = lat.toFixed(5) + ', ' + lng.toFixed(5);
      if (app.map) app.map.setDestination({ lat, lng }, result.label);
      updateRoute();
    }).catch(() => { /* coordinates stay as the label */ });
  }

  function clearDestination() {
    app.destination = null;
    app.route = null;
    app.mapPickMode = false;
    updateMapPickUI();
    $('#destSearch').value = '';
    $('#destLabel').textContent = 'Not set yet';
    $('#destDetail').textContent = 'Search above to set your destination';
    $('#clearDestBtn').hidden = true;
    $('#bookingCard').hidden = true;
    if (app.map) app.map.clearRoute();
  }

  function lockPickup() {
    app.pinMode = false;
    $('.center-pin').classList.add('is-hidden');
    if (app.map) app.map.setPickupMarker(app.pickup, app.pickup.label);
    $('#editPickupBtn').textContent = 'Adjust';
    app.map && app.map.applyRouteTheme();
  }

  function togglePinMode() {
    if (app.pinMode) {
      lockPickup();
      if (app.destination) updateRoute();
      S.toast('Pickup locked at ' + (app.pickup.label || 'the pin') + '.', 'success', 2200);
      return;
    }
    app.pinMode = true;
    $('.center-pin').classList.remove('is-hidden');
    if (app.map) {
      app.map.clearPickupMarker();
      app.map.setCenter(app.pickup.lat, app.pickup.lng, { silent: true });
    }
    $('#editPickupBtn').textContent = 'Done';
    S.toast('Drag the map to move the pickup pin.', 'info', 3000);
  }

  async function updateRoute() {
    if (!app.destination) return;
    const seq = ++app.routeSeq;
    const fallback = S.straightRoute(app.pickup, app.destination);
    applyRoute(fallback, true);

    // Avoid an OSRM round-trip when the pin and destination are almost the same.
    if (fallback.distanceKm < 0.1) return;

    try {
      const route = await S.fetchRoute(app.pickup, app.destination);
      if (seq !== app.routeSeq) return;
      applyRoute(route, false);
    } catch (_) {
      // keep the straight-line estimate, clearly labelled
    }
  }

  function applyRoute(route, isFallback) {
    app.route = route;
    if (app.map) app.map.drawRoute(route);
    const settings = (app.state && app.state.settings) || app.settings || {};
    const fare = S.estimateFare(route.distanceKm, settings);
    $('#fareEstimate').textContent = S.money(fare, settings.currency);
    $('#tripDistance').textContent = S.km(route.distanceKm);
    $('#tripDuration').textContent = S.minutes(route.durationSeconds);
    $('#routeSource').textContent = isFallback ? 'straight-line estimate' : 'OSRM route';
    $('#bookingCard').hidden = false;
    updateFareRule(settings);
  }

  function updateFareRule(settings) {
    if (!settings || !settings.baseFare) return;
    const currency = settings.currency || '₱';
    $('#fareRule').textContent = 'Base ' + currency + Number(settings.baseFare).toFixed(0) +
      ' · first ' + Number(settings.includedKm || 4) + ' km · ' +
      currency + Number(settings.perKm || 2.5).toFixed(2) + ' per extra km';
  }

  function setSeats(next) {
    app.seats = Math.max(1, Math.min(4, next));
    $('#seatsValue').textContent = String(app.seats);
  }

  async function bookRide() {
    if (app.activeRideId) {
      S.toast('Finish or cancel your current ride first.', 'info');
      return;
    }
    if (!app.destination || !app.route) {
      S.toast('Choose a destination first.', 'info');
      return;
    }
    const button = $('#bookBtn');
    button.disabled = true;
    const original = button.textContent;
    button.textContent = 'Joining the queue…';

    try {
      const result = await S.api('/rides', {
        method: 'POST',
        body: {
          passengerId: app.account.id,
          passengerName: app.account.name,
          phone: app.account.phone,
          pickupLabel: app.pickup.label || 'Pinned pickup',
          pickupArea: app.pickup.area || areaFromLabel(app.pickup.label),
          pickupLat: app.pickup.lat,
          pickupLng: app.pickup.lng,
          destLabel: app.destination.label,
          destArea: app.destination.area || areaFromLabel(app.destination.label),
          destLat: app.destination.lat,
          destLng: app.destination.lng,
          distanceKm: app.route.distanceKm,
          seats: app.seats
        }
      });
      app.activeRideId = result.ride.id;
      localStorage.setItem(S.KEYS.activeRide, result.ride.id);
      app.lastPopup = new Set();
      app.demoPaused = false;
      startDemoTimeline(result.ride, 2000);
      S.toast('Booked ' + result.ride.code + ' · queue position #' + (result.ride.queuePosition || 1), 'success', 4200);
      renderActiveRide(result.ride);
      refreshPassenger();
    } catch (err) {
      S.toast(err.message, 'error', 4500);
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  function startPolling() {
    if (app.pollTimer) clearInterval(app.pollTimer);
    app.pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible') refreshPassenger();
    }, 2000);
  }

  async function refreshPassenger() {
    if (app.polling || !app.account) return;
    app.polling = true;
    try {
      const res = await S.api('/state');
      app.state = res.state;
      app.settings = res.state.settings;
      app.ui = res.state.ui || {};
      applyUiTexts(app.ui);
      updateFareRule(app.settings);
      writeMirror(app.state);

      const rides = app.state.rides || [];
      const mine = rides.filter(r => r.passengerId === app.account.id);

      if (app.activeRideId) {
        const ride = rides.find(r => r.id === app.activeRideId);
        if (!ride) {
          clearActiveRide(true);
        } else {
          syncRideRoute(ride);
          renderActiveRide(ride);
          startDemoTimeline(ride, ride.status === 'pending' ? 2000 : 3000);
        }
      } else {
        const current = mine
          .filter(r => ['pending', 'offered', 'arriving', 'at_pickup', 'on_trip'].includes(r.status))
          .sort((a, b) => b.createdAt - a.createdAt)[0];
        if (current) {
          app.activeRideId = current.id;
          localStorage.setItem(S.KEYS.activeRide, current.id);
          syncRideRoute(current);
          renderActiveRide(current);
          startDemoTimeline(current, current.status === 'pending' ? 2000 : 3000);
        } else {
          stopDemoTimeline();
          $('#activeRideCard').hidden = true;
          $('#bookingCard').hidden = !(app.destination && app.route);
        }
      }

      renderRecentTrips(mine);
      updateEnginePills();
    } catch (_) {
      updateEnginePills();
    } finally {
      app.polling = false;
    }
  }

  function writeMirror(state) {
    try {
      localStorage.setItem(S.KEYS.queueMirror, JSON.stringify({
        rides: state.rides || [],
        drivers: state.drivers || [],
        stats: state.stats || {},
        updatedAt: Date.now()
      }));
    } catch (_) { /* quota */ }
  }

  function applyUiTexts(ui) {
    if (!ui) return;
    $$('[data-text]').forEach(el => {
      const key = el.dataset.text;
      if (ui[key]) el.textContent = ui[key];
    });
    $$('[data-text-placeholder]').forEach(el => {
      const key = el.dataset.textPlaceholder;
      if (ui[key]) el.setAttribute('placeholder', ui[key]);
    });
  }

  function isDriverModeOpen() {
    const overlay = $('#driverMode');
    return !!overlay && !overlay.hidden;
  }

  // ---------------------------------------------------------------------
  //  DEMO AUTOPILOT — Queue for 2s, then advance one phase every 3s.
  //  It is paused whenever the driver panel is open (same tab or another tab).
  // ---------------------------------------------------------------------
  function driverPanelActive() {
    if (isDriverModeOpen()) return true;
    try {
      const at = Number(localStorage.getItem('sibatNaDriverOpen') || 0);
      return at > 0 && Date.now() - at < 10000;
    } catch (_) {
      return false;
    }
  }

  function startDemoTimeline(ride, delay) {
    if (!ride || ['completed', 'cancelled'].includes(ride.status)) return;
    if (driverPanelActive()) { app.demoPaused = true; return; }
    if (app.demoPaused) return;
    if (app.autoRideId === ride.id) return;
    clearTimeout(app.demoTimer);
    app.autoRideId = ride.id;
    app.demoRetries = 0;
    scheduleDemoStep(ride.id, delay == null ? 2000 : delay);
  }

  function scheduleDemoStep(rideId, delay) {
    clearTimeout(app.demoTimer);
    app.demoTimer = setTimeout(() => runDemoStep(rideId), Math.max(400, delay));
  }

  async function runDemoStep(rideId) {
    app.demoTimer = null;
    if (app.autoRideId !== rideId) return;
    if (driverPanelActive()) {
      // A human driver took over — let the driver panel control the phases.
      app.autoRideId = null;
      app.demoPaused = true;
      return;
    }
    try {
      const res = await S.api('/ops/demo-advance', {
        method: 'POST',
        body: { rideId }
      });
      if (!res.ride || app.activeRideId !== rideId) {
        app.autoRideId = null;
        return;
      }
      app.demoRetries = 0;
      renderActiveRide(res.ride);
      if (res.ride.status === 'completed' || res.ride.status === 'cancelled') {
        app.autoRideId = null;
        return;
      }
      scheduleDemoStep(rideId, 3000);
    } catch (err) {
      app.demoRetries += 1;
      if (app.demoRetries <= 3) scheduleDemoStep(rideId, 3000);
      else app.autoRideId = null;
    }
  }

  function stopDemoTimeline() {
    clearTimeout(app.demoTimer);
    app.demoTimer = null;
    app.autoRideId = null;
  }

  function syncRideRoute(ride) {
    if (app.destination) return;
    app.mapPickMode = false;
    updateMapPickUI();
    app.pinMode = false;
    app.pickup = {
      lat: Number(ride.pickupLat),
      lng: Number(ride.pickupLng),
      label: ride.pickupLabel,
      area: ride.pickupArea
    };
    app.destination = {
      lat: Number(ride.destLat),
      lng: Number(ride.destLng),
      label: ride.destLabel,
      area: ride.destArea
    };
    $('.center-pin').classList.add('is-hidden');
    updatePickupUI();
    $('#destLabel').textContent = ride.destLabel;
    $('#destSearch').value = ride.destLabel;
    $('#destDetail').textContent = ride.destArea + ' · ' +
      Number(ride.destLat).toFixed(4) + ', ' + Number(ride.destLng).toFixed(4);
    $('#clearDestBtn').hidden = false;
    if (app.map) {
      app.map.setPickupMarker(app.pickup, app.pickup.label);
      app.map.setDestination({ lat: app.destination.lat, lng: app.destination.lng }, ride.destLabel);
    }
    updateRoute();
  }

  function renderActiveRide(ride) {
    const card = $('#activeRideCard');
    const wasHidden = card.hidden;
    card.hidden = false;
    $('#bookingCard').hidden = true;
    if (wasHidden) {
      setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 160);
    }
    $('#activeCode').textContent = ride.code;
    const pill = $('#activeStatus');
    pill.textContent = statusLabel(ride.status);
    pill.className = 'status-pill' +
      (['offered', 'arriving', 'at_pickup', 'on_trip'].includes(ride.status) ? ' is-live' :
       ride.status === 'completed' ? ' is-done' :
       ride.status === 'cancelled' ? ' is-dead' : '');

    // queue position
    const queued = ride.status === 'pending';
    $('#queueBadge').hidden = !queued;
    $('#queueLane').hidden = !queued;
    if (queued) {
      const position = ride.queuePosition || 1;
      const peers = (app.state && app.state.rides ? app.state.rides : [])
        .filter(r => r.status === 'pending' && r.queueKey === ride.queueKey)
        .sort((a, b) => a.createdAt - b.createdAt);
      const laneSize = Math.min(Math.max(peers.length, position, 6), 12);
      let chips = '';
      for (let i = 1; i <= laneSize; i++) {
        chips += '<span class="queue-chip' +
          (i < position ? ' is-passed' : '') +
          (i === position ? ' is-you' : '') + '">' + i + '</span>';
      }
      if (position > laneSize) {
        chips += '<span class="queue-chip is-you">' + position + '</span>';
      }
      $('#queueChips').innerHTML = chips;
      $('#queueNumber').textContent = String(position);
      $('#queueCopy').textContent = (ride.pickupArea || 'Shared') + ' → ' +
        (ride.destArea || 'destination') + ' · about ' + Math.max(2, position * 4) + ' min wait';
    }

    // timeline
    const phaseIndex = ({ pending: 0, offered: 1, arriving: 2, at_pickup: 2, on_trip: 3, completed: 4 })[ride.status];
    $$('#tripTimeline li').forEach((li, index) => {
      li.classList.toggle('is-done', phaseIndex != null && index < phaseIndex);
      li.classList.toggle('is-current', phaseIndex != null && index === phaseIndex);
    });

    // driver
    const hasDriver = !!ride.driverId && ['offered', 'arriving', 'at_pickup', 'on_trip', 'completed'].includes(ride.status);
    $('#activeDriver').hidden = !hasDriver;
    if (hasDriver) {
      $('#activeDriverInitials').textContent = initials(ride.driverName);
      $('#activeDriverName').textContent = ride.driverName;
      $('#activeDriverVehicle').textContent = [ride.vehicle, ride.plate].filter(Boolean).join(' · ');
      const driver = (app.state && app.state.drivers || []).find(d => d.id === ride.driverId);
      const rating = $('#activeDriver').querySelector('.rating');
      if (rating) rating.textContent = (driver ? driver.rating.toFixed(1) : '4.9') + ' ★';
    }

    $('#activePickup').textContent = ride.pickupLabel;
    $('#activeDest').textContent = ride.destLabel;
    $('#activeFare').textContent = S.money(ride.fare, (app.settings && app.settings.currency) || '₱');

    const cancel = $('#cancelRideBtn');
    cancel.hidden = ['completed', 'cancelled'].includes(ride.status);
    cancel.disabled = ride.status === 'on_trip';
    cancel.textContent = ride.status === 'on_trip' ? 'Trip in progress' : 'Cancel ride';

    const hints = {
      pending: 'Queued for about 2 seconds — a demo driver is matched automatically.',
      offered: 'Ride found — demo advances to the next step every 3 seconds.',
      arriving: 'Your driver is on the way — next demo step in 3 seconds.',
      at_pickup: 'Your driver has arrived. Look for ' + (ride.plate || 'the vehicle') + '.',
      on_trip: 'On the way — demo completes in a few seconds.',
      completed: 'Trip completed — fare ' + S.money(ride.fare, '₱') + '.',
      cancelled: 'This ride was cancelled.'
    };
    $('#activeHint').textContent = hints[ride.status] || '';

    // popups (once per ride + status) — suppressed while the driver panel is open
    const statusKey = ride.id + ':' + ride.status;
    const driverOpen = isDriverModeOpen();
    if (!driverOpen && (ride.status === 'offered' || ride.status === 'arriving') && !app.lastPopup.has(statusKey)) {
      app.lastPopup.add(statusKey);
      showRidePopup(
        ride.status === 'offered' ? 'Ride found' : 'Driver on the way',
        ride.status === 'offered'
          ? 'A driver in the shared queue accepted your request.'
          : 'Your driver is heading to the pickup pin.',
        ride
      );
    }
    if (!driverOpen && ride.status === 'completed' && !app.lastPopup.has(statusKey)) {
      app.lastPopup.add(statusKey);
      showFareComplete(ride);
    }
    if (driverOpen && ride.status === 'completed' && !app.lastPopup.has(statusKey)) {
      // clear silently: the driver already saw the completion toast
      app.lastPopup.add(statusKey);
      clearActiveRide(true);
    }
    if (ride.status === 'cancelled' && !app.lastPopup.has(statusKey)) {
      app.lastPopup.add(statusKey);
      S.toast('Ride ' + ride.code + ' was cancelled.', 'info');
      clearActiveRide(true);
      return;
    }

    app.lastRenderedStatus = ride.status;
  }

  function showRidePopup(title, copy, ride) {
    const popup = $('#ridePopup');
    $('#ridePopupTitle').textContent = title;
    $('#ridePopupCopy').textContent = copy;
    $('#ridePopupDriver').hidden = !ride.driverId;
    if (ride.driverId) {
      $('#ridePopupInitials').textContent = initials(ride.driverName);
      $('#ridePopupName').textContent = ride.driverName;
      $('#ridePopupVehicle').textContent = [ride.vehicle, ride.plate].filter(Boolean).join(' · ');
    }
    popup.hidden = false;
    requestAnimationFrame(() => popup.classList.add('is-open'));
    clearTimeout(app.popupTimer);
    app.popupTimer = setTimeout(hideRidePopup, 9000);
  }

  function hideRidePopup() {
    const popup = $('#ridePopup');
    popup.classList.remove('is-open');
    setTimeout(() => { popup.hidden = true; }, 260);
  }

  function showFareComplete(ride) {
    clearActiveRide(true);
    S.openModal(
      '<p class="eyebrow">Trip complete</p>' +
      '<h2>You arrived — ' + S.money(ride.fare, '₱') + '</h2>' +
      '<p>' + S.escapeHtml(ride.pickupLabel) + ' → ' + S.escapeHtml(ride.destLabel) + '</p>' +
      '<dl class="summary-list" style="margin-top:16px">' +
        '<div><dt>Ride</dt><dd>' + S.escapeHtml(ride.code) + '</dd></div>' +
        '<div><dt>Driver</dt><dd>' + S.escapeHtml(ride.driverName || '—') + '</dd></div>' +
        '<div><dt>Distance</dt><dd>' + S.km(ride.distanceKm) + '</dd></div>' +
        '<div><dt>Fare</dt><dd style="color:var(--gold)">' + S.money(ride.fare, '₱') + '</dd></div>' +
      '</dl>' +
      '<p class="hint-line">Demo only — no payment is processed.</p>' +
      '<div class="modal-actions">' +
        '<button type="button" class="btn btn-ghost" data-modal-close>Done</button>' +
        '<button type="button" class="btn btn-primary" id="bookAnother">Book another ride</button>' +
      '</div>'
    );
    const again = $('#bookAnother');
    if (again) again.addEventListener('click', () => {
      S.closeModal();
      clearDestination();
      refreshPassenger();
    });
    refreshPassenger();
  }

  function clearActiveRide(removeCard) {
    stopDemoTimeline();
    app.activeRideId = null;
    localStorage.removeItem(S.KEYS.activeRide);
    if (removeCard !== false) $('#activeRideCard').hidden = true;
    if (app.destination && app.route) $('#bookingCard').hidden = false;
  }

  function confirmCancelRide() {
    const ride = app.state && app.state.rides
      ? app.state.rides.find(r => r.id === app.activeRideId)
      : null;
    if (!ride) { clearActiveRide(); return; }
    S.openModal(
      '<h2>Cancel ' + S.escapeHtml(ride.code) + '?</h2>' +
      '<p>Your seat leaves the shared queue and any offered driver is freed.</p>' +
      '<div class="modal-actions">' +
        '<button type="button" class="btn btn-ghost" data-modal-close>Keep ride</button>' +
        '<button type="button" class="btn btn-danger" id="confirmCancel">Cancel ride</button>' +
      '</div>'
    );
    $('#confirmCancel').addEventListener('click', async () => {
      try {
        await S.api('/rides/' + encodeURIComponent(ride.id) + '/cancel', { method: 'POST' });
        S.closeModal();
        clearActiveRide();
        S.toast('Ride cancelled.', 'success');
        refreshPassenger();
      } catch (err) {
        S.toast(err.message, 'error');
      }
    }, { once: true });
  }

  function renderRecentTrips(rides) {
    const list = $('#recentRides');
    const done = rides
      .filter(r => r.status === 'completed' || r.status === 'cancelled')
      .sort((a, b) => (b.completedAt || b.createdAt) - (a.completedAt || a.createdAt))
      .slice(0, 6);
    if (!done.length) {
      list.innerHTML = '<li class="empty-row">No trips yet. Book one above.</li>';
      return;
    }
    list.innerHTML = done.map(ride =>
      '<li>' +
        '<span class="recent-icon">' + (ride.status === 'completed' ? '✓' : '×') + '</span>' +
        '<span class="recent-body">' +
          '<strong>' + S.escapeHtml(ride.destLabel) + '</strong>' +
          '<small>' + S.escapeHtml(ride.code) + ' · ' + S.timeAgo(ride.completedAt || ride.createdAt) + '</small>' +
        '</span>' +
        '<span class="recent-fare">' + S.money(ride.fare, '₱') + '</span>' +
        '<span class="recent-status' + (ride.status === 'cancelled' ? ' is-cancelled' : '') + '">' +
          (ride.status === 'cancelled' ? 'cancelled' : 'done') + '</span>' +
      '</li>'
    ).join('');
  }

  function locateMe() {
    if (!navigator.geolocation) {
      S.toast('Geolocation is not available in this browser.', 'error');
      return;
    }
    S.toast('Locating…', 'info', 1600);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        localStorage.setItem(S.KEYS.lastCenter, JSON.stringify({ lat, lng }));
        if (app.map) app.map.flyTo(lat, lng, 15);
        app.pickup = { lat, lng, label: 'My location' };
        updatePickupUI();
        lockPickup();
        if (app.destination) updateRoute();
        S.toast('Pickup moved to your location.', 'success');
      },
      () => S.toast('Could not get your location — drag the pin instead.', 'error'),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  // ---------------------------------------------------------------------
  //  Secret shortcuts: Ctrl+Shift+1 = demo passenger, 2 = demo driver,
  //  3 = operations center, 4 = reset demo data. (Shift+1 is "!" and Shift+4
  //  is "$" on a US layout, hence the extra key checks so the shortcuts work
  //  with or without the shifted symbol.)
  // ---------------------------------------------------------------------
  function bindShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (!e.ctrlKey || !e.shiftKey) return;
      if (e.key === '!' || e.key === '1' || e.code === 'Digit1') openPassengerShortcut();
      if (e.key === '@' || e.key === '2' || e.code === 'Digit2') openDriverShortcut();
      if (e.key === '#' || e.key === '3' || e.code === 'Digit3') openOps();
      if (e.key === '$' || e.key === '4' || e.code === 'Digit4') resetDemoData();
    });
  }

  // Phone/tablet navigation. The desktop nav is hidden below 1080px, so these
  // tabs are the mobile equivalent of Ride / Operations / Admin / Driver.
  function bindMobileTabs() {
    const tabs = $$('[data-mobile-nav]');
    if (!tabs.length) return;

    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.mobileNav;

        if (target === 'ride') {
          tabs.forEach((item) => item.classList.toggle('is-active', item === tab));
          if ($('#opsScreen') && !$('#opsScreen').hidden) closeOps();
          if (window.SIBAT_DRIVER) window.SIBAT_DRIVER.close();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } else if (target === 'ops') {
          openOps();
        } else if (target === 'driver') {
          openDriverShortcut();
        }
      });
    });
  }

  function openPassengerShortcut() {
    const account = S.getAccount();
    if (window.SIBAT_DRIVER) window.SIBAT_DRIVER.close();
    if ($('#opsScreen') && !$('#opsScreen').hidden) closeOps();

    // Already riding as a passenger: just re-enter the dashboard.
    if (account && account.role === 'passenger') {
      enterPassenger();
      return;
    }

    // The seeded demo passenger keeps rides consistent with the engine seed.
    const demo = {
      id: 'PAS-7001',
      role: 'passenger',
      name: 'Demo Passenger',
      email: 'demo@sibatna.ph',
      phone: '+63 917 123 4567',
      emergency: '+63 918 123 4567',
      status: 'offline',
      lat: 14.5995,
      lng: 120.9842,
      rating: 5,
      earnings: 0,
      trips: 0,
      demo: true
    };
    S.setAccount(demo);
    localStorage.removeItem(S.KEYS.activeRide);
    enterPassenger();
    S.toast(account && account.role === 'driver'
      ? 'Driver session swapped for the demo passenger.'
      : window.matchMedia('(max-width: 1080px)').matches
        ? 'Demo passenger — open Driver from the bottom bar.'
        : 'Demo passenger — try Ctrl+Shift+2 for the driver panel.', 'success', 3600);
  }

  // Ctrl+Shift+4: put the engine back to its seed state (earnings, trips,
  // rides, queues, settings) without touching the map theme or demo codes.
  async function resetDemoData() {
    try {
      await S.api('/reset', { method: 'POST', body: {} });
    } catch (err) {
      S.toast('Could not reset the demo data: ' + err.message, 'error', 4600);
      return;
    }

    localStorage.removeItem(S.KEYS.activeRide);
    app.activeRideId = null;
    app.demoPaused = false;
    app.demoRetries = 0;
    app.lastPopup = new Set();
    clearTimeout(app.demoTimer);
    app.demoTimer = null;

    // Keep the signed-in account only when the fresh seed still contains it.
    const account = S.getAccount();
    let accountSurvives = true;
    if (account) {
      try {
        const res = await S.api('/accounts');
        accountSurvives = (res.accounts || []).some(a => a && a.id === account.id);
      } catch (_) {
        accountSurvives = true; // cannot verify — keep the user signed in
      }
    }
    if (!accountSurvives) {
      try {
        sessionStorage.setItem('sibatNaNotice',
          'Demo data was reset — that account no longer exists. Log in again.');
      } catch (_) { /* storage blocked */ }
      S.clearAccount();
      window.location.reload();
      return;
    }

    window.dispatchEvent(new Event('sibat:demo-reset'));

    if (!$('#opsScreen').hidden) refreshOps();
    else if (!$('#appShell').hidden) refreshPassenger();

    S.toast('Demo data reset — earnings, trips and rides are back to seed.', 'success', 4200);
  }

  function openDriverShortcut() {
    const account = S.getAccount();
    const driver = account && account.role === 'driver' ? account : {
      id: 'DRV-100',
      name: 'Mika Reyes',
      role: 'driver',
      plate: 'NCR 2841',
      vehicle: 'Toyota Vios',
      demo: true
    };
    if (!account) {
      S.toast('Opening the demo driver account — log in as a driver for your own.', 'info', 3600);
    }
    if (window.SIBAT_DRIVER) window.SIBAT_DRIVER.open({ account: driver, skipGate: false });
  }

  // =====================================================================
  //  3. OPERATIONS CENTER
  // =====================================================================
  function openOps() {
    if (window.SIBAT_DRIVER) window.SIBAT_DRIVER.close();
    const subtitle = $('#opsSubtitle');
    if (subtitle) {
      subtitle.innerHTML = S.engine.local
        ? 'Local demo engine · edits are saved to this browser’s localStorage'
        : 'Live view of the C++ engine · edits are saved to <code>data/state.json</code>';
    }
    $('#opsScreen').hidden = false;
    $$('.nav-pill').forEach(p => p.classList.toggle('is-active', p.dataset.nav === 'ops'));
    refreshOps();
  }

  function closeOps() {
    $('#opsScreen').hidden = true;
    $$('.nav-pill').forEach(p => p.classList.toggle('is-active', p.dataset.nav === 'ride'));
  }

  function bindOps() {
    $('#opsClose').addEventListener('click', closeOps);
    $('#opsRefresh').addEventListener('click', refreshOps);

    $$('.ops-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        $$('.ops-tab').forEach(t => t.classList.toggle('is-active', t === tab));
        $$('.ops-panel').forEach(panel => {
          panel.classList.toggle('is-active', panel.dataset.opsPanel === tab.dataset.opsTab);
        });
        refreshOps();
      });
    });

    $('#serveNextBtn').addEventListener('click', async () => {
      try {
        const res = await S.api('/ops/serve-next', { method: 'POST' });
        S.toast(res.message || 'Served next ride.', 'success');
        refreshOps();
      } catch (err) {
        S.toast(err.message, 'error');
      }
    });

    $('#simRunBtn').addEventListener('click', runSimulation);
    $('#saveTextsBtn').addEventListener('click', saveUiTexts);

    $$('[data-add-location]').forEach(btn => btn.addEventListener('click', () => openLocationForm(null)));
    $$('[data-add-route]').forEach(btn => btn.addEventListener('click', () => openRouteForm(null)));

    $$('[data-nav="ops"]').forEach(btn => btn.addEventListener('click', openOps));
    $$('[data-nav="ride"]').forEach(btn => btn.addEventListener('click', () => {
      $$('.nav-pill').forEach(p => p.classList.toggle('is-active', p.dataset.nav === 'ride'));
      closeOps();
    }));
  }

  async function refreshOps() {
    if ($('#opsScreen').hidden) return;
    try {
      const res = await S.api('/state');
      app.opsState = res.state;
      renderOps(res.state);
    } catch (err) {
      S.toast('Operations needs the C++ engine: ' + err.message, 'error', 4200);
    }
  }

  function renderOps(state) {
    renderOpsStats($('#opsStats'), state.stats, false);
    renderDriversTable(state);
    renderOpsRides(state);
    renderLocationsTable(state);
    renderRoutesTable(state);
    renderQueueTable(state);
    renderTextEditor(state.ui || {});
  }

  function statCard(label, value, sub, tone) {
    return '<div class="stat-card"><small>' + S.escapeHtml(label) + '</small>' +
      '<strong' + (tone ? ' class="is-' + tone + '"' : '') + '>' + S.escapeHtml(value) + '</strong>' +
      (sub ? '<span>' + S.escapeHtml(sub) + '</span>' : '') + '</div>';
  }

  function renderOpsStats(target, stats, compact) {
    if (!target || !stats) return;
    const cards = [
      statCard('Revenue', S.money(stats.revenue), stats.completed + ' completed', 'gold'),
      statCard('Waiting', String(stats.pending), 'in shared queue', 'cyan'),
      statCard('Active', String(stats.active), 'matched / on trip'),
      statCard('Drivers online', String(stats.onlineDrivers), 'of ' + stats.drivers + ' total'),
      statCard('Avg fare', S.money(stats.avgFare), 'per completed trip'),
      statCard('Completion', stats.completionRate + '%', 'completed vs cancelled')
    ];
    target.innerHTML = compact ? cards.slice(0, 3).join('') : cards.join('');
  }

  function driverStatusCell(status) {
    const cls = status === 'online' ? 'is-online' : status === 'busy' ? 'is-busy' : '';
    return '<span class="dot-live ' + cls + '"></span>' + S.escapeHtml(status);
  }

  function renderDriversTable(state) {
    const table = $('#opsDrivers');
    const drivers = state.drivers || [];
    table.innerHTML =
      '<thead><tr><th>Driver</th><th>Status</th><th>Vehicle</th><th>Trips</th><th>Earnings</th></tr></thead><tbody>' +
      (drivers.length ? drivers.map(driver =>
        '<tr><td>' + S.escapeHtml(driver.name) + '<br><span class="muted mono">' + S.escapeHtml(driver.id) + '</span></td>' +
        '<td>' + driverStatusCell(driver.status) + '</td>' +
        '<td>' + S.escapeHtml(driver.vehicle || '—') + '<br><span class="muted mono">' + S.escapeHtml(driver.plate || '') + '</span></td>' +
        '<td class="mono">' + driver.trips + '</td>' +
        '<td class="mono">' + S.money(driver.earnings) + '</td></tr>'
      ).join('') : '<tr><td colspan="5" class="muted">No drivers yet.</td></tr>') +
      '</tbody>';
  }

  function renderOpsRides(state) {
    const table = $('#opsRides');
    const rides = (state.rides || []).slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 10);
    table.innerHTML =
      '<thead><tr><th>Ride</th><th>Passenger</th><th>Route</th><th>Status</th><th>Fare</th></tr></thead><tbody>' +
      (rides.length ? rides.map(ride =>
        '<tr><td class="mono">' + S.escapeHtml(ride.code) + '</td>' +
        '<td>' + S.escapeHtml(ride.passengerName) + '</td>' +
        '<td>' + S.escapeHtml(ride.pickupLabel) + ' → ' + S.escapeHtml(ride.destLabel) + '</td>' +
        '<td>' + S.escapeHtml(statusLabel(ride.status)) + '</td>' +
        '<td class="mono">' + S.money(ride.fare) + '</td></tr>'
      ).join('') : '<tr><td colspan="5" class="muted">No rides yet.</td></tr>') +
      '</tbody>';
  }

  function renderLocationsTable(state) {
    const table = $('#opsLocations');
    const locations = state.locations || [];
    table.innerHTML =
      '<thead><tr><th>Name</th><th>Zone</th><th>Coordinates</th><th>Active</th><th></th></tr></thead><tbody>' +
      (locations.length ? locations.map(location =>
        '<tr><td>' + S.escapeHtml(location.name) + '<br><span class="muted mono">' + S.escapeHtml(location.id) + '</span></td>' +
        '<td>' + S.escapeHtml(location.zone) + '</td>' +
        '<td class="mono">' + Number(location.lat).toFixed(4) + ', ' + Number(location.lng).toFixed(4) + '</td>' +
        '<td>' + (location.active ? '✓' : '—') + '</td>' +
        '<td><div class="row-actions">' +
          '<button type="button" class="link-btn" data-edit-location="' + S.escapeHtml(location.id) + '">Edit</button>' +
          '<button type="button" class="link-btn" data-delete-location="' + S.escapeHtml(location.id) + '">Delete</button>' +
        '</div></td></tr>'
      ).join('') : '<tr><td colspan="5" class="muted">No saved locations.</td></tr>') +
      '</tbody>';

    table.querySelectorAll('[data-edit-location]').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = locations.find(l => l.id === btn.dataset.editLocation);
        if (item) openLocationForm(item);
      });
    });
    table.querySelectorAll('[data-delete-location]').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = locations.find(l => l.id === btn.dataset.deleteLocation);
        if (!item) return;
        confirmDelete('location', item.name, () => S.api('/admin/locations/' + encodeURIComponent(item.id), { method: 'DELETE' }));
      });
    });
  }

  function renderRoutesTable(state) {
    const table = $('#opsRoutes');
    const routes = state.routes || [];
    table.innerHTML =
      '<thead><tr><th>Name</th><th>Corridor</th><th>Km</th><th>Base</th><th>Per km</th><th>Active</th><th></th></tr></thead><tbody>' +
      (routes.length ? routes.map(route =>
        '<tr><td>' + S.escapeHtml(route.name) + '<br><span class="muted mono">' + S.escapeHtml(route.id) + '</span></td>' +
        '<td>' + S.escapeHtml(route.from) + ' → ' + S.escapeHtml(route.to) + '</td>' +
        '<td class="mono">' + Number(route.km).toFixed(1) + '</td>' +
        '<td class="mono">' + S.money(route.baseFare) + '</td>' +
        '<td class="mono">' + S.money(route.perKm) + '</td>' +
        '<td>' + (route.active ? '✓' : '—') + '</td>' +
        '<td><div class="row-actions">' +
          '<button type="button" class="link-btn" data-edit-route="' + S.escapeHtml(route.id) + '">Edit</button>' +
          '<button type="button" class="link-btn" data-delete-route="' + S.escapeHtml(route.id) + '">Delete</button>' +
        '</div></td></tr>'
      ).join('') : '<tr><td colspan="7" class="muted">No routes yet.</td></tr>') +
      '</tbody>';

    table.querySelectorAll('[data-edit-route]').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = routes.find(r => r.id === btn.dataset.editRoute);
        if (item) openRouteForm(item);
      });
    });
    table.querySelectorAll('[data-delete-route]').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = routes.find(r => r.id === btn.dataset.deleteRoute);
        if (!item) return;
        confirmDelete('route', item.name, () => S.api('/admin/routes/' + encodeURIComponent(item.id), { method: 'DELETE' }));
      });
    });
  }

  function renderQueueTable(state) {
    const table = $('#opsQueue');
    const pending = (state.rides || []).filter(r => r.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt);
    table.innerHTML =
      '<thead><tr><th>#</th><th>Ride</th><th>Passenger</th><th>Corridor</th><th>Fare</th><th>Waiting</th></tr></thead><tbody>' +
      (pending.length ? pending.map((ride, index) =>
        '<tr><td class="mono">' + (index + 1) + '</td>' +
        '<td class="mono">' + S.escapeHtml(ride.code) + '</td>' +
        '<td>' + S.escapeHtml(ride.passengerName) + '</td>' +
        '<td>' + S.escapeHtml(ride.pickupArea || '—') + ' → ' + S.escapeHtml(ride.destArea || '—') + '</td>' +
        '<td class="mono">' + S.money(ride.fare) + '</td>' +
        '<td>' + S.timeAgo(ride.createdAt) + '</td></tr>'
      ).join('') : '<tr><td colspan="6" class="muted">The shared queue is empty.</td></tr>') +
      '</tbody>';
  }

  function renderTextEditor(ui) {
    const host = $('#textList');
    const keys = Object.keys(ui).sort();
    if (!keys.length) { host.innerHTML = '<p class="muted">No editable text keys yet.</p>'; return; }
    host.innerHTML = keys.map(key =>
      '<div class="text-row"><label for="text-' + S.escapeHtml(key) + '">' + S.escapeHtml(key) + '</label>' +
      '<input class="input" id="text-' + S.escapeHtml(key) + '" data-text-key="' + S.escapeHtml(key) + '" value="' + S.escapeHtml(ui[key]) + '" /></div>'
    ).join('');
  }

  async function saveUiTexts() {
    const ui = {};
    $$('#textList [data-text-key]').forEach(input => { ui[input.dataset.textKey] = input.value; });
    try {
      await S.api('/config', { method: 'POST', body: { ui } });
      applyUiTexts(ui);
      S.toast('Interface text saved.', 'success');
      refreshOps();
    } catch (err) {
      S.toast(err.message, 'error');
    }
  }

  async function runSimulation() {
    const steps = Number($('#simSteps').value || 5);
    const spawn = $('#simSpawn').checked;
    const log = $('#simLog');
    log.textContent = 'Running ' + steps + ' tick(s) in C++…';
    try {
      const res = await S.api('/ops/simulate', { method: 'POST', body: { steps, spawn } });
      log.textContent = res.message + '\nTick ' + (res.stats ? res.stats.tick : '?') +
        ' · queue ' + (res.stats ? res.stats.pending : '?') +
        ' · completed ' + (res.stats ? res.stats.completed : '?');
      renderOpsStats($('#simStats'), res.stats, true);
      if (res.state) {
        app.opsState = res.state;
        renderOps(res.state);
      }
      S.toast('Simulation finished.', 'success');
    } catch (err) {
      log.textContent = 'Simulation failed: ' + err.message;
      S.toast(err.message, 'error');
    }
  }

  function confirmDelete(kind, name, action) {
    S.openModal(
      '<h2>Delete this ' + S.escapeHtml(kind) + '?</h2>' +
      '<p><strong>' + S.escapeHtml(name) + '</strong> will be removed from the engine.</p>' +
      '<div class="modal-actions">' +
        '<button type="button" class="btn btn-ghost" data-modal-close>Keep</button>' +
        '<button type="button" class="btn btn-danger" id="confirmDeleteBtn">Delete</button>' +
      '</div>'
    );
    $('#confirmDeleteBtn').addEventListener('click', async () => {
      try {
        await action();
        S.closeModal();
        S.toast(kind.charAt(0).toUpperCase() + kind.slice(1) + ' deleted.', 'success');
        refreshOps();
      } catch (err) {
        S.toast(err.message, 'error');
      }
    }, { once: true });
  }

  function openLocationForm(item) {
    const editing = !!item;
    S.openModal(
      '<p class="eyebrow">' + (editing ? 'Edit' : 'New') + ' location</p>' +
      '<h2>' + (editing ? 'Update location' : 'Add a saved location') + '</h2>' +
      '<form id="entityForm">' +
        '<div class="form-grid" style="margin-top:14px">' +
          '<div class="field span-2"><label class="field-label">Name</label><input class="input" name="name" required value="' + S.escapeHtml(item ? item.name : '') + '" /></div>' +
          '<div class="field span-2"><label class="field-label">Zone</label><input class="input" name="zone" value="' + S.escapeHtml(item ? item.zone : '') + '" placeholder="Quezon City" /></div>' +
          '<div class="field"><label class="field-label">Latitude</label><input class="input" name="lat" type="number" step="any" value="' + (item ? item.lat : 14.5995) + '" /></div>' +
          '<div class="field"><label class="field-label">Longitude</label><input class="input" name="lng" type="number" step="any" value="' + (item ? item.lng : 120.9842) + '" /></div>' +
          '<label class="check-row span-2"><input type="checkbox" name="active"' + (!item || item.active ? ' checked' : '') + ' /> Active</label>' +
        '</div>' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn btn-ghost" data-modal-close>Cancel</button>' +
          '<button type="submit" class="btn btn-primary">' + (editing ? 'Save changes' : 'Add location') + '</button>' +
        '</div>' +
      '</form>'
    );
    $('#entityForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = new FormData(e.target);
      const payload = {
        name: String(data.get('name') || '').trim(),
        zone: String(data.get('zone') || '').trim(),
        lat: Number(data.get('lat')),
        lng: Number(data.get('lng')),
        active: data.get('active') === 'on'
      };
      try {
        await S.api('/admin/locations' + (editing ? '/' + encodeURIComponent(item.id) : ''), {
          method: editing ? 'PUT' : 'POST',
          body: payload
        });
        S.closeModal();
        S.toast(editing ? 'Location updated.' : 'Location added.', 'success');
        refreshOps();
      } catch (err) {
        S.toast(err.message, 'error');
      }
    });
  }

  function openRouteForm(item) {
    const editing = !!item;
    S.openModal(
      '<p class="eyebrow">' + (editing ? 'Edit' : 'New') + ' route</p>' +
      '<h2>' + (editing ? 'Update corridor' : 'Add a fare corridor') + '</h2>' +
      '<form id="entityForm">' +
        '<div class="form-grid" style="margin-top:14px">' +
          '<div class="field span-2"><label class="field-label">Name</label><input class="input" name="name" required value="' + S.escapeHtml(item ? item.name : '') + '" /></div>' +
          '<div class="field"><label class="field-label">From zone</label><input class="input" name="from" value="' + S.escapeHtml(item ? item.from : '') + '" /></div>' +
          '<div class="field"><label class="field-label">To zone</label><input class="input" name="to" value="' + S.escapeHtml(item ? item.to : '') + '" /></div>' +
          '<div class="field"><label class="field-label">Distance km</label><input class="input" name="km" type="number" step="0.1" value="' + (item ? item.km : 5) + '" /></div>' +
          '<div class="field"><label class="field-label">Base fare</label><input class="input" name="baseFare" type="number" step="0.01" value="' + (item ? item.baseFare : 15) + '" /></div>' +
          '<div class="field"><label class="field-label">Per km</label><input class="input" name="perKm" type="number" step="0.01" value="' + (item ? item.perKm : 2.5) + '" /></div>' +
          '<label class="check-row span-2"><input type="checkbox" name="active"' + (!item || item.active ? ' checked' : '') + ' /> Active</label>' +
        '</div>' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn btn-ghost" data-modal-close>Cancel</button>' +
          '<button type="submit" class="btn btn-primary">' + (editing ? 'Save changes' : 'Add route') + '</button>' +
        '</div>' +
      '</form>'
    );
    $('#entityForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = new FormData(e.target);
      const payload = {
        name: String(data.get('name') || '').trim(),
        from: String(data.get('from') || '').trim(),
        to: String(data.get('to') || '').trim(),
        km: Number(data.get('km')),
        baseFare: Number(data.get('baseFare')),
        perKm: Number(data.get('perKm')),
        active: data.get('active') === 'on'
      };
      try {
        await S.api('/admin/routes' + (editing ? '/' + encodeURIComponent(item.id) : ''), {
          method: editing ? 'PUT' : 'POST',
          body: payload
        });
        S.closeModal();
        S.toast(editing ? 'Route updated.' : 'Route added.', 'success');
        refreshOps();
      } catch (err) {
        S.toast(err.message, 'error');
      }
    });
  }

  // =====================================================================
  //  4. PUBLIC HOOKS + BOOT
  // =====================================================================
  window.SIBAT_APP = {
    openOps,
    closeOps,
    refreshPassenger,
    enterPassenger,
    get account() { return S.getAccount(); },
    // Debug/automation hook: lets the UI test inspect the live MapLibre instance.
    getMap() { return app.map; }
  };

  function boot() {
    bindGlobal();
    bindLogin();
    bindOps();
    bindShortcuts();
    bindMobileTabs();
    showStep(0);
    document.body.classList.add('auth-open');
    updateGreetingTime();
    setInterval(updateGreetingTime, 60000);

    // If the URL is #driver, jump into the driver gate after boot.
    if (location.hash === '#driver') {
      setTimeout(openDriverShortcut, 500);
    }

    const account = S.getAccount();
    if (account) {
      enterPassenger();
      if (account.role === 'driver' && window.SIBAT_DRIVER) {
        setTimeout(() => window.SIBAT_DRIVER.open({ account: account, skipGate: true }), 350);
      }
    }

    checkEngine(false);
    setInterval(() => { if (!S.engine.online) checkEngine(false); }, 12000);

    try {
      const notice = sessionStorage.getItem('sibatNaNotice');
      if (notice) {
        sessionStorage.removeItem('sibatNaNotice');
        setTimeout(() => S.toast(notice, 'info', 5200), 900);
      }
    } catch (_) { /* storage blocked */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
