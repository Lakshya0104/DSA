/* RescueRoute dashboard client */
(() => {
  'use strict';

  // ------------------------------------------------------------ constants
  const STATUS = {
    idle: { label: 'Available', color: '#12a594' },
    to_scene: { label: 'En route', color: '#e5484d' },
    on_scene: { label: 'On scene', color: '#f08c00' },
    transporting: { label: 'To hospital', color: '#8e4ec6' },
    handover: { label: 'Handover', color: '#7b8499' },
  };
  const INC_STATUS = {
    queued: 'Waiting for unit', dispatched: 'Unit en route', on_scene: 'Unit on scene',
    transporting: 'To hospital', resolved: 'Closed', stranded: 'Cut off',
  };
  const SEV = {
    1: { label: 'Critical', color: '#e5484d', soft: '#fdecec' },
    2: { label: 'Serious', color: '#f08c00', soft: '#fff3e0' },
    3: { label: 'Minor', color: '#d6a100', soft: '#fff8db' },
  };
  const VIEWS = {
    command: ['Command Center', 'Live ambulance dispatch across Bengaluru'],
    route: ['Route Lab', 'Race Dijkstra against A* on real Bengaluru roads'],
    coverage: ['Coverage', 'How far every ward is from emergency care'],
    fleet: ['Fleet', 'Every ambulance, where it is and how hard it is working'],
    analytics: ['Analytics', 'Call volume, response times and hospital load for this shift'],
    algorithms: ['Algorithms', 'The data structures behind every decision'],
  };
  const AMB_SVG = '<svg viewBox="0 0 24 24"><path d="M2 7h11v9H2zm11 3h4l4 4v2h-8zM6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm11 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6.5 9v1.5H5v1h1.5V13h1v-1.5H9v-1H7.5V9z"/></svg>';
  const GM_SVG = '<svg viewBox="0 0 24 24"><path fill="#ea4335" d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7z"/><circle cx="12" cy="9" r="2.6" fill="#fff"/></svg>';
  const SHIFT_START = 8 * 3600; // simulation clock starts at 08:00

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clock = (s) => { const t = Math.floor(SHIFT_START + s) % 86400; return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}`; };
  const mins = (s) => (s == null || !isFinite(s) ? '—' : `${(s / 60).toFixed(1)} min`);
  const km = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
  const gmPlace = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lng.toFixed(6)}`;
  const gmStreet = (lat, lng) => `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat.toFixed(6)},${lng.toFixed(6)}`;
  const gmDir = (pts) => {
    const f = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
    const mid = [];
    for (let k = 1; k <= 6; k++) mid.push(pts[Math.floor((k * (pts.length - 1)) / 7)]);
    return `https://www.google.com/maps/dir/?api=1&origin=${f(pts[0])}&destination=${f(pts[pts.length - 1])}&travelmode=driving&waypoints=${mid.map(f).join('%7C')}`;
  };

  const backend = window.RR_BACKEND; // present only in the standalone build
  const api = async (url, opts = {}) => {
    if (backend) return backend.api(url, opts);
    const res = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
  };

  // ------------------------------------------------------------ map
  const map = L.map('map', { zoomControl: false, attributionControl: true, minZoom: 11, maxZoom: 18, zoomSnap: 0.5 });
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  map.attributionControl.setPrefix(false);
  const mkPane = (name, z) => { map.createPane(name).style.zIndex = z; return name; };
  mkPane('wards', 210); mkPane('choro', 220); mkPane('roads', 230); mkPane('dots', 240); mkPane('labels', 380);
  const roadCanvas = L.canvas({ pane: 'roads', padding: 0.5 });
  const wardCanvas = L.canvas({ pane: 'wards', padding: 0.5 });
  const dotCanvas = L.canvas({ pane: 'dots', padding: 0.3 });

  const layers = {
    labels: L.layerGroup(),
    choro: L.layerGroup(),
    covDots: L.layerGroup(),
    hotspots: L.layerGroup().addTo(map),
    blocked: L.layerGroup().addTo(map),
    search: L.layerGroup(),
    routes: L.layerGroup().addTo(map),
    hospitals: L.layerGroup().addTo(map),
    incidents: L.layerGroup().addTo(map),
    ambulances: L.layerGroup().addTo(map),
  };

  let meta = null;
  let state = null;
  let view = 'command';
  let tool = 'incident';
  let severity = 2;
  let selectedInc = null;
  const roadLines = [];
  const wardLayers = [];

  const ROAD_STYLE = {
    trunk: { casing: '#e3a03d', fill: '#ffd88a', w: [3.5, 7] },
    primary: { casing: '#e2c27c', fill: '#fff1c4', w: [2.6, 5.5] },
    secondary: { casing: '#d3d8e0', fill: '#ffffff', w: [2, 4.5] },
    residential: { casing: '#d9dde4', fill: '#ffffff', w: [1.4, 3.2] },
  };
  function roadWeight(cls, casing) {
    const z = map.getZoom();
    const [lo, hi] = ROAD_STYLE[cls].w;
    const w = lo + ((hi - lo) * Math.max(0, Math.min(1, (z - 11.5) / 5)));
    return casing ? w + 2 : w;
  }

  function drawBasemap(m) {
    for (const w of m.wards) {
      wardLayers.push(L.polygon(w.ring, { renderer: wardCanvas, color: '#c9d1de', weight: 1, fillColor: '#f4f6f9', fillOpacity: 1, interactive: false }).addTo(map));
    }
    for (const casing of [true, false]) {
      for (const cls of ['residential', 'secondary', 'primary', 'trunk']) {
        const st = ROAD_STYLE[cls];
        const line = L.polyline(m.roads[cls] || [], {
          renderer: roadCanvas, interactive: false, lineCap: 'round', lineJoin: 'round',
          color: casing ? st.casing : st.fill, weight: roadWeight(cls, casing),
        }).addTo(map);
        roadLines.push({ line, cls, casing });
      }
    }
    for (const w of m.wards) {
      L.marker(w.center, { pane: 'labels', interactive: false, icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="map-label ward">${esc(w.name)}</div>` }) }).addTo(layers.labels);
    }
    for (const [name, lat, lng] of m.landmarks.slice(0, 220)) {
      L.marker([lat, lng], { pane: 'labels', interactive: false, icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="map-label">${esc(name)}</div>` }) }).addTo(layers.labels);
    }
    for (const h of m.hospitals) {
      L.marker([h.lat, h.lng], {
        zIndexOffset: 400,
        icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="hosp"><div class="hosp-ico"><svg viewBox="0 0 24 24"><path d="M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7z"/></svg></div><div class="hosp-name">${esc(h.name)}</div></div>` }),
      }).bindTooltip(`<b>${esc(h.name)}</b><br><span style="color:#6b7690">Receiving hospital</span>`, { direction: 'top', offset: [0, -16] }).addTo(layers.hospitals);
    }
    onZoom();
  }

  function onZoom() {
    for (const r of roadLines) r.line.setStyle({ weight: roadWeight(r.cls, r.casing) });
    const z = map.getZoom();
    if (z >= 14.5) layers.labels.addTo(map); else map.removeLayer(layers.labels);
    map.getContainer().classList.toggle('zoom-labels', z >= 13.5);
  }
  map.on('zoomend', onZoom);

  // ------------------------------------------------------------ boot
  async function boot() {
    meta = await api('/api/meta');
    // Street tiles where the host allows them; the vector road graph is drawn either way.
    const tiles = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd', maxZoom: 19, opacity: 0.9,
      attribution: '&copy; OpenStreetMap &copy; CARTO',
    }).addTo(map);
    tiles.once('tileload', () => {
      wardLayers.forEach((p) => p.setStyle({ fillOpacity: 0 }));
      roadLines.forEach((r) => r.line.setStyle({ opacity: r.casing ? 0 : 0.55 }));
    });
    map.attributionControl.addAttribution('Roads: BMTC route geometry (Vonter/bmtc-gtfs) · Wards: BBMP via DataMeet');
    drawBasemap(meta);
    const [s, w, n, e] = meta.bbox;
    map.setMaxBounds([[s - 0.03, w - 0.03], [n + 0.03, e + 0.03]]);
    map.setView([12.962, 77.6], 13);
    $('netChip').textContent = meta.source === 'bmtc'
      ? `Real road network · ${meta.nodes.toLocaleString()} intersections · ${meta.hospitals.length} hospitals`
      : `${meta.source.toUpperCase()} network · ${meta.nodes.toLocaleString()} intersections`;
    buildPresets();
    buildAlgorithmCards();
    connect();
  }

  function connect() {
    const handlers = { state: render, log: (evs) => evs.forEach(addLog) };
    if (backend) { $('liveDot').classList.add('on'); backend.subscribe(handlers); return; }
    const es = new EventSource('/api/stream');
    es.addEventListener('open', () => $('liveDot').classList.add('on'));
    es.addEventListener('error', () => $('liveDot').classList.remove('on'));
    es.addEventListener('state', (e) => handlers.state(JSON.parse(e.data)));
    es.addEventListener('log', (e) => handlers.log(JSON.parse(e.data)));
  }

  // ------------------------------------------------------------ views
  function setView(v) {
    view = v;
    document.querySelectorAll('.nav').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    document.querySelectorAll('.view').forEach((el) => el.classList.toggle('active', el.id === `view-${v}`));
    $('viewTitle').textContent = VIEWS[v][0];
    $('viewSub').textContent = VIEWS[v][1];
    const live = v === 'command';
    for (const k of ['incidents', 'ambulances', 'routes']) live ? layers[k].addTo(map) : map.removeLayer(layers[k]);
    v === 'route' ? layers.search.addTo(map) : map.removeLayer(layers.search);
    if (v === 'coverage') loadCoverage(); else { map.removeLayer(layers.choro); map.removeLayer(layers.covDots); }
    map.getContainer().classList.toggle('crosshair', v === 'command' || v === 'route');
    if (state) renderViewSpecific(true);
  }
  document.querySelectorAll('.nav').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

  // ------------------------------------------------------------ render
  let lastHeavy = 0;
  function render(s) {
    state = s;
    $('simClock').textContent = clock(s.simTime);
    $('autoToggle').checked = s.auto;
    $('rushToggle').checked = s.rushHour;
    renderMapLive(s);
    renderBlocked(s);
    renderHotspots(s);
    renderViewSpecific(false);
  }

  function renderViewSpecific(force) {
    const s = state;
    if (view === 'command') { renderKpis(s); renderFeed(s); renderDock(s); renderDetail(s); }
    const now = performance.now();
    if (!force && now - lastHeavy < 1500) return;
    lastHeavy = now;
    if (view === 'fleet') renderFleet(s);
    if (view === 'analytics') renderAnalytics(s);
    if (view === 'algorithms') renderAlgoLive(s);
  }

  // ---- live map objects
  const ambMarkers = new Map(), ambRoutes = new Map(), incMarkers = new Map();
  const ambIcon = (a) => L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="amb ${a.status}" style="background:${STATUS[a.status].color}">${AMB_SVG}${a.id.slice(-2)}</div>` });
  const incIcon = (i) => {
    const c = i.status === 'resolved' ? '#9aa3b5' : SEV[i.severity].color;
    const ring = ['queued', 'dispatched', 'stranded'].includes(i.status) ? '<div class="ring"></div>' : '';
    return L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="incm" style="--c:${c}">${ring}<div class="core"></div></div>` });
  };

  function renderMapLive(s) {
    for (const a of s.ambulances) {
      let m = ambMarkers.get(a.id);
      if (!m) {
        m = L.marker([a.lat, a.lng], { icon: ambIcon(a), zIndexOffset: 1000 }).addTo(layers.ambulances);
        m.bindTooltip('', { direction: 'top', offset: [0, -14] });
        ambMarkers.set(a.id, m);
      }
      m.setLatLng([a.lat, a.lng]);
      if (m._st !== a.status) { m.setIcon(ambIcon(a)); m._st = a.status; }
      m.setTooltipContent(`<b>${a.id}</b> · ${STATUS[a.status].label}${a.incidentId ? ` → ${a.incidentId}` : ''}${a.eta != null ? `<br>Arrives in ${mins(a.eta)}` : ''}`);
      let line = ambRoutes.get(a.id);
      if (a.route) {
        const st = { color: STATUS[a.status].color, weight: 5, opacity: 0.9, dashArray: a.status === 'transporting' ? '1 9' : null, lineCap: 'round' };
        if (!line) { line = L.polyline(a.route, st).addTo(layers.routes); ambRoutes.set(a.id, line); } else { line.setLatLngs(a.route); line.setStyle(st); }
      } else if (line) { layers.routes.removeLayer(line); ambRoutes.delete(a.id); }
    }
    const seen = new Set();
    for (const i of s.incidents) {
      seen.add(i.id);
      let m = incMarkers.get(i.id);
      if (!m) {
        m = L.marker([i.lat, i.lng], { icon: incIcon(i), zIndexOffset: 800 }).addTo(layers.incidents);
        m.on('click', (e) => { L.DomEvent.stopPropagation(e); selectIncident(i.id); });
        m.bindTooltip('', { direction: 'top', offset: [0, -12] });
        incMarkers.set(i.id, m);
      } else if (m._st !== i.status) m.setIcon(incIcon(i));
      m._st = i.status;
      m.setTooltipContent(`<b>${esc(i.type)}</b><br>${SEV[i.severity].label} · ${INC_STATUS[i.status]}`);
    }
    for (const [id, m] of incMarkers) if (!seen.has(id)) { layers.incidents.removeLayer(m); incMarkers.delete(id); }
  }

  let blockedSig = '', hotSig = '';
  function renderBlocked(s) {
    const sig = JSON.stringify(s.blocked);
    if (sig === blockedSig) return;
    blockedSig = sig;
    layers.blocked.clearLayers();
    for (const seg of s.blocked) {
      L.polyline(seg, { color: '#fff', weight: 11, opacity: 1, interactive: false }).addTo(layers.blocked);
      L.polyline(seg, { color: '#e5484d', weight: 7, dashArray: '4 6', lineCap: 'butt', interactive: false }).addTo(layers.blocked);
      const mid = [(seg[0][0] + seg[1][0]) / 2, (seg[0][1] + seg[1][1]) / 2];
      L.marker(mid, { interactive: false, icon: L.divIcon({ className: '', iconSize: [0, 0], html: '<div class="incm" style="--c:#e5484d;width:18px;height:18px"><div class="core" style="inset:0;border-radius:5px;display:grid;place-items:center;color:#fff;font-weight:900;font-size:11px">✕</div></div>' }) }).addTo(layers.blocked);
    }
  }
  function renderHotspots(s) {
    const sig = JSON.stringify(s.hotspots);
    if (sig === hotSig) return;
    hotSig = sig;
    layers.hotspots.clearLayers();
    for (const h of s.hotspots) {
      L.circle([h.lat, h.lng], { radius: h.radius, stroke: false, fillColor: '#f08c00', fillOpacity: 0.16, interactive: false }).addTo(layers.hotspots);
      L.circle([h.lat, h.lng], { radius: h.radius * 0.5, stroke: false, fillColor: '#e5484d', fillOpacity: 0.12, interactive: false }).addTo(layers.hotspots);
    }
  }

  // ---- command center
  function renderKpis(s) {
    const active = s.incidents.filter((i) => i.status !== 'resolved').length;
    const idle = s.ambulances.filter((a) => a.status === 'idle').length;
    $('kpiActive').textContent = active;
    $('kpiQueued').textContent = s.queue.length ? `${s.queue.length} waiting for a unit` : 'No calls waiting';
    $('kpiFleet').textContent = `${idle}/${s.ambulances.length}`;
    $('kpiFleetFoot').textContent = `${s.ambulances.length - idle} on assignment`;
    $('kpiAvg').textContent = s.stats.avgResponse == null ? '—' : `${(s.stats.avgResponse / 60).toFixed(1)} min`;
    $('kpiP90').textContent = s.stats.p90Response == null ? 'Waiting for first arrival' : `90% within ${mins(s.stats.p90Response)}`;
    const sla = s.analytics.sla;
    $('kpiSla').textContent = sla == null ? '—' : `${Math.round(sla * 100)}%`;
    $('kpiResolved').textContent = `${s.stats.resolved} calls closed`;
  }

  const STEP_INDEX = { queued: 1, stranded: 1, dispatched: 2, on_scene: 3, transporting: 4, resolved: 5 };
  function renderFeed(s) {
    const rank = { stranded: 0, queued: 1, dispatched: 2, on_scene: 3, transporting: 4, resolved: 5 };
    const qpos = new Map(s.queue.map((id, k) => [id, k]));
    const list = [...s.incidents].sort((a, b) => rank[a.status] - rank[b.status] || (qpos.get(a.id) ?? 0) - (qpos.get(b.id) ?? 0) || a.severity - b.severity || b.reportedAt - a.reportedAt);
    $('incidentList').innerHTML = list.length ? list.map((i) => {
      const sv = SEV[i.severity];
      const right = i.status === 'dispatched' && i.etaAt ? `Arrives in ${mins(i.etaAt - s.simTime)}`
        : i.arrivedAt ? `Reached in ${mins(i.arrivedAt - i.reportedAt)}` : `Waiting ${mins(s.simTime - i.reportedAt)}`;
      const step = STEP_INDEX[i.status];
      return `<div class="inc ${selectedInc === i.id ? 'selected' : ''}" data-id="${i.id}" style="--sev:${sv.color};--sev-soft:${sv.soft}">
        <div class="inc-top"><span class="inc-type">${esc(i.type)}</span><span class="sev-tag">${sv.label}</span></div>
        <div class="inc-place">${esc(i.street ? 'Near ' + i.street : 'Unnamed street')}${i.ward ? ' · ' + esc(i.ward) : ''}</div>
        <div class="steps">${[1, 2, 3, 4, 5].map((k) => `<i class="${k <= step ? 'on' : ''}"></i>`).join('')}</div>
        <div class="inc-meta"><span>${INC_STATUS[i.status]}${i.ambulance ? ' · ' + i.ambulance : ''}</span><span>${right}</span></div>
      </div>`;
    }).join('') : '<div class="empty-feed">No calls right now. Click a street on the map to report one.</div>';
  }
  $('incidentList').addEventListener('pointerdown', (e) => { const el = e.target.closest('.inc'); if (el) selectIncident(el.dataset.id, true); });

  function renderDock(s) {
    const counts = {};
    for (const a of s.ambulances) counts[a.status] = (counts[a.status] || 0) + 1;
    $('fleetDock').innerHTML = `<div class="dock-title"><span>Fleet</span><span>${s.ambulances.length} units</span></div>
      <div class="dock-units">${s.ambulances.map((a) => `<button class="dock-unit" data-id="${a.id}" title="${a.id} · ${STATUS[a.status].label}" style="background:${STATUS[a.status].color}">${a.id.slice(-2)}</button>`).join('')}</div>
      <div class="dock-legend">${Object.entries(STATUS).map(([k, v]) => `<span><i style="background:${v.color}"></i>${v.label} ${counts[k] || 0}</span>`).join('')}</div>`;
  }
  $('fleetDock').addEventListener('pointerdown', (e) => { const b = e.target.closest('.dock-unit'); if (b) focusUnit(b.dataset.id); });

  function focusUnit(id) {
    const a = state.ambulances.find((x) => x.id === id);
    if (!a) return;
    if (view !== 'command') setView('command');
    map.flyTo([a.lat, a.lng], 15.5, { duration: 0.8 });
    ambMarkers.get(id)?.openTooltip();
  }

  function selectIncident(id, fly) {
    selectedInc = id;
    const i = state?.incidents.find((x) => x.id === id);
    if (i && fly) map.flyTo([i.lat, i.lng], Math.max(map.getZoom(), 15), { duration: 0.7 });
    renderDetail(state);
    renderFeed(state);
  }

  function renderDetail(s) {
    const el = $('incidentDetail');
    const i = selectedInc && s.incidents.find((x) => x.id === selectedInc);
    if (!i) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const sv = SEV[i.severity];
    const steps = [
      ['Call received', i.reportedAt],
      ['Unit dispatched', i.dispatchedAt],
      ['Unit on scene', i.arrivedAt],
      ['Patient to hospital', i.status === 'transporting' || i.hospital ? (i.arrivedAt ?? null) : null],
      ['Closed', i.resolvedAt],
    ];
    const cur = STEP_INDEX[i.status];
    const amb = i.ambulance && s.ambulances.find((a) => a.id === i.ambulance);
    el.innerHTML = `
      <button class="close" aria-label="Close" id="detailClose">×</button>
      <span class="sev-tag" style="--sev:${sv.color};--sev-soft:${sv.soft}">${sv.label} · ${i.id}</span>
      <h3 style="margin-top:8px">${esc(i.type)}</h3>
      <div class="muted" style="font-size:13.5px">${esc(i.street ? 'Near ' + i.street : '')}${i.ward ? ` · ${esc(i.ward)} ward` : ''}</div>
      <ol class="timeline">${steps.map(([label, t], k) => `<li class="${k + 1 < cur || (k + 1 === cur && i.status === 'resolved') ? 'done' : k + 1 === cur ? 'now' : ''}">
        <span class="node"></span><span>${label}${k === 3 && i.hospital ? `<br><span class="muted">${esc(i.hospital)}</span>` : ''}</span><span class="when">${t != null && (k + 1 <= cur) ? clock(t) : ''}</span></li>`).join('')}</ol>
      ${amb && amb.eta != null ? `<div class="verdict" style="margin-bottom:12px"><b class="big" style="color:var(--route)">${mins(amb.eta)}</b><p>${amb.id} ${amb.status === 'transporting' ? 'reaches hospital' : 'reaches the scene'}</p></div>` : ''}
      <div class="gm-links">
        <a class="gm primary" target="_blank" rel="noopener" href="${gmPlace(i.lat, i.lng)}">${GM_SVG}Open in Google Maps</a>
        <a class="gm" target="_blank" rel="noopener" href="${gmStreet(i.lat, i.lng)}">Street View</a>
        ${amb && amb.route ? `<a class="gm" target="_blank" rel="noopener" href="${gmDir(amb.route)}">Unit's route</a>` : ''}
      </div>`;
    $('detailClose').onclick = () => { selectedInc = null; renderDetail(state); renderFeed(state); };
  }

  // ---- tools
  const HINTS = { incident: 'Click any street to report an emergency call', block: 'Click a road to close it. Click it again to reopen it.' };
  document.querySelectorAll('.tool[data-tool]').forEach((b) => b.addEventListener('click', () => {
    tool = b.dataset.tool;
    document.querySelectorAll('.tool[data-tool]').forEach((x) => x.classList.toggle('active', x === b));
    $('mapHint').textContent = HINTS[tool];
  }));
  $('severityChips').addEventListener('click', (e) => {
    const sv = e.target.dataset.sev;
    if (!sv) return;
    severity = +sv;
    document.querySelectorAll('#severityChips .sev').forEach((c) => c.classList.toggle('active', c.dataset.sev === sv));
    document.querySelector('[data-tool=incident]').click();
  });
  $('clearBlocksBtn').addEventListener('click', () => api('/api/roads/blocks', { method: 'DELETE' }));
  $('autoToggle').addEventListener('change', (e) => api('/api/auto', { method: 'POST', body: { auto: e.target.checked } }));
  $('rushToggle').addEventListener('change', (e) => api('/api/traffic', { method: 'POST', body: { rushHour: e.target.checked } }));

  function flash(el, msg, back) {
    el.textContent = msg;
    setTimeout(() => { el.textContent = back; }, 2600);
  }

  map.on('click', async (e) => {
    const { lat, lng } = e.latlng;
    try {
      if (view === 'command') {
        if (tool === 'incident') {
          const inc = await api('/api/incidents', { method: 'POST', body: { lat, lng, severity } });
          selectedInc = inc.id;
        } else {
          await api('/api/roads/toggle', { method: 'POST', body: { lat, lng } });
        }
      } else if (view === 'route') {
        routeClick(lat, lng);
      }
    } catch (err) {
      flash($('mapHint'), err.message, HINTS[tool]);
    }
  });

  // ------------------------------------------------------------ route lab
  let routeStart = null, lastRoute = null, animToken = 0;
  const pinIcon = (label, color) => L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="pin" style="background:${color}"><b>${label}</b></div>` });

  function buildPresets() {
    const find = (kw) => meta.landmarks.find((l) => l[0].toLowerCase().includes(kw));
    const pairs = [
      ['kempegowda bus station', 'koramangala'], ['hebbal', 'jayanagar'], ['yeshwanthpura', 'indiranagar'],
      ['shivajinagar', 'banashankari'], ['malleshwaram', 'hsr'],
    ];
    const out = [];
    for (const [a, b] of pairs) {
      const A = find(a), B = find(b);
      if (A && B && A !== B) out.push([A, B]);
    }
    $('routePresets').innerHTML = out.length ? '<div class="section-label">Or try a cross-city trip</div>' + out.map(([A, B], k) =>
      `<button class="preset" data-k="${k}">${esc(A[0])} → ${esc(B[0])}<span>›</span></button>`).join('') : '';
    $('routePresets').onclick = (e) => {
      const b = e.target.closest('.preset');
      if (!b) return;
      const [A, B] = out[+b.dataset.k];
      runRoute({ lat: A[1], lng: A[2] }, { lat: B[1], lng: B[2] });
    };
  }

  function routeClick(lat, lng) {
    if (!routeStart) {
      animToken++;
      layers.search.clearLayers();
      routeStart = { lat, lng };
      L.marker([lat, lng], { icon: pinIcon('A', '#0e1a33'), zIndexOffset: 2000 }).addTo(layers.search);
      $('routeHint').textContent = 'Now click the destination';
    } else {
      const from = routeStart;
      routeStart = null;
      runRoute(from, { lat, lng });
    }
  }

  async function runRoute(from, to) {
    $('routeHint').textContent = 'Running both searches…';
    lastRoute = await api('/api/route', { method: 'POST', body: { from, to } });
    $('routeHint').textContent = 'Click a start point for a new race';
    animateRace(lastRoute);
  }

  function nearestLandmark(lat, lng) {
    let best = null, bd = Infinity;
    for (const l of meta.landmarks) {
      const d = (l[1] - lat) ** 2 + ((l[2] - lng) * 0.975) ** 2;
      if (d < bd) { bd = d; best = l; }
    }
    return best && bd < 0.0000500 ? best[0] : null; // ~800 m
  }

  function animateRace(r) {
    animToken++;
    const token = animToken;
    layers.search.clearLayers();
    L.marker(r.from, { icon: pinIcon('A', '#0e1a33'), zIndexOffset: 2000 }).addTo(layers.search);
    L.marker(r.to, { icon: pinIcon('B', '#e5484d'), zIndexOffset: 2000 }).addTo(layers.search);
    map.flyToBounds(L.latLngBounds([r.from, r.to]).pad(0.35), { duration: 0.6, paddingBottomRight: [420, 0] });

    const d = r.dijkstra, a = r.astar;
    if (!d.found) {
      $('routeCompare').className = '';
      $('routeCompare').innerHTML = '<div class="verdict"><b class="big" style="color:var(--siren)">No route</b><p>The destination is cut off by closed roads.</p></div>';
      return;
    }
    const max = Math.max(d.settled, a.settled);
    $('routeCompare').className = '';
    $('routeCompare').innerHTML = `
      ${racer('dj', 'Dijkstra', '#3e63dd', d)}
      ${racer('as', 'A*', '#8e4ec6', a)}
      <div class="verdict hidden" id="raceVerdict"></div>
      <div id="raceDirections"></div>`;

    const runs = [
      { pts: d.explored, color: '#3e63dd', i: 0, total: d.settled, id: 'dj' },
      { pts: a.explored, color: '#8e4ec6', i: 0, total: a.settled, id: 'as' },
    ];
    const frames = 110;
    const step = () => {
      if (token !== animToken) return;
      let done = true;
      for (const run of runs) {
        const per = Math.max(1, Math.ceil(run.pts.length / frames));
        const end = Math.min(run.pts.length, run.i + per);
        for (; run.i < end; run.i++) {
          L.circleMarker(run.pts[run.i], { renderer: dotCanvas, radius: 2.4, stroke: false, fillColor: run.color, fillOpacity: 0.38, interactive: false }).addTo(layers.search);
        }
        const shown = Math.round((run.i / Math.max(1, run.pts.length)) * run.total);
        const cnt = document.querySelector(`#${run.id}-count`);
        if (cnt) cnt.firstChild.textContent = shown.toLocaleString();
        const bar = document.querySelector(`#${run.id}-bar`);
        if (bar) bar.style.width = `${(100 * shown) / max}%`;
        if (run.i < run.pts.length) done = false;
      }
      if (!done) { requestAnimationFrame(step); return; }
      L.polyline(d.path, { color: '#3e63dd', weight: 9, opacity: 0.35, lineCap: 'round' }).addTo(layers.search);
      L.polyline(a.path, { color: '#8e4ec6', weight: 4, opacity: 1, lineCap: 'round' }).addTo(layers.search);
      finishRace(r);
    };
    requestAnimationFrame(step);
  }

  function racer(id, name, color, x) {
    return `<div class="racer">
      <div class="racer-head"><span class="racer-name"><i style="background:${color}"></i>${name}</span>
        <span class="racer-count" id="${id}-count">0<small>intersections</small></span></div>
      <div class="track"><div id="${id}-bar" style="background:${color}"></div></div>
      <div class="racer-meta"><span>${mins(x.seconds)} drive · ${km(x.meters)}</span><span>${x.ms.toFixed(1)} ms</span></div>
    </div>`;
  }

  function finishRace(r) {
    const d = r.dijkstra, a = r.astar;
    const saving = Math.round(100 * (1 - a.settled / d.settled));
    const v = $('raceVerdict');
    v.classList.remove('hidden');
    v.innerHTML = `<b class="big">${saving}% less work</b><p>A* found the same ${mins(a.seconds)} route while exploring ${(d.settled - a.settled).toLocaleString()} fewer intersections. Its straight-line estimate never overstates the remaining drive, so the route is still optimal.${r.cached ? ' This answer came from the LRU route cache.' : ''}</p>`;
    // Turn-by-turn style landmarks along the path
    const marks = [];
    let acc = 0;
    const path = a.path;
    const segKm = (p, q) => Math.hypot((p[0] - q[0]) * 110.5, (p[1] - q[1]) * 108.6);
    const total = path.reduce((s, p, k) => (k ? s + segKm(path[k - 1], p) : 0), 0);
    let next = 0;
    for (let k = 0; k < path.length; k++) {
      if (k) acc += segKm(path[k - 1], path[k]);
      if (acc >= next || k === path.length - 1) {
        const name = nearestLandmark(path[k][0], path[k][1]);
        if (name && !marks.some((m) => m[1] === name)) marks.push([acc, name]);
        next = acc + Math.max(0.8, total / 9);
      }
    }
    $('raceDirections').innerHTML = `
      <div class="section-label" style="margin-bottom:6px">Passes through</div>
      <ul class="directions">${marks.map(([dk, n]) => `<li><span>${dk.toFixed(1)} km</span><span>${esc(n)}</span></li>`).join('')}</ul>
      <div class="gm-links" style="margin-top:14px">
        <a class="gm primary" target="_blank" rel="noopener" href="${gmDir(a.path)}">${GM_SVG}Compare in Google Maps</a>
        <button class="gm" id="replayBtn">Replay race</button>
      </div>`;
    $('replayBtn').onclick = () => animateRace(r);
  }

  // ------------------------------------------------------------ coverage
  const covColor = (min) => {
    if (min == null) return '#cfd6e3';
    const stops = [[0, [26, 158, 119]], [3, [123, 200, 108]], [6, [242, 211, 79]], [9, [243, 154, 61]], [12, [217, 67, 75]]];
    const m = Math.max(0, Math.min(12, min));
    for (let k = 1; k < stops.length; k++) {
      if (m <= stops[k][0]) {
        const [a0, c0] = stops[k - 1], [a1, c1] = stops[k];
        const t = (m - a0) / (a1 - a0);
        return `rgb(${c0.map((c, j) => Math.round(c + (c1[j] - c) * t)).join(',')})`;
      }
    }
    return 'rgb(217,67,75)';
  };

  async function loadCoverage() {
    const c = await api('/api/coverage?threshold=8');
    if (view !== 'coverage') return;
    layers.choro.clearLayers();
    layers.covDots.clearLayers();
    c.wards.forEach((w, k) => {
      const ward = meta.wards[k];
      if (!ward) return;
      const minutes = w.avgSeconds == null ? null : w.avgSeconds / 60;
      L.polygon(ward.ring, { pane: 'choro', color: '#ffffff', weight: 1.2, fillColor: covColor(minutes), fillOpacity: 0.62 })
        .bindTooltip(`<b>${esc(w.name)}</b><br>${minutes == null ? 'No roads in data' : `${minutes.toFixed(1)} min to nearest hospital`}`, { sticky: true })
        .addTo(layers.choro);
    });
    for (const [lat, lng, t] of c.points) {
      L.circleMarker([lat, lng], { renderer: dotCanvas, radius: 2.2, stroke: false, fillColor: covColor(t < 0 ? 99 : t / 60), fillOpacity: 0.85, interactive: false }).addTo(layers.covDots);
    }
    layers.choro.addTo(map);
    if ($('dotsToggle').checked) layers.covDots.addTo(map);

    const ranked = c.wards.map((w, k) => ({ ...w, k })).filter((w) => w.avgSeconds != null).sort((a, b) => b.avgSeconds - a.avgSeconds);
    const worst = ranked.slice(0, 8);
    const hosp = [...c.perHospital].sort((a, b) => b.nodes - a.nodes);
    const total = c.bins.reduce((a, b) => a + b, 0);
    const binColors = ['#1a9e77', '#7bc86c', '#f2d34f', '#f39a3d', '#d9434b'];
    const binLabels = ['< 3 min', '3–5', '5–8', '8–12', '12+'];
    $('coverageStats').innerHTML = `
      <div class="metric-row">
        <div class="metric"><b>${mins(c.avgSeconds)}</b><span>City average</span></div>
        <div class="metric"><b>${mins(c.worstSeconds)}</b><span>Farthest street</span></div>
        <div class="metric"><b style="color:${c.underservedPct > 15 ? 'var(--siren)' : 'inherit'}">${c.underservedPct.toFixed(0)}%</b><span>Over 8 min</span></div>
      </div>
      <div>
        <div class="section-label" style="margin-bottom:8px">Intersections by drive time</div>
        <div style="display:flex;height:14px;border-radius:99px;overflow:hidden">${c.bins.map((b, k) => `<div title="${binLabels[k]}: ${b}" style="width:${(100 * b) / total}%;background:${binColors[k]}"></div>`).join('')}</div>
        <div class="chart-legend">${binLabels.map((l, k) => `<span><i style="background:${binColors[k]}"></i>${l} · ${Math.round((100 * c.bins[k]) / total)}%</span>`).join('')}</div>
      </div>
      <div>
        <div class="section-label" style="margin-bottom:8px">Wards farthest from care</div>
        <ul class="rank" id="worstWards">${worst.map((w) => `<li data-k="${w.k}"><span class="rank-name">${esc(w.name)}</span><span class="mono">${(w.avgSeconds / 60).toFixed(1)} min</span>
          <span class="rank-bar"><div style="width:${(100 * w.avgSeconds) / worst[0].avgSeconds}%;background:${covColor(w.avgSeconds / 60)}"></div></span></li>`).join('')}</ul>
      </div>
      <div>
        <div class="section-label" style="margin-bottom:8px">Hospital catchment <span style="text-transform:none;letter-spacing:0">(intersections closest to each)</span></div>
        ${hosp.slice(0, 7).map((h) => `<div class="hbar"><span class="lbl">${esc(h.name)}</span><span class="bar"><div style="width:${(100 * h.nodes) / hosp[0].nodes}%;background:var(--care)"></div></span><span class="val">${h.nodes.toLocaleString()}</span></div>`).join('')}
      </div>
      <p class="muted small" style="margin:0">Computed in ${c.ms} ms over ${total.toLocaleString()} intersections. Closing roads changes these numbers, so try closing a few and come back.</p>`;
    $('worstWards').onclick = (e) => {
      const li = e.target.closest('li');
      if (li) map.flyToBounds(L.latLngBounds(meta.wards[+li.dataset.k].ring), { duration: 0.7, paddingBottomRight: [420, 0], maxZoom: 15 });
    };
  }
  $('dotsToggle').addEventListener('change', (e) => { if (view === 'coverage') e.target.checked ? layers.covDots.addTo(map) : map.removeLayer(layers.covDots); });

  // ------------------------------------------------------------ charts (SVG)
  function donut(segments, size = 150, thick = 22) {
    const total = segments.reduce((s, x) => s + x.value, 0) || 1;
    const r = (size - thick) / 2, c = 2 * Math.PI * r;
    let off = 0;
    const arcs = segments.map((sg) => {
      const len = (sg.value / total) * c;
      const el = `<circle r="${r}" cx="${size / 2}" cy="${size / 2}" fill="none" stroke="${sg.color}" stroke-width="${thick}" stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-off}" transform="rotate(-90 ${size / 2} ${size / 2})"/>`;
      off += len;
      return el;
    }).join('');
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="flex:none"><circle r="${r}" cx="${size / 2}" cy="${size / 2}" fill="none" stroke="#edf0f5" stroke-width="${thick}"/>${arcs}</svg>`;
  }

  function hbars(rows, color, fmt = (v) => v) {
    if (!rows.length) return '<div class="empty-chart">No data yet. Give the shift a minute.</div>';
    const max = Math.max(...rows.map((r) => r.value), 1);
    return rows.map((r) => `<div class="hbar"><span class="lbl" title="${esc(r.name)}">${esc(r.name)}</span><span class="bar"><div style="width:${(100 * r.value) / max}%;background:${r.color || color}"></div></span><span class="val">${fmt(r.value)}</span></div>`).join('');
  }

  function renderFleet(s) {
    const counts = Object.keys(STATUS).map((k) => ({ key: k, value: s.ambulances.filter((a) => a.status === k).length, color: STATUS[k].color }));
    $('fleetDonut').innerHTML = `<div style="position:relative">${donut(counts)}<div style="position:absolute;inset:0;display:grid;place-items:center;text-align:center"><div><b style="font-size:28px">${counts[0].value}</b><div class="muted small">available</div></div></div></div>
      <div class="donut-legend">${counts.map((c) => `<div><i style="background:${c.color}"></i>${STATUS[c.key].label}<b>${c.value}</b></div>`).join('')}</div>`;
    const util = [...s.ambulances].sort((a, b) => b.utilization - a.utilization).map((a) => ({ name: `${a.id} · ${a.baseName}`, value: a.utilization, color: a.utilization > 0.7 ? '#e5484d' : a.utilization > 0.4 ? '#f08c00' : '#12a594' }));
    $('fleetUtil').innerHTML = hbars(util.slice(0, 8), '#3e63dd', (v) => `${Math.round(v * 100)}%`);
    $('unitGrid').innerHTML = s.ambulances.map((a) => {
      const st = STATUS[a.status];
      const where = a.incidentId ? `${a.status === 'transporting' ? 'Carrying patient from' : 'Assigned to'} ${a.incidentId}${a.eta != null ? ` · arrives in ${mins(a.eta)}` : ''}` : a.place ? `Waiting near ${a.place}` : `Based at ${a.baseName}`;
      return `<div class="unit">
        <div class="unit-head"><div class="unit-badge" style="background:${st.color}">${AMB_SVG}</div>
          <div><div class="unit-id">${a.id}</div><div class="unit-status" style="color:${st.color}">${st.label}</div></div></div>
        <div class="unit-where">${esc(where)}</div>
        <div class="unit-stats"><div><b>${a.trips}</b><span>Calls</span></div><div><b>${a.km.toFixed(1)}</b><span>km</span></div><div><b>${Math.round(a.utilization * 100)}%</b><span>Busy</span></div></div>
        <div class="unit-foot"><button class="gm" data-locate="${a.id}">Locate</button><a class="gm" target="_blank" rel="noopener" href="${gmPlace(a.lat, a.lng)}">${GM_SVG}Maps</a></div>
      </div>`;
    }).join('');
  }
  $('unitGrid').addEventListener('click', (e) => { const b = e.target.closest('[data-locate]'); if (b) focusUnit(b.dataset.locate); });

  function renderAnalytics(s) {
    const an = s.analytics;
    // stacked bars timeline
    const W = 640, H = 200, P = { l: 30, r: 8, t: 10, b: 26 };
    const tl = an.timeline;
    const maxT = Math.max(2, ...tl.map((r) => r.s1 + r.s2 + r.s3));
    const bw = (W - P.l - P.r) / tl.length;
    const y = (v) => H - P.b - (v / maxT) * (H - P.t - P.b);
    const ticks = [0, Math.ceil(maxT / 2), maxT];
    $('chartTimeline').innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}">
      ${ticks.map((t) => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(t)}" y2="${y(t)}" stroke="#edf0f5"/><text x="${P.l - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join('')}
      ${tl.map((r, k) => {
        let base = 0;
        const x = P.l + k * bw + bw * 0.18, w = bw * 0.64;
        const bars = [['s1', SEV[1].color], ['s2', SEV[2].color], ['s3', SEV[3].color]].map(([key, col]) => {
          const v = r[key]; if (!v) return '';
          const el = `<rect x="${x}" y="${y(base + v)}" width="${w}" height="${y(base) - y(base + v)}" fill="${col}" rx="3"/>`;
          base += v; return el;
        }).join('');
        return bars + (tl.length < 7 || k % 2 === 1 ? `<text x="${x + w / 2}" y="${H - 8}" text-anchor="middle">${clock(Math.max(0, r.t))}</text>` : '');
      }).join('')}
    </svg><div class="chart-legend">${[1, 2, 3].map((k) => `<span><i style="background:${SEV[k].color}"></i>${SEV[k].label}</span>`).join('')}<span class="muted">${an.totalCalls} calls this shift</span></div>`;

    // gauge
    const sla = an.sla;
    const R = 70, C = Math.PI * R;
    $('chartGauge').innerHTML = sla == null ? '<div class="empty-chart">Waiting for the first arrival.</div>' : `
      <svg class="chart" viewBox="0 0 200 132" style="max-width:260px;margin:0 auto">
        <path d="M30 100 A70 70 0 0 1 170 100" fill="none" stroke="#edf0f5" stroke-width="16" stroke-linecap="round"/>
        <path d="M30 100 A70 70 0 0 1 170 100" fill="none" stroke="${sla >= 0.8 ? '#12a594' : sla >= 0.6 ? '#f08c00' : '#e5484d'}" stroke-width="16" stroke-linecap="round" stroke-dasharray="${C * sla} ${C}"/>
        <text x="100" y="92" text-anchor="middle" style="font-size:30px;font-weight:800;fill:#0e1a33">${Math.round(sla * 100)}%</text>
        <text x="100" y="126" text-anchor="middle">reached within 8 minutes</text>
      </svg>
      <div class="metric-row" style="grid-template-columns:1fr 1fr;margin-top:8px">
        <div class="metric"><b>${mins(s.stats.avgResponse)}</b><span>Average</span></div>
        <div class="metric"><b>${mins(s.stats.p90Response)}</b><span>90th percentile</span></div>
      </div>`;

    // histogram
    const hist = an.histogram;
    const maxH = Math.max(1, ...hist);
    const HW = 640, HH = 180, hb = (HW - 40) / hist.length;
    const hy = (v) => HH - 26 - (v / maxH) * (HH - 58);
    $('chartHist').innerHTML = `<svg class="chart" viewBox="0 0 ${HW} ${HH}">
      <line x1="${30 + hb * 4}" x2="${30 + hb * 4}" y1="6" y2="${HH - 26}" stroke="#e5484d" stroke-dasharray="4 4"/>
      <text x="${30 + hb * 4 - 6}" y="14" text-anchor="end" style="fill:#e5484d;font-weight:600">8-min target</text>
      ${hist.map((v, k) => `<rect x="${30 + k * hb + 6}" y="${hy(v)}" width="${hb - 12}" height="${HH - 26 - hy(v)}" rx="6" fill="${k < 4 ? '#3e63dd' : '#f3a3a6'}"/>
        ${v ? `<text x="${30 + k * hb + hb / 2}" y="${hy(v) - 6}" text-anchor="middle" style="fill:#3a4763;font-weight:700">${v}</text>` : ''}
        <text x="${30 + k * hb + hb / 2}" y="${HH - 8}" text-anchor="middle">${k === 7 ? '14+' : `${k * 2}–${k * 2 + 2}`}</text>`).join('')}
    </svg>`;

    $('chartSeverity').innerHTML = an.bySeverity.map((r) => `
      <div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid #f0f2f6">
        <span class="sev-tag" style="--sev:${SEV[r.severity].color};--sev-soft:${SEV[r.severity].soft};min-width:78px;text-align:center">${SEV[r.severity].label}</span>
        <span style="flex:1"><b style="font-size:20px">${r.calls}</b> <span class="muted small">calls</span></span>
        <span class="mono" style="font-size:13px">${mins(r.avgResponse)}</span>
      </div>`).join('') + '<p class="muted small" style="margin:10px 0 0">Right column: average response. Critical calls jump the queue, a min-heap ordered by severity and then call time.</p>';

    $('chartHospitals').innerHTML = hbars(an.hospitalLoad, '#12a594');
    $('chartWards').innerHTML = hbars(an.wardCalls, '#e5484d');
  }

  // ------------------------------------------------------------ algorithms page
  const ALGOS = [
    ['Dijkstra', 'O((V+E) log V)', 'Shortest drive time', 'Finds the fastest route over a weighted road graph. Each road segment costs its length divided by its speed, times a traffic factor.', 'search.js', '#3e63dd', 'DJ'],
    ['A* search', 'O(E) typical', 'Route Lab and live rerouting', 'Dijkstra guided by a straight-line estimate of the remaining drive (distance ÷ top speed). The estimate never overstates the real time, so routes stay optimal while far fewer intersections are explored.', 'search.js', '#8e4ec6', 'A*'],
    ['Reverse multi-target Dijkstra', 'one search, k units', 'Choosing which ambulance to send', 'Searches backwards from the incident along incoming roads, with every free ambulance as a target. The first one reached is the fastest by road. This is one search instead of one per unit, and it respects one-way streets.', 'Simulation.js', '#e5484d', 'RD'],
    ['Multi-source Dijkstra', 'O((V+E) log V) vs O(V³)', 'Coverage map', 'All 14 hospitals start at distance 0 at once. A single pass gives every intersection its drive time to the nearest hospital. Floyd–Warshall would take billions of steps on 16,825 nodes.', 'coverage.js', '#12a594', 'MS'],
    ['Indexed binary heap', 'O(log n) decrease-key', 'Priority queue inside every search', 'Keeps a position index so a node’s distance is lowered in place instead of pushing duplicates.', 'IndexedMinHeap.js', '#0e1a33', 'IH'],
    ['Triage priority queue', 'O(log n) push / pop', 'Incident queue', 'Critical calls come out first, then the oldest call. This is a binary heap with a custom comparator.', 'PriorityQueue.js', '#f08c00', 'PQ'],
    ['2-d tree', 'O(log n) nearest', 'Map clicks, landmarks, traffic zones', 'Built with quickselect medians. Snaps a click to the nearest intersection, names a call after the closest bus stop, and finds every road inside a rush-hour hotspot.', 'KDTree.js', '#3e63dd', 'KD'],
    ['Union-find', 'O(α(n)) per op', 'Detecting areas cut off by closures', 'Path halving plus union by size. Recounts connected components after each road closure, and keeps only the largest component when building the network.', 'UnionFind.js', '#8e4ec6', 'UF'],
    ['LRU cache', 'O(1) get / put', 'Repeat route queries', 'A hash map plus a doubly linked list. Keys include the graph version, so a closure or traffic change invalidates every cached route.', 'LRUCache.js', '#12a594', 'LRU'],
    ['Ray-casting point in polygon', 'O(edges) per ward', 'Ward lookup', 'A bounding-box check first, then a ray cast against the BBMP ward boundary to find which ward each intersection and call falls in.', 'geo.js', '#e5484d', 'PIP'],
    ['Binary search', 'O(log n)', 'Live ambulance positions', 'Each route stores cumulative travel seconds per point. Locating a unit along its route is a lower-bound search over that array.', 'Simulation.js', '#f08c00', 'BS'],
    ['Douglas–Peucker', 'O(n log n) avg', 'Building the ward basemap', 'Simplifies ward boundaries to within 25 m so 171 wards draw quickly. Part of the offline data build.', 'build_bengaluru.py', '#0e1a33', 'DP'],
  ];
  function buildAlgorithmCards() {
    $('algoGrid').innerHTML = ALGOS.map(([name, cx, use, desc, file, color, ab]) => `
      <article class="algo-card">
        <div class="algo-card-head"><div class="algo-ico" style="background:${color}1a;color:${color}">${ab}</div>
          <div><h4>${name}</h4><div class="use">${use}</div></div></div>
        <p>${desc}</p>
        <div class="cx"><span>${cx}</span></div>
        <div class="file">${file}</div>
      </article>`).join('');
  }
  function renderAlgoLive(s) {
    const d = s.stats.lastDispatch;
    const c = s.stats.cache;
    $('algoLive').innerHTML = `
      <div><b>${meta.nodes.toLocaleString()}</b><span>Intersections in graph</span></div>
      <div><b>${d ? `${d.settled.toLocaleString()}` : '—'}</b><span>Nodes the last dispatch searched${d ? ` (${((100 * d.settled) / d.totalNodes).toFixed(1)}%)` : ''}</span></div>
      <div><b>${s.stats.reroutes}</b><span>A* reroutes this shift</span></div>
      <div><b>${c.hits + c.misses ? Math.round((100 * c.hits) / (c.hits + c.misses)) + '%' : '—'}</b><span>Route cache hit rate</span></div>`;
  }

  // ------------------------------------------------------------ log
  const seenLog = new Set();
  function addLog(ev) {
    const key = `${ev.t}|${ev.text}`;
    if (seenLog.has(key)) return;
    seenLog.add(key);
    const row = document.createElement('div');
    row.className = `log-row ${ev.type}`;
    row.innerHTML = `<span class="t">${clock(ev.t)}</span><span class="m">${esc(ev.text)}</span>`;
    const log = $('log');
    log.prepend(row);
    while (log.children.length > 80) log.lastChild.remove();
  }

  setView('command');
  boot().catch((err) => { $('netChip').textContent = `Failed to load: ${err.message}`; });
})();
