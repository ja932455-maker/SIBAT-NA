/* ==========================================================================
   SIBAT NA — frontend/shared.js
   WHAT IS THIS FILE?
     Shared helpers used by the passenger app, the driver mode and the login
     flow: storage keys, API client, money/time formatting, toasts, modals,
     the Photon/OSRM helpers and the MapLibre map (with an offline fallback).

   DEMO NOTE
     Everything here talks to the local C++ engine on http://127.0.0.1:8787.
     Accounts are also mirrored to localStorage so the login flow still works
     if the engine is not running.
   ========================================================================== */
window.SIBAT = (function () {
  'use strict';

  // ---------------------------------------------------------------------
  //  1. STORAGE KEYS — keep these exact; other tabs read the same values
  // ---------------------------------------------------------------------
  const KEYS = {
    account: 'sibatNaAccount',
    theme: 'sibatNaMapTheme',
    activeRide: 'sibatNaActiveRide',
    queueMirror: 'sibatna.transport.v1',
    adminBase: 'sibatNaAdminBase',
    lastCenter: 'sibatNaLastCenter'
  };

  // The engine URL: same origin when served by the C++ server, otherwise
  // the default local port (so opening index.html directly still connects).
  const API_BASE = location.protocol === 'http:' || location.protocol === 'https:'
    ? (location.port === '8787' ? '' : 'http://127.0.0.1:8787')
    : 'http://127.0.0.1:8787';

  // Static hosting (Netlify/GitHub Pages/etc.) has no C++ server behind it.
  // Start in the browser engine there so we do not fire a mixed-content request
  // to 127.0.0.1 on every public visit.
  const canReachNativeEngine = location.protocol === 'file:' ||
    location.hostname === 'localhost' || location.hostname === '127.0.0.1' ||
    location.hostname === '::1' || location.port === '8787';

  const DEFAULTS = {
    center: { lat: 14.6564, lng: 121.0306 }, // SM North EDSA, Quezon City
    zoom: 13
  };

  const COLORS = {
    blue: '#087bff',
    cyan: '#00d9ff',
    red: '#ff315f',
    gold: '#ffd93d',
    cream: '#f7f6ef',
    green: '#183a31',
    orange: '#d4934e'
  };

  // Route paint is switched by the day/night toggle (see applyRouteTheme).
  const routePaint = {
    day:   { core: '#ff315f', glow: 'rgba(255,49,95,0.62)',   marker: '#ff315f' },
    night: { core: '#2f8cff', glow: 'rgba(47,140,255,0.72)',  marker: '#ff315f' }
  };

  // ---------------------------------------------------------------------
  //  2. SMALL UTILITIES
  // ---------------------------------------------------------------------
  const $  = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function money(value, currency) {
    const symbol = currency || '₱';
    const n = Number(value || 0);
    return symbol + n.toFixed(2);
  }

  function km(value) {
    return Number(value || 0).toFixed(1) + ' km';
  }

  function minutes(seconds) {
    const m = Math.max(1, Math.round(Number(seconds || 0) / 60));
    return m + ' min';
  }

  function timeAgo(ms) {
    if (!ms) return '—';
    const diff = Math.max(0, Date.now() - Number(ms));
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
  }

  function clock(ms) {
    if (!ms) return '—';
    return new Date(Number(ms)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function getAccount() {
    try { return JSON.parse(localStorage.getItem(KEYS.account) || 'null'); }
    catch (_) { return null; }
  }
  function setAccount(account) {
    localStorage.setItem(KEYS.account, JSON.stringify(account));
  }
  function clearAccount() {
    localStorage.removeItem(KEYS.account);
    localStorage.removeItem(KEYS.activeRide);
  }

  // Fare formula mirrors the C++ core (used for the live estimate only).
  function estimateFare(distanceKm, settings) {
    const base = Number(settings && settings.baseFare != null ? settings.baseFare : 15);
    const included = Number(settings && settings.includedKm != null ? settings.includedKm : 4);
    const perKm = Number(settings && settings.perKm != null ? settings.perKm : 2.5);
    const fare = base + Math.max(0, Number(distanceKm || 0) - included) * perKm;
    return Math.round(Math.max(fare, base) * 100) / 100;
  }

  // ---------------------------------------------------------------------
  //  3. API CLIENT — every call goes to the C++ engine
  // ---------------------------------------------------------------------
  const engine = {
    online: false,
    local: !canReachNativeEngine,
    lastError: '',
    listeners: []
  };

  function onEngineChange(fn) {
    engine.listeners.push(fn);
    return () => { engine.listeners = engine.listeners.filter(f => f !== fn); };
  }

  function notifyEngine() {
    engine.listeners.forEach(fn => fn(engine));
  }

  function enableLocal(reason) {
    if (engine.local) return;
    engine.local = true;
    engine.online = false;
    engine.lastError = reason || 'C++ engine unreachable';
    notifyEngine();
    window.dispatchEvent(new CustomEvent('sibat:local', { detail: { reason: engine.lastError } }));
  }

  function setEngineOnline(isOnline, error) {
    if (engine.local) return;
    const changed = engine.online !== isOnline || engine.lastError !== (error || '');
    engine.online = isOnline;
    engine.lastError = error || '';
    if (changed) notifyEngine();
  }

  // Local fallback lives in frontend/local-engine.js. It mirrors the C++
  // rules and keeps the demo alive when index.html is opened via file://.
  function callLocal(path, opts) {
    if (!window.SIBAT_LOCAL) throw new Error('Local demo engine is not loaded');
    return window.SIBAT_LOCAL.handle(path, opts);
  }

  async function api(path, options) {
    const opts = Object.assign({ method: 'GET', headers: {} }, options || {});
    if (opts.body && typeof opts.body !== 'string') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    opts.cache = 'no-store';

    if (engine.local) return callLocal(path, opts);

    let res;
    try {
      res = await fetch(API_BASE + '/api' + path, opts);
    } catch (err) {
      enableLocal('C++ engine not running on ' + (API_BASE || location.origin));
      return callLocal(path, opts);
    }
    let data = null;
    try { data = await res.json(); } catch (_) { /* non JSON */ }
    if (!res.ok || (data && data.ok === false)) {
      const msg = (data && data.error) || ('HTTP ' + res.status);
      setEngineOnline(true, msg);
      throw new Error(msg);
    }
    setEngineOnline(true, '');
    return data || {};
  }

  async function ping() {
    if (engine.local) return false;
    try {
      const res = await fetch(API_BASE + '/api/health', { cache: 'no-store' });
      if (!res.ok) throw new Error('health ' + res.status);
      await res.json();
      setEngineOnline(true, '');
      return true;
    } catch (_) {
      enableLocal('C++ engine not running');
      return false;
    }
  }

  // Try to leave local mode and reconnect to the C++ server.
  async function tryEngine() {
    try {
      const res = await fetch(API_BASE + '/api/health', { cache: 'no-store' });
      if (!res.ok) throw new Error('health ' + res.status);
      await res.json();
      engine.local = false;
      engine.online = true;
      engine.lastError = '';
      notifyEngine();
      return true;
    } catch (_) {
      return false;
    }
  }

  // ---------------------------------------------------------------------
  //  4. TOASTS + MODALS
  // ---------------------------------------------------------------------
  function toast(message, type, timeout) {
    let host = $('#toastHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toastHost';
      host.className = 'toast-host';
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = 'toast toast-' + (type || 'info');
    el.setAttribute('role', 'status');
    el.innerHTML = '<span class="toast-dot"></span><span>' + escapeHtml(message) + '</span>';
    host.appendChild(el);
    // Phones get two at a time so a burst of toasts cannot cover the form.
    const maxToasts = window.matchMedia('(max-width: 720px)').matches ? 2 : 4;
    while (host.children.length > maxToasts) host.firstElementChild.remove();
    requestAnimationFrame(() => el.classList.add('is-in'));
    setTimeout(() => {
      el.classList.remove('is-in');
      setTimeout(() => el.remove(), 260);
    }, timeout || 3400);
  }

  function openModal(html, opts) {
    const config = opts || {};
    let backdrop = $('#modalBackdrop');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.id = 'modalBackdrop';
      backdrop.className = 'modal-backdrop';
      document.body.appendChild(backdrop);
    }
    backdrop.innerHTML = '<div class="modal ' + (config.className || '') + '" role="dialog" aria-modal="true">' +
      (config.dismissible === false ? '' : '<button class="modal-x" data-modal-close aria-label="Close">×</button>') +
      html + '</div>';
    backdrop.classList.add('is-open');
    const close = () => closeModal();
    if (config.dismissible !== false) {
      backdrop.onclick = (e) => { if (e.target === backdrop || e.target.hasAttribute('data-modal-close')) close(); };
    }
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape' && config.dismissible !== false) {
        close(); document.removeEventListener('keydown', onEsc);
      }
    });
    return { close };
  }
  function closeModal() {
    const backdrop = $('#modalBackdrop');
    if (backdrop) backdrop.classList.remove('is-open');
  }

  // ---------------------------------------------------------------------
  //  5. THEME — persisted + auto by hour, drives map + route paint
  // ---------------------------------------------------------------------
  function resolveTheme(pref) {
    if (pref === 'day' || pref === 'night') return pref;
    const hour = new Date().getHours();
    return (hour >= 18 || hour < 6) ? 'night' : 'day';
  }

  function getThemePreference() {
    return localStorage.getItem(KEYS.theme) || 'auto';
  }

  function applyTheme(pref, opts) {
    const preference = pref || getThemePreference();
    localStorage.setItem(KEYS.theme, preference);
    const resolved = resolveTheme(preference);
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePref = preference;
    $$('[data-theme-toggle]').forEach(btn => {
      btn.textContent = resolved === 'night' ? '☀' : '☾';
      btn.setAttribute('aria-label', resolved === 'night' ? 'Switch to day map' : 'Switch to night map');
      btn.title = 'Map theme: ' + preference + ' (' + resolved + ')';
    });
    if (!opts || opts.propagate !== false) {
      window.dispatchEvent(new CustomEvent('sibat:theme', { detail: { preference, resolved } }));
    }
    return resolved;
  }

  function cycleTheme() {
    const order = ['auto', 'day', 'night'];
    const next = order[(order.indexOf(getThemePreference()) + 1) % order.length];
    applyTheme(next);
    toast('Map theme: ' + next + (next === 'auto' ? ' (' + resolveTheme('auto') + ')' : ''), 'info', 2000);
    return next;
  }

  function toggleTheme() {
    const current = resolveTheme(getThemePreference());
    const next = current === 'night' ? 'day' : 'night';
    applyTheme(next);
    toast(next === 'night' ? 'Night map on' : 'Day map on', 'info', 1800);
    return next;
  }

  // ---------------------------------------------------------------------
  //  6. GEOCODING — Photon (autocomplete + reverse), OSRM (route)
  //     These are public demo endpoints; every failure is handled softly.
  // ---------------------------------------------------------------------
  function photonLabel(props) {
    if (!props) return '';
    const parts = [
      props.name,
      props.street && props.housenumber ? props.housenumber + ' ' + props.street : props.street,
      props.district,
      props.city,
      props.state
    ].filter(Boolean);
    return Array.from(new Set(parts)).join(', ');
  }

  async function searchPlaces(query, near) {
    if (!query || query.trim().length < 3) return [];
    const params = new URLSearchParams({
      q: query.trim(), limit: '7', lang: 'en'
    });
    if (near && near.lat) { params.set('lat', near.lat); params.set('lon', near.lng); }
    const res = await fetch('https://photon.komoot.io/api/?' + params.toString(), { cache: 'no-store' });
    if (!res.ok) throw new Error('Search unavailable');
    const data = await res.json();
    return (data.features || [])
      .filter(f => f.geometry && Array.isArray(f.geometry.coordinates))
      .map(f => ({
        label: photonLabel(f.properties) || 'Unnamed place',
        detail: [f.properties.city, f.properties.state, f.properties.country].filter(Boolean).join(', '),
        lat: f.geometry.coordinates[1],
        lng: f.geometry.coordinates[0],
        kind: f.properties.osm_value || f.properties.type || 'place'
      }));
  }

  async function reverseGeocode(lat, lng) {
    try {
      const res = await fetch('https://photon.komoot.io/reverse?lat=' + lat + '&lon=' + lng + '&lang=en',
        { cache: 'no-store' });
      if (!res.ok) throw new Error('reverse failed');
      const data = await res.json();
      const f = (data.features || [])[0];
      if (!f) return null;
      return { label: photonLabel(f.properties), detail: f.properties };
    } catch (_) {
      return null;
    }
  }

  async function fetchRoute(from, to) {
    // OSRM expects "lng,lat;lng,lat" — not four semicolon-separated numbers.
    const coords = from.lng + ',' + from.lat + ';' + to.lng + ',' + to.lat;
    const url = 'https://router.project-osrm.org/route/v1/driving/' + coords +
      '?overview=full&geometries=geojson&steps=false';
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('Routing unavailable');
    const data = await res.json();
    const route = data.routes && data.routes[0];
    if (!route) throw new Error('No route found');
    return {
      geometry: route.geometry,
      distanceKm: Math.round((route.distance / 1000) * 10) / 10,
      durationSeconds: route.duration,
      fallback: false
    };
  }

  // Straight-line fallback if OSRM is unreachable. Clearly marked in the UI.
  function straightRoute(from, to) {
    const R = 6371;
    const dLat = (to.lat - from.lat) * Math.PI / 180;
    const dLng = (to.lng - from.lng) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(from.lat * Math.PI / 180) * Math.cos(to.lat * Math.PI / 180) *
      Math.sin(dLng / 2) ** 2;
    const distance = 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    return {
      geometry: { type: 'LineString', coordinates: [
        [from.lng, from.lat], [to.lng, to.lat]
      ] },
      distanceKm: Math.round(distance * 1.3 * 10) / 10,
      durationSeconds: Math.round(distance * 1.3 * 2.4 * 60),
      fallback: true
    };
  }

  // ---------------------------------------------------------------------
  //  7. MAP — MapLibre GL over OpenStreetMap raster tiles.
  //     If the CDN is unreachable, a clear schematic map is used instead.
  // ---------------------------------------------------------------------
  let mapLibrePromise = null;
  function loadMapLibre() {
    if (window.maplibregl) return Promise.resolve(window.maplibregl);
    if (mapLibrePromise) return mapLibrePromise;
    mapLibrePromise = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.css';
      document.head.appendChild(css);
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.js';
      script.async = true;
      const timer = setTimeout(() => reject(new Error('Map library timed out')), 7000);
      script.onload = () => { clearTimeout(timer); resolve(window.maplibregl); };
      script.onerror = () => { clearTimeout(timer); reject(new Error('Map library unavailable')); };
      document.head.appendChild(script);
    });
    return mapLibrePromise;
  }

  function mapStyleUrl(theme) {
    // OpenFreeMap vector styles — light for day, native dark for night.
    // This avoids the public OSM raster tile usage limits.
    return theme === 'night'
      ? 'https://tiles.openfreemap.org/styles/dark'
      : 'https://tiles.openfreemap.org/styles/liberty';
  }

  class SibatMap {
    constructor(container, opts) {
      this.container = typeof container === 'string' ? $(container) : container;
      this.opts = opts || {};
      this.center = Object.assign({}, DEFAULTS.center, this.opts.center || {});
      this.destination = null;
      this.route = null;
      this.gl = null;
      this.mode = 'loading';
      this.onPickup = this.opts.onPickup || null;
      this.onMapClick = this.opts.onMapClick || null;
      this.onReady = this.opts.onReady || null;
      this.resolveTheme = this.opts.resolveTheme || (() => resolveTheme(getThemePreference()));
      this._styleTheme = this.resolveTheme();
      this._loaded = false;
      this._reverseTimer = null;
      this.init();
    }

    setStatus(mode) {
      this.mode = mode;
      if (this.container) this.container.dataset.mapMode = mode;
      const badge = this.container && this.container.querySelector('.map-mode-badge');
      if (badge) {
        badge.textContent = mode === 'gl' ? 'LIVE MAP · OPENFREEMAP' :
          mode === 'schematic' ? 'SCHEMATIC MAP · OFFLINE TILES' : 'LOADING MAP…';
        badge.hidden = mode === 'gl';
      }
    }

    async init() {
      this.setStatus('loading');
      try {
        const lib = await loadMapLibre();
        this.initGL(lib);
        this.setStatus('gl');
      } catch (_) {
        this.initSchematic();
        this.setStatus('schematic');
      }
      if (this.onReady) this.onReady(this);
    }

    initGL(lib) {
      this._styleTheme = this.resolveTheme();
      this.gl = new lib.Map({
        container: this.container,
        style: mapStyleUrl(this._styleTheme),
        center: [this.center.lng, this.center.lat],
        zoom: this.opts.zoom || DEFAULTS.zoom,
        attributionControl: false,
        dragRotate: false,
        pitchWithRotate: false
      });
      this.gl.addControl(new lib.NavigationControl({ showCompass: false }), 'bottom-right');
      this.gl.addControl(new lib.AttributionControl({
        compact: true,
        customAttribution: '© OpenFreeMap © OpenStreetMap contributors'
      }), 'bottom-left');

      // If the vector style cannot load (offline), fall back to the schematic map.
      this._failTimer = setTimeout(() => {
        if (!this._loaded && this.gl) {
          try { this.gl.remove(); } catch (_) { /* ignore */ }
          this.gl = null;
          this.initSchematic();
          this.setStatus('schematic');
        }
      }, 10000);

      // setStyle() drops custom sources/layers, so rebuild them after every style load.
      this.gl.on('style.load', () => {
        this.installRouteLayers();
      });
      this.gl.on('styledata', () => {
        try {
          if (!this.gl.getSource('route')) this.installRouteLayers();
        } catch (_) { /* style is mid-update */ }
      });

      this.gl.on('load', () => {
        this._loaded = true;
        clearTimeout(this._failTimer);
        this.installRouteLayers();
        this.applyRouteTheme();
        if (this._pendingRoute) {
          this.drawRoute(this._pendingRoute);
          this._pendingRoute = null;
        }
      });

      // Clicking the map can drop a destination pin (the toolbar button enables this).
      this.gl.on('click', (event) => {
        if (this.onMapClick) this.onMapClick(event.lngLat.lat, event.lngLat.lng);
      });

      // Moving the map moves the fixed center pin: reverse geocode the new pickup.
      this.gl.on('moveend', () => {
        const c = this.gl.getCenter();
        this.center = { lat: c.lat, lng: c.lng };
        clearTimeout(this._reverseTimer);
        this._reverseTimer = setTimeout(() => {
          if (this.onPickup) this.onPickup(this.center.lat, this.center.lng);
        }, 450);
      });

      this.applyRouteTheme();
      if (this.opts.interactive === false) this.gl.dragPan.disable();
    }

    installRouteLayers() {
      if (!this.gl) return;
      try {
        if (!this.gl.getSource('route')) {
          this.gl.addSource('route', {
            type: 'geojson',
            data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: {} }
          });
        }
        if (!this.gl.getLayer('route-glow')) {
          this.gl.addLayer({
            id: 'route-glow', type: 'line', source: 'route',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': routePaint.day.glow, 'line-width': 22, 'line-blur': 16 }
          });
        }
        if (!this.gl.getLayer('route-core')) {
          this.gl.addLayer({
            id: 'route-core', type: 'line', source: 'route',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': routePaint.day.core, 'line-width': 5 }
          });
        }
        this.applyRoutePaint();
        if (this.route && this.gl.getSource('route')) {
          this.gl.getSource('route').setData({
            type: 'Feature',
            geometry: this.route.geometry,
            properties: {}
          });
          this.fitRoute();
        }
        // A draw that raced the style load gets completed now.
        if (this._pendingRoute) {
          const pending = this._pendingRoute;
          this._pendingRoute = null;
          this.drawRoute(pending);
        }
      } catch (_) { /* style is still loading */ }
    }

    fitRoute() {
      if (!this.gl || !this.route || !this.destination) return;
      const all = this.route.geometry.coordinates || [];
      if (!all.length) return;
      let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
      all.forEach(c => {
        minLng = Math.min(minLng, c[0]); maxLng = Math.max(maxLng, c[0]);
        minLat = Math.min(minLat, c[1]); maxLat = Math.max(maxLat, c[1]);
      });
      this.gl.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 70, duration: 700 });
    }

    applyRoutePaint() {
      if (!this.gl) return;
      const paint = routePaint[this._styleTheme] || routePaint.day;
      try {
        if (this.gl.getLayer('route-core')) {
          this.gl.setPaintProperty('route-core', 'line-color', paint.core);
        }
        if (this.gl.getLayer('route-glow')) {
          this.gl.setPaintProperty('route-glow', 'line-color', paint.glow);
        }
      } catch (_) { /* ignore */ }
    }

    initSchematic() {
      this.container.innerHTML =
        '<div class="schematic">' +
          '<svg viewBox="0 0 800 600" preserveAspectRatio="xMidYMid slice" aria-hidden="true">' +
            '<defs><pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse">' +
              '<path d="M50 0H0V50" fill="none" stroke="currentColor" stroke-opacity=".13" stroke-width="1"/>' +
            '</pattern></defs>' +
            '<rect width="800" height="600" fill="url(#grid)"/>' +
            '<path class="sch-water" d="M-20 470 C 160 430, 260 540, 460 500 S 720 430, 840 470" fill="none" stroke-width="46"/>' +
            '<path class="sch-road" d="M0 160 L 800 120" />' +
            '<path class="sch-road" d="M0 360 L 800 330" />' +
            '<path class="sch-road" d="M0 520 L 800 560" />' +
            '<path class="sch-road" d="M180 0 L 240 600" />' +
            '<path class="sch-road" d="M560 0 L 520 600" />' +
            '<path class="sch-dash" d="M180 0 L 240 600" />' +
            '<path class="sch-dash" d="M0 360 L 800 330" />' +
          '</svg>' +
          '<div class="schematic-route" hidden>' +
            '<svg viewBox="0 0 800 600" preserveAspectRatio="xMidYMid slice">' +
              '<path class="sch-route-glow" d="" />' +
              '<path class="sch-route" d="" />' +
            '</svg>' +
          '</div>' +
          '<span class="sch-pickup"><i></i>PICKUP</span>' +
          '<span class="sch-dest" hidden>DESTINATION</span>' +
          '<div class="schematic-note">Map tiles need internet. The demo still works: search, fare and the ride queue are live.</div>' +
        '</div>';
      this.container.classList.add('is-schematic');
      this.applyRouteTheme();
    }

    applyRouteTheme() {
      const theme = this.resolveTheme();
      const paint = routePaint[theme] || routePaint.day;
      document.documentElement.dataset.routeTheme = theme;
      if (this.gl) {
        if (theme !== this._styleTheme) {
          this._styleTheme = theme;
          try { this.gl.setStyle(mapStyleUrl(theme), { diff: false }); } catch (_) { /* ignore */ }
          // The new style's 'style.load' event calls installRouteLayers().
        } else {
          this.applyRoutePaint();
        }
        return;
      }
      const root = this.container.querySelector('.schematic');
      if (root) root.dataset.theme = theme;
      const core = this.container.querySelector('.sch-route');
      const glow = this.container.querySelector('.sch-route-glow');
      if (core) core.style.stroke = paint.core;
      if (glow) glow.style.stroke = paint.glow;
    }

    getCenter() { return this.center; }

    setCenter(lat, lng, opts) {
      this.center = { lat, lng };
      localStorage.setItem(KEYS.lastCenter, JSON.stringify(this.center));
      if (this.gl) this.gl.jumpTo({ center: [lng, lat] });
      if (!(opts && opts.silent) && this.onPickup) this.onPickup(lat, lng);
    }

    flyTo(lat, lng, zoom) {
      this.center = { lat, lng };
      if (this.gl) this.gl.flyTo({ center: [lng, lat], zoom: zoom || 14, essential: true });
    }

    setPickupMarker(latlng, label) {
      this.pickup = latlng ? { lat: latlng.lat, lng: latlng.lng, label: label || 'Pickup' } : null;
      if (!this.gl || !latlng) {
        if (this.pickupMarker) { this.pickupMarker.remove(); this.pickupMarker = null; }
        return;
      }
      if (this.pickupMarker) { this.pickupMarker.remove(); this.pickupMarker = null; }
      const el = document.createElement('div');
      el.className = 'map-pin map-pin-pickup';
      el.innerHTML = '<span class="map-pin-dot"></span><span class="map-pin-label">' + escapeHtml(label || 'Pickup') + '</span>';
      this.pickupMarker = new window.maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([latlng.lng, latlng.lat]).addTo(this.gl);
    }

    clearPickupMarker() {
      if (this.pickupMarker) { this.pickupMarker.remove(); this.pickupMarker = null; }
      this.pickup = null;
    }

    setDestination(latlng, label) {
      this.destination = latlng ? { lat: latlng.lat, lng: latlng.lng, label: label || '' } : null;
      if (!this.gl) {
        const dest = this.container.querySelector('.sch-dest');
        if (dest) {
          dest.hidden = !this.destination;
          dest.textContent = this.destination ? (this.destination.label || 'DESTINATION') : 'DESTINATION';
        }
        this._drawSchematicRoute();
        return;
      }
      if (this.destMarker) { this.destMarker.remove(); this.destMarker = null; }
      if (!this.destination) return;
      const el = document.createElement('div');
      el.className = 'map-pin map-pin-dest';
      el.innerHTML = '<span class="map-pin-dot"></span><span class="map-pin-label">' + escapeHtml(label || 'Destination') + '</span>';
      this.destMarker = new window.maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([latlng.lng, latlng.lat]).addTo(this.gl);
    }

    drawRoute(route) {
      this.route = route;
      if (!this.gl) { this._drawSchematicRoute(); return; }
      const src = this.gl.getSource('route');
      if (!src) { this._pendingRoute = route; return; }
      src.setData({ type: 'Feature', geometry: route.geometry, properties: {} });
      this.fitRoute();
    }

    clearRoute() {
      this.route = null;
      this.setDestination(null);
      if (this.gl && this.gl.getSource('route')) {
        this.gl.getSource('route').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: {} });
      }
      this._drawSchematicRoute();
    }

    _drawSchematicRoute() {
      if (this.gl) return;
      const wrap = this.container.querySelector('.schematic-route');
      const core = this.container.querySelector('.sch-route');
      const glow = this.container.querySelector('.sch-route-glow');
      if (!wrap || !core) return;
      if (!this.destination) { wrap.hidden = true; return; }
      wrap.hidden = false;
      const midX = 300 + (Math.abs(this.destination.lng - this.center.lng) * 900) % 220;
      const d = 'M 250 430 C ' + midX + ' 360, ' + (midX + 40) + ' 260, 560 200';
      core.setAttribute('d', d);
      glow.setAttribute('d', d);
      this.applyRouteTheme();
    }

    applyTheme() { this.applyRouteTheme(); }

    resize() {
      if (this.gl) this.gl.resize();
    }
  }

  // ---------------------------------------------------------------------
  //  8. EXPORTS
  // ---------------------------------------------------------------------
  return {
    KEYS, API_BASE, DEFAULTS, COLORS, routePaint,
    $, $$, escapeHtml, money, km, minutes, timeAgo, clock,
    getAccount, setAccount, clearAccount, estimateFare,
    api, ping, onEngineChange, engine,
    tryEngine, enableLocal, isLocalMode: () => engine.local,
    toast, openModal, closeModal,
    resolveTheme, getThemePreference, applyTheme, cycleTheme, toggleTheme,
    searchPlaces, reverseGeocode, fetchRoute, straightRoute,
    loadMapLibre, SibatMap
  };
})();
