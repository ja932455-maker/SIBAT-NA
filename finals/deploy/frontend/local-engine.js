/* ==========================================================================
   SIBAT NA — frontend/local-engine.js
   BROWSER-LOCAL FALLBACK (used only when the C++ server is unreachable,
   e.g. when index.html is opened directly with file://).

   WHY THIS EXISTS
     The primary engine is backend/src/core.cpp. But a demo project should
     still work if someone double-clicks index.html. This file mirrors the
     same fare, queue, matching and phase rules in JavaScript and stores
     state in localStorage so booking and driver mode keep working.

     When run.bat is running, shared.js talks to the C++ engine and this
     file is never called. C++ remains the authoritative engine.

   DEMO CODES: OTP 123456 · driver gate 2468
   ========================================================================== */
(function () {
  'use strict';

  const STORE_KEY = 'sibatna.local.v1';
  const MIRROR_KEY = 'sibatna.transport.v1';   // documented shared queue key
  const ACCOUNT_KEY = 'sibatNaAccount';
  const CURRENCY = '\u20B1';                   // ₱

  const now = () => Date.now();
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

  function haversineKm(a, b) {
    const R = 6371;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLng = (b.lng - a.lng) * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) *
      Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function normalizeZone(value) {
    const out = String(value || 'unzoned').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return out || 'unzoned';
  }

  function makeQueueKey(pickupArea, destArea) {
    return normalizeZone(pickupArea || 'shared') + '>' + normalizeZone(destArea || 'shared');
  }

  function areaFromLabel(label) {
    const parts = String(label || '').split(',').map(p => p.trim()).filter(Boolean);
    return parts.length > 1 ? parts[parts.length - 2] : (parts[0] || 'Shared');
  }

  function computeFare(km, settings) {
    const base = Number(settings.baseFare || 15);
    const included = Number(settings.includedKm || 4);
    const perKm = Number(settings.perKm || 2.5);
    const fare = base + Math.max(0, Number(km || 0) - included) * perKm;
    return round2(Math.max(base, fare));
  }

  function byCreated(a, b) {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return String(a.id).localeCompare(String(b.id));
  }

  // ---------------------------------------------------------------------
  //  SEED — mirrors backend/src/core.cpp seedState()
  // ---------------------------------------------------------------------
  function seed() {
    const state = {
      version: 1,
      seq: 5000,
      tick: 42,
      accounts: [],
      rides: [],
      routes: [],
      locations: [],
      settings: {
        serviceName: 'Sibat Na',
        currency: CURRENCY,
        baseFare: 15,
        includedKm: 4,
        perKm: 2.5,
        matchDelaySeconds: 3,
        dispatchMode: 'auto'
      },
      ui: {
        'brand.tagline': 'Share the road. Split the fare.',
        'passenger.heroTitle': 'Where are we going?',
        'passenger.searchPlaceholder': 'Search a destination in the Philippines',
        'passenger.bookButton': 'Book this ride',
        'driver.title': 'Driver Mode',
        'driver.onlineLabel': 'Go online',
        'ops.title': 'Operations Center'
      }
    };

    const drivers = [
      { name: 'Mika Reyes', plate: 'NCR 2841', vehicle: 'Toyota Vios', lat: 14.5995, lng: 120.9842, online: true, rating: 4.70, earnings: 1240, trips: 28 },
      { name: 'Paolo Santos', plate: 'NCR 7715', vehicle: 'Mitsubishi Mirage', lat: 14.6090, lng: 120.9940, online: false, rating: 4.75, earnings: 1555, trips: 35 },
      { name: 'Liza Cruz', plate: 'NCR 3306', vehicle: 'Suzuki Ertiga', lat: 14.5870, lng: 120.9760, online: false, rating: 4.80, earnings: 1870, trips: 42 },
      { name: 'Andres Dizon', plate: 'NCR 9022', vehicle: 'Toyota Innova', lat: 14.6150, lng: 120.9700, online: false, rating: 4.85, earnings: 2185, trips: 49 }
    ];

    drivers.forEach((d, i) => {
      state.accounts.push({
        id: 'DRV-' + (i + 1) + '00',
        role: 'driver',
        name: d.name,
        email: 'driver' + (i + 1) + '@sibatna.demo',
        phone: '0917123456' + i,
        emergency: '',
        status: d.online ? 'online' : 'offline',
        plate: d.plate,
        vehicle: d.vehicle,
        license: 'N01-23-45678' + i,
        nbi: 'NBI-2026-00' + (i + 1),
        orcr: 'OR-CR-778' + (i + 1),
        ltfrb: 'LTFRB-TNVS-88' + (i + 1),
        otherDocs: '',
        idImage: '',
        lat: d.lat,
        lng: d.lng,
        rating: d.rating,
        earnings: d.earnings,
        trips: d.trips,
        createdAt: now() - 86400000 * (30 - i)
      });
    });

    state.accounts.push({
      id: 'PAS-7001',
      role: 'passenger',
      name: 'Demo Passenger',
      email: 'demo@sibatna.ph',
      phone: '09171234567',
      emergency: '09181234567',
      status: 'offline',
      plate: '', vehicle: '', license: '', nbi: '', orcr: '', ltfrb: '', otherDocs: '', idImage: '',
      lat: 14.5995, lng: 120.9842,
      rating: 5, earnings: 0, trips: 0,
      createdAt: now() - 86400000 * 2
    });

    const locations = [
      ['SM North EDSA', 14.6564, 121.0306, 'Quezon City'],
      ['Trinoma', 14.6538, 121.0330, 'Quezon City'],
      ['Mall of Asia', 14.5354, 120.9822, 'Pasay'],
      ['Bonifacio Global City', 14.5547, 121.0509, 'Taguig'],
      ['Makati CBD', 14.5547, 121.0244, 'Makati'],
      ['Intramuros', 14.5896, 120.9747, 'Manila'],
      ['NAIA Terminal 3', 14.5118, 121.0194, 'Pasay'],
      ['Ortigas Center', 14.5866, 121.0647, 'Pasig']
    ];
    locations.forEach((l, i) => {
      state.locations.push({
        id: 'LOC-' + (101 + i), name: l[0], lat: l[1], lng: l[2], zone: l[3], active: true
      });
    });

    state.routes.push(
      { id: 'RTE-201', name: 'QC → Makati shuttle', from: 'Quezon City', to: 'Makati', km: 11.8, baseFare: 15, perKm: 2.5, active: true },
      { id: 'RTE-202', name: 'Pasay → BGC loop', from: 'Pasay', to: 'Taguig', km: 8.4, baseFare: 15, perKm: 2.5, active: true },
      { id: 'RTE-203', name: 'Manila heritage run', from: 'Manila', to: 'Pasay', km: 7.2, baseFare: 15, perKm: 2.5, active: true }
    );

    const seedRide = {
      id: 'RIDE-4901', code: 'SBT-4901',
      passengerId: 'PAS-7001', passengerName: 'Demo Passenger', phone: '09171234567',
      pickupLabel: 'SM North EDSA', destLabel: 'Makati CBD',
      pickupArea: 'Quezon City', destArea: 'Makati',
      pickupLat: 14.6564, pickupLng: 121.0306,
      destLat: 14.5547, destLng: 121.0244,
      distanceKm: 11.8, fare: computeFare(11.8, state.settings), seats: 1,
      queueKey: makeQueueKey('Quezon City', 'Makati'),
      status: 'completed',
      driverId: 'DRV-100', driverName: 'Mika Reyes', plate: 'NCR 2841', vehicle: 'Toyota Vios',
      createdAt: now() - 86400000,
      matchedAt: now() - 86400000 + 60000,
      completedAt: now() - 86400000 + 1500000
    };
    state.rides.push(seedRide);

    return state;
  }

  // ---------------------------------------------------------------------
  //  STORAGE
  // ---------------------------------------------------------------------
  function readAccount() {
    try { return JSON.parse(localStorage.getItem(ACCOUNT_KEY) || 'null'); }
    catch (_) { return null; }
  }

  function normalizeAccount(a) {
    return {
      id: a.id,
      role: a.role || 'passenger',
      name: a.name || 'Passenger',
      email: a.email || '',
      phone: a.phone || '',
      emergency: a.emergency || '',
      status: a.status || 'offline',
      plate: a.plate || '',
      vehicle: a.vehicle || '',
      license: a.license || '',
      nbi: a.nbi || '',
      orcr: a.orcr || '',
      ltfrb: a.ltfrb || '',
      otherDocs: a.otherDocs || '',
      idImage: a.idImage || '',
      lat: Number(a.lat || 14.5995),
      lng: Number(a.lng || 120.9842),
      rating: Number(a.rating || 4.9),
      earnings: Number(a.earnings || 0),
      trips: Number(a.trips || 0),
      createdAt: Number(a.createdAt || now())
    };
  }

  function load() {
    let state = null;
    try { state = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); }
    catch (_) { state = null; }
    if (!state || state.version !== 1 || !Array.isArray(state.accounts)) {
      state = seed();
    }
    // Remove any corrupt rows left by an earlier version.
    state.accounts = state.accounts.filter(a => a && a.id);

    const account = readAccount();
    if (account) {
      if (!account.id) {
        // Repair an account that was saved without an id.
        account.id = nextId(state, account.role === 'driver' ? 'DRV' : 'PAS');
        account.createdAt = account.createdAt || now();
        try { localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account)); } catch (_) {}
      }
      if (!state.accounts.some(a => a.id === account.id)) {
        state.accounts.push(normalizeAccount(account));
      }
    }
    save(state);
    return state;
  }

  function save(state) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
    catch (_) { /* storage full/blocked */ }
    try {
      localStorage.setItem(MIRROR_KEY, JSON.stringify({
        rides: state.rides,
        drivers: state.accounts.filter(a => a.role === 'driver'),
        stats: stats(state),
        updatedAt: now(),
        engine: 'local'
      }));
    } catch (_) { /* ignore */ }
  }

  // ---------------------------------------------------------------------
  //  SERIALIZERS (same field names as the C++ API)
  // ---------------------------------------------------------------------
  function accountJson(a) {
    return {
      id: a.id,
      role: a.role,
      name: a.name,
      email: a.email,
      phone: a.phone,
      emergency: a.emergency,
      plate: a.plate,
      vehicle: a.vehicle,
      status: a.status,
      lat: a.lat,
      lng: a.lng,
      rating: a.rating,
      earnings: a.earnings,
      trips: a.trips,
      createdAt: a.createdAt,
      hasIdImage: !!a.idImage,
      license: a.license,
      nbi: a.nbi,
      orcr: a.orcr,
      ltfrb: a.ltfrb,
      otherDocs: a.otherDocs
    };
  }

  function queuePosition(state, ride) {
    if (ride.status !== 'pending') return 0;
    const peers = state.rides
      .filter(r => r.status === 'pending' && r.queueKey === ride.queueKey)
      .sort(byCreated);
    const index = peers.findIndex(r => r.id === ride.id);
    return index >= 0 ? index + 1 : 0;
  }

  function rideJson(state, r) {
    return {
      id: r.id, code: r.code,
      passengerId: r.passengerId, passengerName: r.passengerName, phone: r.phone,
      pickupLabel: r.pickupLabel, destLabel: r.destLabel,
      pickupArea: r.pickupArea, destArea: r.destArea,
      pickupLat: r.pickupLat, pickupLng: r.pickupLng,
      destLat: r.destLat, destLng: r.destLng,
      distanceKm: r.distanceKm, fare: r.fare, fareText: Number(r.fare).toFixed(2),
      seats: r.seats, queueKey: r.queueKey, status: r.status,
      driverId: r.driverId || '', driverName: r.driverName || '',
      plate: r.plate || '', vehicle: r.vehicle || '',
      createdAt: r.createdAt, matchedAt: r.matchedAt || 0, completedAt: r.completedAt || 0,
      queuePosition: queuePosition(state, r)
    };
  }

  function stats(state) {
    const rides = state.rides || [];
    const completed = rides.filter(r => r.status === 'completed');
    const cancelled = rides.filter(r => r.status === 'cancelled');
    const pending = rides.filter(r => r.status === 'pending').length;
    const active = rides.filter(r => ['offered', 'arriving', 'at_pickup', 'on_trip'].includes(r.status)).length;
    const revenue = round2(completed.reduce((sum, r) => sum + Number(r.fare || 0), 0));
    const drivers = state.accounts.filter(a => a.role === 'driver');
    const online = drivers.filter(a => a.status === 'online' || a.status === 'busy').length;
    const closed = completed.length + cancelled.length;
    return {
      totalRides: rides.length,
      pending,
      active,
      completed: completed.length,
      cancelled: cancelled.length,
      onlineDrivers: online,
      drivers: drivers.length,
      revenue,
      avgFare: completed.length ? round2(revenue / completed.length) : 0,
      completionRate: closed ? Math.round((1000 * completed.length / closed)) / 10 : 0,
      queueLength: pending,
      tick: state.tick || 0,
      generatedAt: new Date().toISOString()
    };
  }

  function settingsJson(state) {
    return Object.assign({}, state.settings, {
      fareRule: 'Fare = base + (km - includedKm) * perKm'
    });
  }

  function stateJson(state) {
    return {
      settings: settingsJson(state),
      ui: state.ui,
      stats: stats(state),
      tick: state.tick,
      routes: state.routes,
      locations: state.locations,
      rides: state.rides.map(r => rideJson(state, r)),
      drivers: state.accounts.filter(a => a.role === 'driver').map(accountJson),
      passengers: state.accounts.filter(a => a.role !== 'driver').map(accountJson)
    };
  }

  // ---------------------------------------------------------------------
  //  HELPERS
  // ---------------------------------------------------------------------
  function nextId(state, prefix) {
    state.seq = Number(state.seq || 5000) + 1;
    return prefix + '-' + state.seq;
  }

  function nextCode(state) {
    return 'SBT-' + (1000 + (state.seq % 9000));
  }

  function findAccount(state, id) {
    return state.accounts.find(a => a.id === id) || null;
  }

  function findRide(state, id) {
    return state.rides.find(r => r.id === id) || null;
  }

  function bestDriverFor(state, ride) {
    let best = null;
    let bestScore = Infinity;
    state.accounts.forEach(a => {
      if (a.role !== 'driver' || a.status !== 'online') return;
      const distance = haversineKm(a, { lat: ride.pickupLat, lng: ride.pickupLng });
      const score = distance + a.trips * 0.02;
      if (score < bestScore) { bestScore = score; best = a; }
    });
    return best;
  }

  function offerRide(state, ride, driver) {
    ride.status = 'offered';
    ride.driverId = driver.id;
    ride.driverName = driver.name;
    ride.plate = driver.plate;
    ride.vehicle = driver.vehicle;
    ride.matchedAt = now();
    driver.status = 'busy';
  }

  function completeRide(state, ride, driver) {
    ride.status = 'completed';
    ride.completedAt = now();
    if (driver) {
      driver.earnings = round2(driver.earnings + ride.fare * 0.8);
      driver.trips += 1;
      driver.status = 'online';
      driver.lat = ride.destLat;
      driver.lng = ride.destLng;
    }
    void state;
  }

  function parseBody(options) {
    const body = options && options.body;
    if (!body) return {};
    if (typeof body === 'string') {
      try { return JSON.parse(body); } catch (_) { return {}; }
    }
    return body;
  }

  function applyAccount(account, body) {
    const fields = ['name', 'email', 'phone', 'emergency', 'plate', 'vehicle',
      'license', 'nbi', 'orcr', 'ltfrb', 'otherDocs', 'idImage', 'status'];
    fields.forEach(field => {
      if (body[field] !== undefined) account[field] = String(body[field]);
    });
    if (body.lat !== undefined) account.lat = Number(body.lat);
    if (body.lng !== undefined) account.lng = Number(body.lng);
    if (body.role) account.role = body.role;
    return account;
  }

  function spawnWalkInPassenger(state, driver) {
    if (!state.locations.length) return null;
    const names = ['Ariel Santos', 'Bea Lopez', 'Carlo Mendoza', 'Dina Reyes', 'Enzo Garcia'];
    let pickup = state.locations[0];
    let best = Infinity;
    state.locations.forEach(location => {
      const distance = haversineKm(driver, { lat: location.lat, lng: location.lng });
      if (distance < best) { best = distance; pickup = location; }
    });
    let destination = state.locations[Math.floor(Math.random() * state.locations.length)];
    if (destination.id === pickup.id) {
      destination = state.locations[(state.locations.indexOf(destination) + 1) % state.locations.length];
    }
    const km = round1(haversineKm(
      { lat: pickup.lat, lng: pickup.lng },
      { lat: destination.lat, lng: destination.lng }
    ));
    const ride = {
      id: nextId(state, 'RIDE'), code: '',
      passengerId: 'WALKIN',
      passengerName: names[Math.floor(Math.random() * names.length)],
      phone: '09170000000',
      pickupLabel: pickup.name, destLabel: destination.name,
      pickupArea: pickup.zone, destArea: destination.zone,
      pickupLat: pickup.lat, pickupLng: pickup.lng,
      destLat: destination.lat, destLng: destination.lng,
      distanceKm: km, fare: computeFare(km, state.settings), seats: 1,
      queueKey: makeQueueKey(pickup.zone, destination.zone),
      status: 'offered',
      driverId: driver.id, driverName: driver.name,
      plate: driver.plate, vehicle: driver.vehicle,
      createdAt: now(), matchedAt: now(), completedAt: 0
    };
    ride.code = nextCode(state);
    state.rides.push(ride);
    driver.status = 'busy';
    return ride;
  }

  function makeSimRide(state, index) {
    const locations = state.locations.filter(l => l.active !== false);
    if (locations.length < 2) return null;
    const from = locations[Math.floor(Math.random() * locations.length)];
    let to = locations[Math.floor(Math.random() * locations.length)];
    if (to.id === from.id) to = locations[(locations.indexOf(from) + 1) % locations.length];
    const km = round1(haversineKm(from, to));
    const ride = {
      id: nextId(state, 'RIDE'), code: '',
      passengerId: 'SIM', passengerName: 'Sim Passenger ' + (index + 1), phone: '09170000000',
      pickupLabel: from.name, destLabel: to.name,
      pickupArea: from.zone, destArea: to.zone,
      pickupLat: from.lat, pickupLng: from.lng,
      destLat: to.lat, destLng: to.lng,
      distanceKm: km, fare: computeFare(km, state.settings), seats: 1,
      queueKey: makeQueueKey(from.zone, to.zone),
      status: 'pending', driverId: '', driverName: '', plate: '', vehicle: '',
      createdAt: now(), matchedAt: 0, completedAt: 0
    };
    ride.code = nextCode(state);
    state.rides.push(ride);
    return ride;
  }

  // ---------------------------------------------------------------------
  //  ADMIN CRUD
  // ---------------------------------------------------------------------
  function adminItems(state, entity) {
    if (entity === 'drivers') return state.accounts.filter(a => a.role === 'driver').map(accountJson);
    if (entity === 'passengers') return state.accounts.filter(a => a.role !== 'driver').map(accountJson);
    if (entity === 'rides') return state.rides.map(r => rideJson(state, r));
    if (entity === 'routes') return state.routes.map(r => Object.assign({}, r));
    if (entity === 'locations') return state.locations.map(l => Object.assign({}, l));
    if (entity === 'texts') {
      return Object.keys(state.ui).map(key => ({ id: key, key: key, value: state.ui[key] }));
    }
    return [];
  }

  function adminCreate(state, entity, body) {
    if (entity === 'drivers' || entity === 'passengers') {
      const role = entity === 'drivers' ? 'driver' : 'passenger';
      const generatedId = nextId(state, role === 'driver' ? 'DRV' : 'PAS');
      const account = normalizeAccount(Object.assign({
        id: generatedId,
        role: role,
        createdAt: now()
      }, body));
      account.id = generatedId;
      account.role = role;
      state.accounts.push(account);
      return { item: accountJson(account) };
    }
    if (entity === 'routes') {
      if (!body.name) throw new Error('Route name is required');
      const route = {
        id: nextId(state, 'RTE'),
        name: String(body.name),
        from: String(body.from || ''),
        to: String(body.to || ''),
        km: Number(body.km || 5),
        baseFare: Number(body.baseFare || state.settings.baseFare),
        perKm: Number(body.perKm || state.settings.perKm),
        active: body.active !== false
      };
      state.routes.push(route);
      return { item: route };
    }
    if (entity === 'locations') {
      if (!body.name) throw new Error('Location name is required');
      const location = {
        id: nextId(state, 'LOC'),
        name: String(body.name),
        lat: Number(body.lat || 14.5995),
        lng: Number(body.lng || 120.9842),
        zone: String(body.zone || 'Manila'),
        active: body.active !== false
      };
      state.locations.push(location);
      return { item: location };
    }
    if (entity === 'texts') {
      if (!body.key) throw new Error('Text key is required');
      state.ui[body.key] = String(body.value || '');
      return { item: { id: body.key, key: body.key, value: state.ui[body.key] } };
    }
    throw new Error('Unsupported entity');
  }

  function adminUpdate(state, entity, id, body) {
    if (entity === 'drivers' || entity === 'passengers') {
      const account = findAccount(state, id);
      if (!account) throw new Error('Account not found');
      applyAccount(account, body);
      return { item: accountJson(account) };
    }
    if (entity === 'rides') {
      const ride = findRide(state, id);
      if (!ride) throw new Error('Ride not found');
      if (body.status) ride.status = String(body.status);
      if (body.fare !== undefined) ride.fare = Number(body.fare);
      if (body.seats !== undefined) ride.seats = Number(body.seats);
      return { item: rideJson(state, ride) };
    }
    if (entity === 'routes') {
      const route = state.routes.find(r => r.id === id);
      if (!route) throw new Error('Route not found');
      ['name', 'from', 'to'].forEach(k => { if (body[k] !== undefined) route[k] = String(body[k]); });
      ['km', 'baseFare', 'perKm'].forEach(k => { if (body[k] !== undefined) route[k] = Number(body[k]); });
      if (body.active !== undefined) route.active = !!body.active;
      return { item: route };
    }
    if (entity === 'locations') {
      const location = state.locations.find(l => l.id === id);
      if (!location) throw new Error('Location not found');
      if (body.name !== undefined) location.name = String(body.name);
      if (body.zone !== undefined) location.zone = String(body.zone);
      if (body.lat !== undefined) location.lat = Number(body.lat);
      if (body.lng !== undefined) location.lng = Number(body.lng);
      if (body.active !== undefined) location.active = !!body.active;
      return { item: location };
    }
    if (entity === 'texts') {
      if (id) state.ui[id] = String(body.value || '');
      else if (body.key) state.ui[body.key] = String(body.value || '');
      return { item: { id: id || body.key, value: state.ui[id || body.key] } };
    }
    throw new Error('Unsupported entity');
  }

  function adminDelete(state, entity, id) {
    if (entity === 'drivers' || entity === 'passengers') {
      const index = state.accounts.findIndex(a => a.id === id &&
        (entity === 'drivers' ? a.role === 'driver' : a.role !== 'driver'));
      if (index < 0) throw new Error('Account not found');
      state.accounts.splice(index, 1);
      return;
    }
    if (entity === 'rides') {
      const index = state.rides.findIndex(r => r.id === id);
      if (index < 0) throw new Error('Ride not found');
      state.rides.splice(index, 1);
      return;
    }
    if (entity === 'routes') {
      const index = state.routes.findIndex(r => r.id === id);
      if (index < 0) throw new Error('Route not found');
      state.routes.splice(index, 1);
      return;
    }
    if (entity === 'locations') {
      const index = state.locations.findIndex(l => l.id === id);
      if (index < 0) throw new Error('Location not found');
      state.locations.splice(index, 1);
      return;
    }
    if (entity === 'texts') {
      if (!(id in state.ui)) throw new Error('Text key not found');
      delete state.ui[id];
      return;
    }
    throw new Error('Unsupported entity');
  }

  // ---------------------------------------------------------------------
  //  API ROUTER — mirrors the C++ endpoints used by the app
  // ---------------------------------------------------------------------
  function handle(path, options) {
    const opts = options || {};
    const method = String(opts.method || 'GET').toUpperCase();
    const body = parseBody(opts);
    const parts = String(path || '/').split('?')[0].split('/')
      .filter(Boolean)
      .map(p => { try { return decodeURIComponent(p); } catch (_) { return p; } });
    if (parts[0] === 'api') parts.shift();

    const state = load();
    const p0 = parts[0] || '';
    const p1 = parts[1] || '';
    const p2 = parts[2] || '';

    // ---- health / state -------------------------------------------------
    if (p0 === 'health' && method === 'GET') {
      return { ok: true, service: 'sibat-na', version: '1.0.0', engine: 'local-js', time: new Date().toISOString() };
    }
    if (p0 === 'state' && method === 'GET') {
      return { ok: true, state: stateJson(state), serverTime: new Date().toISOString() };
    }
    if (p0 === 'stats' && method === 'GET') {
      return { ok: true, stats: stats(state) };
    }
    if (p0 === 'config' && method === 'GET') {
      return { ok: true, settings: settingsJson(state), ui: state.ui };
    }
    if (p0 === 'config' && method === 'POST') {
      if (body.settings) {
        const s = body.settings;
        if (s.baseFare !== undefined) state.settings.baseFare = Number(s.baseFare);
        if (s.includedKm !== undefined) state.settings.includedKm = Number(s.includedKm);
        if (s.perKm !== undefined) state.settings.perKm = Number(s.perKm);
        if (s.matchDelaySeconds !== undefined) state.settings.matchDelaySeconds = Number(s.matchDelaySeconds);
        if (s.dispatchMode !== undefined) state.settings.dispatchMode = String(s.dispatchMode);
        if (s.serviceName !== undefined) state.settings.serviceName = String(s.serviceName);
      }
      if (body.ui) Object.keys(body.ui).forEach(k => { state.ui[k] = String(body.ui[k]); });
      save(state);
      return { ok: true, settings: settingsJson(state), ui: state.ui };
    }
    if (p0 === 'reset' && method === 'POST') {
      save(seed());
      return { ok: true };
    }

    // ---- accounts -------------------------------------------------------
    if (p0 === 'accounts') {
      if (method === 'GET' && !p1) {
        return { ok: true, accounts: state.accounts.map(accountJson) };
      }
      if (method === 'POST') {
        const existing = body.id ? findAccount(state, body.id) : null;
        if (existing) {
          applyAccount(existing, body);
          save(state);
          return { ok: true, account: accountJson(existing) };
        }
        const role = body.role === 'driver' ? 'driver' : 'passenger';
        const generatedId = body.id || nextId(state, role === 'driver' ? 'DRV' : 'PAS');
        const account = normalizeAccount(Object.assign({
          id: generatedId,
          role: role,
          createdAt: now()
        }, body));
        account.id = generatedId;
        account.role = role;
        state.accounts.push(account);
        save(state);
        return { ok: true, account: accountJson(account) };
      }
      if (method === 'GET' && p1) {
        const account = findAccount(state, p1);
        if (!account) throw new Error('Account not found');
        return { ok: true, account: accountJson(account) };
      }
    }

    // ---- rides ----------------------------------------------------------
    if (p0 === 'rides') {
      if (method === 'GET' && !p1) {
        return { ok: true, rides: state.rides.map(r => rideJson(state, r)) };
      }
      if (method === 'POST' && !p1) {
        const pickup = String(body.pickupLabel || '').trim();
        const dest = String(body.destLabel || '').trim();
        if (!pickup || !dest) throw new Error('Pickup and destination are required');
        if (!Number(body.pickupLat) || !Number(body.destLat)) {
          throw new Error('Pickup and destination coordinates are required');
        }
        const pickupPoint = { lat: Number(body.pickupLat), lng: Number(body.pickupLng) };
        const destPoint = { lat: Number(body.destLat), lng: Number(body.destLng) };
        const km = Number(body.distanceKm) > 0
          ? Number(body.distanceKm)
          : haversineKm(pickupPoint, destPoint);
        const ride = {
          id: nextId(state, 'RIDE'), code: '',
          passengerId: String(body.passengerId || 'GUEST'),
          passengerName: String(body.passengerName || 'Passenger'),
          phone: String(body.phone || ''),
          pickupLabel: pickup, destLabel: dest,
          pickupArea: String(body.pickupArea || areaFromLabel(pickup)),
          destArea: String(body.destArea || areaFromLabel(dest)),
          pickupLat: pickupPoint.lat, pickupLng: pickupPoint.lng,
          destLat: destPoint.lat, destLng: destPoint.lng,
          distanceKm: round1(km), fare: computeFare(km, state.settings),
          seats: Math.max(1, Number(body.seats) || 1),
          queueKey: '',
          status: 'pending',
          driverId: '', driverName: '', plate: '', vehicle: '',
          createdAt: now(), matchedAt: 0, completedAt: 0
        };
        ride.queueKey = makeQueueKey(ride.pickupArea, ride.destArea);
        ride.code = nextCode(state);
        state.rides.push(ride);
        save(state);
        return { ok: true, ride: rideJson(state, ride) };
      }
      if (method === 'GET' && p1) {
        const ride = findRide(state, p1);
        if (!ride) throw new Error('Ride not found');
        return { ok: true, ride: rideJson(state, ride) };
      }
      if (method === 'POST' && p2 === 'cancel') {
        const ride = findRide(state, p1);
        if (!ride) throw new Error('Ride not found');
        if (ride.status === 'completed') throw new Error('Completed rides cannot be cancelled');
        if (ride.status === 'cancelled') throw new Error('Ride is already cancelled');
        if (ride.status === 'on_trip') throw new Error('The trip already started');
        if (ride.driverId) {
          const driver = findAccount(state, ride.driverId);
          if (driver && driver.status === 'busy') driver.status = 'online';
        }
        ride.status = 'cancelled';
        save(state);
        return { ok: true, ride: rideJson(state, ride) };
      }
    }

    // ---- drivers --------------------------------------------------------
    if (p0 === 'drivers' && p1) {
      const driver = findAccount(state, p1);
      if (!driver || driver.role !== 'driver') throw new Error('Driver not found');

      if (method === 'GET' && !p2) {
        return { ok: true, account: accountJson(driver) };
      }
      if (method === 'POST' && p2 === 'status') {
        const status = String(body.status || 'offline');
        if (!['online', 'offline'].includes(status)) throw new Error('status must be online/offline');
        if (status === 'offline' && driver.status === 'busy') {
          throw new Error('Finish the active trip before going offline');
        }
        driver.status = status;
        save(state);
        return { ok: true, account: accountJson(driver) };
      }
      if (method === 'POST' && p2 === 'match') {
        if (driver.status === 'offline') throw new Error('Go online first');
        if (driver.status === 'busy') throw new Error('You already have an active trip');
        const ride = state.rides
          .filter(r => r.status === 'pending')
          .sort(byCreated)[0];
        if (!ride) {
          // No queued passenger: random walk-in, or a genuine “nothing nearby”.
          if (Math.random() < 0.5) {
            const walkIn = spawnWalkInPassenger(state, driver);
            if (walkIn) {
              save(state);
              return { ok: true, ride: rideJson(state, walkIn) };
            }
          }
          throw new Error('No passenger nearby right now. Try again.');
        }
        offerRide(state, ride, driver);
        save(state);
        return { ok: true, ride: rideJson(state, ride) };
      }
      if (method === 'POST' && (p2 === 'accept' || p2 === 'reject')) {
        const ride = findRide(state, String(body.rideId || ''));
        if (!ride || ride.status !== 'offered' || ride.driverId !== driver.id) {
          throw new Error('This offer is no longer yours');
        }
        if (p2 === 'accept') {
          ride.status = 'arriving';
          ride.matchedAt = now();
          driver.status = 'busy';
        } else {
          // Rejected walk-ins are demo-only; cancel them so the next search
          // can be random again instead of always finding the same passenger.
          if (ride.passengerId === 'WALKIN') {
            ride.status = 'cancelled';
            ride.matchedAt = 0;
          } else {
            ride.status = 'pending';
            ride.driverId = ''; ride.driverName = ''; ride.plate = ''; ride.vehicle = '';
            ride.matchedAt = 0;
          }
          if (driver.status === 'busy') driver.status = 'online';
        }
        save(state);
        return { ok: true, ride: rideJson(state, ride), driver: accountJson(driver) };
      }
      if (method === 'POST' && p2 === 'phase') {
        const ride = findRide(state, String(body.rideId || ''));
        if (!ride || ride.driverId !== driver.id) throw new Error('Ride or driver not found');
        const phase = String(body.phase || '');
        const allowed = {
          arriving: 'at_pickup',
          at_pickup: 'on_trip',
          on_trip: 'completed'
        };
        if (allowed[ride.status] !== phase) {
          throw new Error('Cannot move from ' + ride.status + ' to ' + phase);
        }
        if (phase === 'completed') {
          completeRide(state, ride, driver);
        } else {
          ride.status = phase;
          if (phase === 'on_trip') { driver.lat = ride.pickupLat; driver.lng = ride.pickupLng; }
        }
        save(state);
        return { ok: true, ride: rideJson(state, ride), driver: accountJson(driver) };
      }
      if (method === 'POST' && p2 === 'location') {
        driver.lat = Number(body.lat || driver.lat);
        driver.lng = Number(body.lng || driver.lng);
        save(state);
        return { ok: true };
      }
    }

    // ---- operations -----------------------------------------------------
    if (p0 === 'ops' && p1 === 'demo-advance' && method === 'POST') {
      const ride = findRide(state, String(body.rideId || ''));
      if (!ride) throw new Error('Ride not found');
      if (ride.status === 'completed' || ride.status === 'cancelled') {
        return { ok: true, ride: rideJson(state, ride), message: 'Ride already closed' };
      }
      let message = '';
      if (ride.status === 'pending') {
        let driver = bestDriverFor(state, ride);
        if (!driver) {
          let best = Infinity;
          state.accounts.forEach(account => {
            if (account.role !== 'driver' || account.status === 'busy') return;
            const distance = haversineKm(account, { lat: ride.pickupLat, lng: ride.pickupLng });
            if (distance < best) { best = distance; driver = account; }
          });
          if (driver) driver.status = 'online';
        }
        if (!driver) throw new Error('No driver available');
        offerRide(state, ride, driver);
        message = 'offered';
      } else if (ride.status === 'offered') {
        ride.status = 'arriving';
        ride.matchedAt = now();
        const driver = findAccount(state, ride.driverId);
        if (driver) driver.status = 'busy';
        message = 'arriving';
      } else if (ride.status === 'arriving') {
        // Skip the separate at-pickup stop — each visible demo step is 3s.
        ride.status = 'on_trip';
        const driver = findAccount(state, ride.driverId);
        if (driver) { driver.lat = ride.pickupLat; driver.lng = ride.pickupLng; }
        message = 'on_trip';
      } else if (ride.status === 'at_pickup') {
        ride.status = 'on_trip';
        message = 'on_trip';
      } else if (ride.status === 'on_trip') {
        const driver = findAccount(state, ride.driverId);
        completeRide(state, ride, driver);
        message = 'completed';
      }
      save(state);
      return { ok: true, ride: rideJson(state, ride), message };
    }
    if (p0 === 'ops' && p1 === 'serve-next' && method === 'POST') {
      const ride = state.rides.filter(r => r.status === 'pending').sort(byCreated)[0];
      if (!ride) return { ok: true, message: 'Queue is empty', stats: stats(state) };
      const driver = bestDriverFor(state, ride);
      if (!driver) {
        return { ok: true, message: 'No dispatch: No driver is online right now', stats: stats(state) };
      }
      offerRide(state, ride, driver);
      save(state);
      return {
        ok: true,
        message: 'Offered ' + ride.code + ' to ' + driver.name,
        stats: stats(state)
      };
    }
    if (p0 === 'ops' && p1 === 'simulate' && method === 'POST') {
      const steps = Math.max(1, Math.min(200, Number(body.steps) || 5));
      const spawn = body.spawn !== false;
      let spawned = 0;
      let completed = 0;
      for (let i = 0; i < steps; i++) {
        state.tick += 1;
        if (spawn && state.tick % 2 === 0) {
          if (makeSimRide(state, spawned)) spawned += 1;
        }
        // accept any outstanding demo offers, then advance phases
        state.rides.forEach(ride => {
          if (ride.status === 'offered') {
            ride.status = 'arriving';
            ride.matchedAt = now();
          } else if (ride.status === 'arriving') {
            ride.status = 'at_pickup';
          } else if (ride.status === 'at_pickup') {
            ride.status = 'on_trip';
          } else if (ride.status === 'on_trip') {
            const driver = findAccount(state, ride.driverId);
            completeRide(state, ride, driver);
            completed += 1;
          }
        });
        // dispatch pending rides to free online drivers
        if (state.settings.dispatchMode === 'auto') {
          for (let guard = 0; guard < 50; guard++) {
            const next = state.rides.filter(r => r.status === 'pending').sort(byCreated)[0];
            if (!next) break;
            const driver = bestDriverFor(state, next);
            if (!driver) break;
            offerRide(state, next, driver);
          }
        }
      }
      save(state);
      return {
        ok: true,
        message: 'Simulated ' + steps + ' ticks · ' + spawned + ' new request' +
          (spawned === 1 ? '' : 's') + ' · ' + completed + ' completed',
        stats: stats(state),
        state: stateJson(state)
      };
    }

    // ---- admin CRUD -----------------------------------------------------
    if (p0 === 'admin' && p1) {
      const entity = p1;
      if (method === 'GET' && !p2) {
        return { ok: true, items: adminItems(state, entity) };
      }
      if (method === 'POST' && !p2) {
        const result = adminCreate(state, entity, body);
        save(state);
        return Object.assign({ ok: true }, result);
      }
      if (method === 'PUT' && p2) {
        const result = adminUpdate(state, entity, p2, body);
        save(state);
        return Object.assign({ ok: true }, result);
      }
      if (method === 'DELETE' && p2) {
        adminDelete(state, entity, p2);
        save(state);
        return { ok: true };
      }
    }

    throw new Error('Unknown endpoint ' + method + ' ' + path);
  }

  window.SIBAT_LOCAL = {
    handle,
    seed,
    stats,
    stateJson,
    load,
    STORE_KEY,
    MIRROR_KEY
  };
})();
