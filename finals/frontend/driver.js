/* ==========================================================================
   SIBAT NA — frontend/driver.js
   In-page Grab-style driver mode.
   FLOW: gate (2468) → online → 3s match animation → offer → accept/reject
         → arriving → at_pickup → on_trip → completed (earnings + log)
   All state changes are persisted by the C++ engine.
   ========================================================================== */
(function () {
  'use strict';

  const S = window.SIBAT;
  const { $, $$ } = S;

  const state = {
    opened: false,
    gateUnlocked: false,
    account: null,
    demo: false,
    status: 'offline',
    matching: false,
    matchTimer: null,
    countdown: 3,
    offerSeconds: 15,
    offerTimer: null,
    ride: null,
    map: null,
    poll: null,
    pollBusy: false,
    phaseBusy: false,
    routeKey: '',
    renderedKey: '',
    wasAppVisible: false,
    heartbeatTimer: null
  };

  // ---------------------------------------------------------------------
  //  SMALL HELPERS
  // ---------------------------------------------------------------------
  const driverId = () => (state.account && state.account.id) || '';
  const isLocalOnly = () => /^DRV-LOCAL/.test(driverId());

  // Signals the passenger tab's demo autopilot that a human driver is present.
  function markDriverOpen() {
    try { localStorage.setItem('sibatNaDriverOpen', String(Date.now())); } catch (_) {}
  }
  function clearDriverOpen() {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
    try { localStorage.removeItem('sibatNaDriverOpen'); } catch (_) {}
  }

  function initials(name) {
    return String(name || 'Driver').trim().split(/\s+/).slice(0, 2)
      .map(p => p.charAt(0).toUpperCase()).join('') || 'DR';
  }

  function driverStatusText() {
    const phase = state.ride ? state.ride.status : '';
    if (phase === 'offered') return 'OFFER';
    if (phase === 'arriving') return 'TO PICKUP';
    if (phase === 'at_pickup') return 'AT PICKUP';
    if (phase === 'on_trip') return 'ON TRIP';
    if (state.status === 'busy') return 'ON TRIP';
    return state.status === 'online' ? 'ONLINE' : 'OFFLINE';
  }

  function setStatusChip() {
    const chip = $('#driverStatusChip');
    const phase = state.ride ? state.ride.status : '';
    chip.textContent = driverStatusText();
    chip.className = 'chip ' + (state.ride || state.status === 'busy' ? 'chip-gold'
      : state.status === 'online' ? 'chip-cyan' : '');
    const toggle = $('#driverOnlineToggle');
    toggle.checked = state.status !== 'offline';
    toggle.disabled = !!state.ride;
    const label = $('#driverOnlineLabel');
    label.textContent = phase === 'offered' ? 'Offer'
      : phase === 'arriving' ? 'To pickup'
      : phase === 'at_pickup' ? 'At pickup'
      : phase === 'on_trip' ? 'On trip'
      : state.status === 'offline' ? 'Go online' : 'Online';
  }

  function updateEarnings(driver) {
    if (driver) {
      Object.assign(state.account, {
        name: driver.name || state.account.name,
        plate: driver.plate || state.account.plate,
        vehicle: driver.vehicle || state.account.vehicle,
        earnings: Number(driver.earnings || 0),
        trips: Number(driver.trips || 0),
        rating: Number(driver.rating || 4.9),
        status: driver.status || state.status
      });
      state.status = driver.status || state.status;
    }
    $('#driverEarningsBar').textContent = S.money(state.account.earnings || 0);
    $('#driverNameBar').textContent = state.account.name || 'Driver';
    $('#earnToday').textContent = S.money(state.account.earnings || 0);
    $('#earnTrips').textContent = String(state.account.trips || 0);
    $('#earnRating').textContent = Number(state.account.rating || 4.9).toFixed(2) + ' ★';
    updateProfileCard();
    setStatusChip();
  }

  function updateProfileCard() {
    const name = state.account.name || 'Driver';
    const avatar = initials(name);
    const vehicle = [state.account.plate, state.account.vehicle].filter(Boolean).join(' · ');
    $('#driverAvatar').textContent = avatar;
    $('#driverAvatarLg').textContent = avatar;
    $('#driverProfileName').textContent = name;
    $('#driverProfileMeta').textContent = vehicle || (state.demo ? 'Demo driver account' : 'Sibat Na driver');
    $('#driverProfileRating').textContent = Number(state.account.rating || 4.9).toFixed(2) + ' ★';
    $('#driverProfileTrips').textContent = String(state.account.trips || 0);
    $('#driverProfileEarnings').textContent = S.money(state.account.earnings || 0);
  }

  function toggleProfileMenu(force) {
    const button = $('#driverProfileBtn');
    const menu = $('#driverProfileMenu');
    const open = typeof force === 'boolean' ? force : menu.hidden;
    if (open) updateProfileCard();
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  }
  function closeProfileMenu() {
    toggleProfileMenu(false);
  }

  // ---------------------------------------------------------------------
  //  OPEN / CLOSE + DEMO GATE (code 2468)
  // ---------------------------------------------------------------------
  function open(options) {
    const opts = options || {};
    state.account = opts.account || S.getAccount() || { id: 'DRV-100', name: 'Mika Reyes', role: 'driver' };
    state.demo = !!state.account.demo;
    state.ride = null;
    state.renderedKey = '';
    state.wasAppVisible = !$('#appShell').hidden;

    $('#driverMode').hidden = false;
    $('#opsScreen').hidden = true;
    if (state.wasAppVisible) $('#appShell').hidden = true;
    $('#authScreen').hidden = true;
    state.opened = true;
    markDriverOpen();
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = setInterval(markDriverOpen, 3000);

    $('#driverNameBar').textContent = state.account.name || 'Driver';
    updateEarnings(state.account);

    if (opts.skipGate || state.gateUnlocked) {
      enterDriver();
    } else {
      showGate();
    }
  }

  function close(options) {
    if (!state.opened) return;
    state.opened = false;
    state.matching = false;
    clearInterval(state.matchTimer);
    clearInterval(state.offerTimer);
    clearInterval(state.poll);
    clearDriverOpen();
    closeProfileMenu();
    $('#driverMode').hidden = true;
    $('#driverGate').hidden = true;

    const account = S.getAccount();

    // Log out on a logged-in DRIVER ends the driver session and returns to the
    // passenger login — not to the passenger dashboard with a Driver badge.
    if (options && options.logoutDriver && account && account.role === 'driver') {
      try {
        sessionStorage.setItem('sibatNaNotice', 'Driver session closed. Log in as a passenger to book a ride.');
      } catch (_) { /* ignore */ }
      S.clearAccount();
      window.location.reload();
      return;
    }

    if (options && options.logoutDriver) {
      S.toast('Logged out of driver mode.', 'info', 2400);
    }

    // Otherwise (passenger using the demo driver, gate cancel, Ops shortcut):
    if (account) {
      if (window.SIBAT_APP && typeof window.SIBAT_APP.enterPassenger === 'function') {
        window.SIBAT_APP.enterPassenger();
      } else {
        $('#appShell').hidden = false;
        $('#authScreen').hidden = true;
      }
    } else {
      $('#appShell').hidden = true;
      $('#authScreen').hidden = false;
    }
    window.dispatchEvent(new Event('sibat:driver-closed'));
  }

  function showGate() {
    $('#driverGate').hidden = false;
    $('#driverGateCode').value = '';
    $('#gateError').textContent = '';
    setTimeout(() => $('#driverGateCode').focus(), 100);
  }

  function unlockGate(event) {
    event.preventDefault();
    const code = $('#driverGateCode').value.trim();
    if (code !== '2468') {
      $('#gateError').textContent = 'Wrong gate code. The demo code is 2468.';
      $('#driverGateCode').select();
      return;
    }
    state.gateUnlocked = true;
    $('#gateError').textContent = '';
    $('#driverGate').hidden = true;
    S.toast('Driver gate unlocked.', 'success', 1800);
    enterDriver();
  }

  async function enterDriver() {
    $('#driverGate').hidden = true;
    if (!state.map) {
      setTimeout(initMap, 80);
    } else {
      setTimeout(() => state.map.resize(), 60);
    }
    showIdle();
    await refreshDriver();
    clearInterval(state.poll);
    state.poll = setInterval(() => {
      if (document.visibilityState === 'visible') refreshDriver();
    }, 2600);

    if (state.status === 'online' && !state.ride) {
      S.toast('You are online. Starting a demo match…', 'info', 2000);
      setTimeout(startMatching, 700);
    }
  }

  // ---------------------------------------------------------------------
  //  MAP + ROUTE PREVIEW
  // ---------------------------------------------------------------------
  function initMap() {
    if (state.map || !$('#driverMap')) return;
    state.map = new S.SibatMap('#driverMap', {
      center: { lat: state.account.lat || 14.5995, lng: state.account.lng || 120.9842 },
      zoom: 12
    });
    state.map.resize();
  }

  async function previewRide(ride) {
    if (!state.map || !ride) return;
    // The panel may have been hidden/reopened; make sure MapLibre has the new size.
    state.map.resize();
    const key = ride.id + ':' + ride.status;
    if (state.routeKey === key) return;
    state.routeKey = key;

    state.map.setPickupMarker(
      { lat: ride.pickupLat, lng: ride.pickupLng },
      ride.pickupLabel
    );
    state.map.setDestination({ lat: ride.destLat, lng: ride.destLng }, ride.destLabel);
    state.map.setCenter(ride.pickupLat, ride.pickupLng, { silent: true });

    const from = { lat: ride.pickupLat, lng: ride.pickupLng };
    const to = { lat: ride.destLat, lng: ride.destLng };
    state.map.drawRoute(S.straightRoute(from, to));
    try {
      const route = await S.fetchRoute(from, to);
      if (state.routeKey === key) state.map.drawRoute(route);
    } catch (_) { /* straight line stays */ }
    if (state.map.gl) state.map.gl.triggerRepaint();
  }

  // ---------------------------------------------------------------------
  //  SERVER SYNC
  // ---------------------------------------------------------------------
  async function refreshDriver() {
    if (state.pollBusy || !state.opened) return;
    state.pollBusy = true;
    try {
      const res = await S.api('/state');
      const snapshot = res.state;
      const me = (snapshot.drivers || []).find(d => d.id === driverId());
      if (me) updateEarnings(me);
      renderTripLog(snapshot);
      if (!state.account.demo) {
        // keep the local account in sync for the passenger shell
        const stored = S.getAccount();
        if (stored && stored.id === me?.id) {
          Object.assign(stored, { earnings: me.earnings, trips: me.trips, rating: me.rating, status: me.status });
          S.setAccount(stored);
        }
      }

      if (state.matching) return;

      const active = (snapshot.rides || [])
        .filter(r => r.driverId === driverId() && ['offered', 'arriving', 'at_pickup', 'on_trip'].includes(r.status))
        .sort((a, b) => (b.matchedAt || b.createdAt) - (a.matchedAt || a.createdAt))[0];

      if (!active) {
        if (state.ride) {
          state.ride = null;
          state.routeKey = '';
          if (state.map) state.map.clearRoute();
        }
        if (!state.matching) showIdle();
        return;
      }

      state.ride = active;
      if (active.status === 'offered') showOffer(active, true);
      else showTrip(active);
    } catch (_) {
      updateEngineState(false);
    } finally {
      state.pollBusy = false;
    }
  }

  function updateEngineState(online) {
    if (!online) {
      const chip = $('#driverStatusChip');
      chip.textContent = 'ENGINE OFFLINE';
      chip.className = 'chip chip-red';
    }
  }

  // Called after Ctrl+Shift+4 resets the engine: drop every reference to the
  // old demo data, then re-read the seed driver/earnings from the engine.
  function resetDemoSession() {
    clearInterval(state.matchTimer);
    clearInterval(state.offerTimer);
    state.matching = false;
    state.phaseBusy = false;
    state.ride = null;
    state.routeKey = '';
    state.renderedKey = '';
    closeProfileMenu();
    if (state.map) {
      state.map.clearRoute();
      state.map.clearPickupMarker();
    }
    updateEarnings(state.account);
    showIdle();
    refreshDriver();
  }

  function renderTripLog(snapshot) {
    const log = $('#driverTripLog');
    const rides = (snapshot.rides || [])
      .filter(r => r.driverId === driverId() && r.status === 'completed')
      .sort((a, b) => (b.completedAt || b.createdAt) - (a.completedAt || a.createdAt))
      .slice(0, 6);
    if (!rides.length) {
      log.innerHTML = '<li class="empty-row">No completed trips yet.</li>';
      return;
    }
    log.innerHTML = rides.map(ride =>
      '<li>' +
        '<span class="recent-icon">✓</span>' +
        '<span class="recent-body"><strong>' + S.escapeHtml(ride.destLabel) + '</strong>' +
        '<small>' + S.escapeHtml(ride.code) + ' · ' + S.timeAgo(ride.completedAt) + '</small></span>' +
        '<span class="recent-fare">' + S.money(ride.fare * 0.8) + '</span>' +
      '</li>'
    ).join('');
  }

  // ---------------------------------------------------------------------
  //  IDLE + ONLINE TOGGLE
  // ---------------------------------------------------------------------
  function showIdle() {
    if (state.matching) return;
    if (!state.ride && state.map) {
      state.map.clearRoute();
      state.map.clearPickupMarker();
    }
    $('#driverIdle').hidden = false;
    $('#driverMatching').hidden = true;
    $('#driverOffer').hidden = true;
    $('#driverTrip').hidden = true;

    const online = state.status === 'online';
    $('#driverScanner').classList.toggle('is-live', online);
    $('#scannerLabel').textContent = online
      ? 'Online · ready for the next passenger'
      : 'You are offline';
    $('#driverGoOnline').textContent = online ? 'Find a passenger now' : 'Go online';
    $('#driverGoOnline').disabled = isLocalOnly();
    if (isLocalOnly()) {
      $('#scannerLabel').textContent = 'Local-only account — start the engine to dispatch';
    }
    setStatusChip();
  }

  async function setOnline(online) {
    if (isLocalOnly()) {
      S.toast('Start run.bat so the C++ engine can dispatch rides.', 'error', 4200);
      $('#driverOnlineToggle').checked = false;
      return;
    }
    try {
      const res = await S.api('/drivers/' + encodeURIComponent(driverId()) + '/status', {
        method: 'POST',
        body: { status: online ? 'online' : 'offline' }
      });
      state.account = Object.assign({}, state.account, res.account);
      state.status = res.account.status;
      updateEarnings(res.account);
      showIdle();
      if (online) {
        S.toast('You are online.', 'success', 1800);
        setTimeout(startMatching, 500);
      } else {
        S.toast('You are offline.', 'info', 1800);
      }
    } catch (err) {
      S.toast(err.message, 'error', 4000);
      $('#driverOnlineToggle').checked = state.status !== 'offline';
    }
  }

  function toggleOnline(checked) {
    if (state.ride) {
      S.toast('Finish the active trip before going offline.', 'error');
      $('#driverOnlineToggle').checked = true;
      return;
    }
    setOnline(checked);
  }

  // ---------------------------------------------------------------------
  //  3-SECOND MATCH ANIMATION
  // ---------------------------------------------------------------------
  function startMatching() {
    if (state.matching || state.ride) return;
    if (state.status !== 'online') {
      S.toast('Go online first.', 'info');
      return;
    }
    state.matching = true;
    state.countdown = 3;
    clearInterval(state.matchTimer);

    $('#driverIdle').hidden = true;
    $('#driverOffer').hidden = true;
    $('#driverTrip').hidden = true;
    $('#driverMatching').hidden = false;
    $('#matchCountdown').textContent = '3';
    $('#matchCorridor').textContent = 'any corridor';

    state.matchTimer = setInterval(async () => {
      state.countdown -= 1;
      $('#matchCountdown').textContent = String(Math.max(state.countdown, 0));
      if (state.countdown > 0) return;

      clearInterval(state.matchTimer);
      $('#matchCountdown').textContent = '✓';
      await requestMatch();
    }, 1000);
  }

  function cancelMatching() {
    clearInterval(state.matchTimer);
    state.matching = false;
    showIdle();
  }

  async function requestMatch() {
    if (isLocalOnly()) {
      state.matching = false;
      showIdle();
      S.toast('Engine offline — cannot match.', 'error');
      return;
    }
    try {
      const res = await S.api('/drivers/' + encodeURIComponent(driverId()) + '/match', { method: 'POST' });
      state.matching = false;
      state.ride = res.ride;
      state.status = 'busy';
      showOffer(res.ride, false);
    } catch (err) {
      state.matching = false;
      showIdle();
      const message = /No passenger/i.test(err.message)
        ? 'No passenger nearby this time. Tap “Find a passenger now” to retry.'
        : err.message;
      S.toast(message, 'info', 4200);
    }
  }

  // ---------------------------------------------------------------------
  //  OFFER CARD + ACCEPT / REJECT
  // ---------------------------------------------------------------------
  function showOffer(ride, fromPoll) {
    state.ride = ride;
    $('#driverIdle').hidden = true;
    $('#driverMatching').hidden = true;
    $('#driverTrip').hidden = true;
    $('#driverOffer').hidden = false;

    $('#offerName').textContent = ride.passengerName;
    $('#offerCode').textContent = ride.code + ' · ' + (ride.seats || 1) + ' seat' + (ride.seats > 1 ? 's' : '');
    $('#offerPickup').textContent = ride.pickupLabel;
    $('#offerDest').textContent = ride.destLabel;
    $('#offerKm').textContent = S.km(ride.distanceKm);
    $('#offerFare').textContent = S.money(ride.fare);
    $('#offerShare').textContent = S.money(ride.fare * 0.8);
    setStatusChip();
    previewRide(ride);

    if (fromPoll) return; // don't reset a countdown the driver is watching
    clearInterval(state.offerTimer);
    state.offerSeconds = 15;
    $('#offerTimer').textContent = '15s';
    state.offerTimer = setInterval(() => {
      state.offerSeconds -= 1;
      $('#offerTimer').textContent = Math.max(state.offerSeconds, 0) + 's';
      if (state.offerSeconds <= 0) {
        clearInterval(state.offerTimer);
        rejectOffer(true);
      }
    }, 1000);
  }

  async function acceptOffer() {
    if (!state.ride) return;
    clearInterval(state.offerTimer);
    const button = $('#acceptRideBtn');
    button.disabled = true;
    try {
      const res = await S.api('/drivers/' + encodeURIComponent(driverId()) + '/accept', {
        method: 'POST',
        body: { rideId: state.ride.id }
      });
      state.ride = res.ride;
      state.status = 'busy';
      S.toast('Ride accepted. Head to the pickup pin.', 'success');
      showTrip(res.ride);
      refreshDriver();
    } catch (err) {
      S.toast(err.message, 'error');
      state.ride = null;
      showIdle();
      refreshDriver();
    } finally {
      button.disabled = false;
    }
  }

  async function rejectOffer(auto) {
    if (!state.ride) return;
    clearInterval(state.offerTimer);
    const rideId = state.ride.id;
    try {
      await S.api('/drivers/' + encodeURIComponent(driverId()) + '/reject', {
        method: 'POST',
        body: { rideId }
      });
      state.ride = null;
      state.status = 'online';
      showIdle();
      setStatusChip();
      S.toast(auto ? 'Offer expired — returned to the shared queue.' : 'Offer rejected.', 'info');
    } catch (err) {
      S.toast(err.message, 'error');
      state.ride = null;
      showIdle();
      refreshDriver();
    }
  }

  // ---------------------------------------------------------------------
  //  ACTIVE TRIP PHASES
  // ---------------------------------------------------------------------
  const PHASE_LABEL = {
    arriving: 'I’ve arrived at pickup',
    at_pickup: 'Start the trip',
    on_trip: 'Complete the trip',
    completed: 'Completed'
  };
  const PHASE_ORDER = ['arriving', 'at_pickup', 'on_trip', 'completed'];

  function showTrip(ride) {
    state.ride = ride;
    $('#driverIdle').hidden = true;
    $('#driverMatching').hidden = true;
    $('#driverOffer').hidden = true;
    $('#driverTrip').hidden = false;

    $('#tripPassenger').textContent = ride.passengerName;
    $('#tripCode').textContent = ride.code + ' · ' + ride.phone;
    $('#tripPickup').textContent = ride.pickupLabel;
    $('#tripDest').textContent = ride.destLabel;
    $('#tripFare').textContent = S.money(ride.fare);
    $('#tripKm').textContent = S.km(ride.distanceKm);

    const pill = $('#tripPhasePill');
    pill.textContent = ride.status.replace('_', ' ').toUpperCase();
    pill.className = 'status-pill ' + (ride.status === 'arriving' ? 'is-live' : 'is-live');

    const idx = PHASE_ORDER.indexOf(ride.status);
    $$('#phaseTrack span').forEach((span, i) => {
      span.classList.toggle('is-done', i < idx);
      span.classList.toggle('is-current', i === idx);
    });

    $('#phaseBtn').textContent = PHASE_LABEL[ride.status] || 'Advance';
    $('#phaseBtn').disabled = false;

    const eta = ride.status === 'arriving' ? 'Heading to pickup'
      : ride.status === 'at_pickup' ? 'Waiting at pickup'
      : 'Passenger on board';
    $('#tripEta').textContent = eta;

    $('#abandonTripBtn').disabled = ride.status === 'on_trip';
    setStatusChip();
    previewRide(ride);
  }

  async function advancePhase() {
    if (!state.ride || state.phaseBusy) return;
    const next = ({ arriving: 'at_pickup', at_pickup: 'on_trip', on_trip: 'completed' })[state.ride.status];
    if (!next) return;
    state.phaseBusy = true;
    $('#phaseBtn').disabled = true;
    try {
      const res = await S.api('/drivers/' + encodeURIComponent(driverId()) + '/phase', {
        method: 'POST',
        body: { rideId: state.ride.id, phase: next }
      });
      if (next === 'completed') {
        const completed = res.ride;
        S.toast('Trip complete · fare ' + S.money(completed.fare) +
          ' · your 80% share ' + S.money(completed.fare * 0.8), 'success', 5000);
        state.ride = null;
        state.status = 'online';
        state.routeKey = '';
        if (state.map) { state.map.clearRoute(); state.map.clearPickupMarker(); }
        showIdle();
        refreshDriver();
      } else {
        state.ride = res.ride;
        showTrip(res.ride);
        S.toast(next === 'at_pickup' ? 'Marked at pickup.' : 'Trip started.', 'success');
      }
    } catch (err) {
      S.toast(err.message, 'error');
      $('#phaseBtn').disabled = false;
    } finally {
      state.phaseBusy = false;
    }
  }

  function abandonTrip() {
    if (!state.ride) return;
    const ride = state.ride;
    S.openModal(
      '<h2>Cancel this trip?</h2>' +
      '<p>' + S.escapeHtml(ride.passengerName) + ' will return to the shared queue and you stay online.</p>' +
      '<div class="modal-actions">' +
        '<button type="button" class="btn btn-ghost" data-modal-close>Keep trip</button>' +
        '<button type="button" class="btn btn-danger" id="confirmAbandon">Cancel trip</button>' +
      '</div>'
    );
    $('#confirmAbandon').addEventListener('click', async () => {
      try {
        await S.api('/rides/' + encodeURIComponent(ride.id) + '/cancel', { method: 'POST' });
        S.closeModal();
        state.ride = null;
        state.status = 'online';
        state.routeKey = '';
        if (state.map) { state.map.clearRoute(); state.map.clearPickupMarker(); }
        showIdle();
        S.toast('Trip cancelled; passenger re-queued.', 'info');
      } catch (err) {
        S.toast(err.message, 'error');
      }
    }, { once: true });
  }

  function openNavigation() {
    if (!state.ride) return;
    const target = state.ride.status === 'on_trip'
      ? { lat: state.ride.destLat, lng: state.ride.destLng }
      : { lat: state.ride.pickupLat, lng: state.ride.pickupLng };
    const url = 'https://www.google.com/maps/dir/?api=1&destination=' + target.lat + ',' + target.lng +
      '&travelmode=driving';
    window.open(url, '_blank', 'noopener');
  }

  function locateDriver() {
    if (!navigator.geolocation) {
      S.toast('Location access is unavailable in this browser.', 'error');
      return;
    }
    navigator.geolocation.getCurrentPosition(async (position) => {
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;
      state.account.lat = lat;
      state.account.lng = lng;
      if (state.map) state.map.flyTo(lat, lng, 15);
      try {
        await S.api('/drivers/' + encodeURIComponent(driverId()) + '/location', {
          method: 'POST',
          body: { lat, lng }
        });
      } catch (_) { /* local demo still moves the map */ }
      S.toast('Driver location updated.', 'success', 1800);
    }, () => {
      S.toast('Could not get your location.', 'error');
    }, { enableHighAccuracy: true, timeout: 8000 });
  }

  // ---------------------------------------------------------------------
  //  BINDINGS
  // ---------------------------------------------------------------------
  function bind() {
    $('#driverGateForm').addEventListener('submit', unlockGate);
    $('#gateCancel').addEventListener('click', () => { $('#driverGate').hidden = true; close(); });
    $('#driverGateCode').addEventListener('input', (e) => {
      e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
      $('#gateError').textContent = '';
    });

    $('#driverProfileBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleProfileMenu();
    });
    $('#driverLogoutBtn').addEventListener('click', () => {
      closeProfileMenu();
      close({ logoutDriver: true });
    });
    $('#driverBack').addEventListener('click', () => close());
    document.addEventListener('click', (e) => {
      if (!state.opened || $('#driverProfileMenu').hidden) return;
      if (e.target.closest && e.target.closest('.driver-profile-wrap')) return;
      closeProfileMenu();
    });
    $('#driverOnlineToggle').addEventListener('change', (e) => toggleOnline(e.target.checked));
    $('#driverGoOnline').addEventListener('click', () => {
      if (state.status === 'offline') {
        setOnline(true);
      } else {
        startMatching();
      }
    });
    $('#cancelMatchBtn').addEventListener('click', cancelMatching);
    $('#acceptRideBtn').addEventListener('click', acceptOffer);
    $('#rejectRideBtn').addEventListener('click', () => rejectOffer(false));
    $('#phaseBtn').addEventListener('click', advancePhase);
    $('#navigateBtn').addEventListener('click', openNavigation);
    $('#abandonTripBtn').addEventListener('click', abandonTrip);

    $('#driverLocate').addEventListener('click', locateDriver);
    $('#driverFitRoute').addEventListener('click', () => {
      if (state.map && state.map.route) state.map.drawRoute(state.map.route);
      else S.toast('No active route to fit yet.', 'info');
    });

    // Keep the driver map in sync when the shared day/night toggle changes.
    window.addEventListener('sibat:theme', () => {
      if (state.map) state.map.applyRouteTheme();
    });

    window.addEventListener('beforeunload', clearDriverOpen);

    // Ctrl+Shift+4 resets the engine; put the driver panel back to idle/seed.
    window.addEventListener('sibat:demo-reset', () => {
      if (state.opened) resetDemoSession();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.opened) {
        if (!$('#driverProfileMenu').hidden) { closeProfileMenu(); return; }
        if (!$('#driverGate').hidden) return;
        if (!state.matching && !state.ride) close({ logoutDriver: true });
      }
    });
  }

  // ---------------------------------------------------------------------
  //  EXPORT
  // ---------------------------------------------------------------------
  window.SIBAT_DRIVER = { open, close, resetDemoSession, getMap: () => state.map };
  bind();
})();
