/* RescueRoute dashboard client */
(() => {
  'use strict';

  const STATUS_COLOR = {
    idle: '#16a34a', to_scene: '#2563eb', on_scene: '#ea580c', transporting: '#7c3aed', handover: '#94a3b8',
  };
  const STATUS_LABEL = {
    idle: 'Available', to_scene: 'En route', on_scene: 'On scene', transporting: 'Transporting', handover: 'Handover',
    queued: 'Queued', dispatched: 'Dispatched', resolved: 'Resolved', stranded: 'Cut off',
  };
  const SEV = { 1: { label: 'Critical', color: '#dc2626' }, 2: { label: 'Serious', color: '#ea580c' }, 3: { label: 'Minor', color: '#ca8a04' } };
  const COVER_COLORS = ['#16a34a', '#84cc16', '#eab308', '#f97316', '#dc2626'];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtClock = (s) => {
    const t = Math.floor(s);
    return [Math.floor(t / 3600), Math.floor((t % 3600) / 60), t % 60].map((x) => String(x).padStart(2, '0')).join(':');
  };
  const fmtMin = (s) => (s == null || !isFinite(s) ? '—' : `${(s / 60).toFixed(1)} min`);
  const fmtKm = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);

  const backend = window.RR_BACKEND; // set only in the standalone build
  const api = async (url, opts = {}) => {
    if (backend) return backend.api(url, opts);
    const res = await fetch(url, {
      ...opts,
      headers: { 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
  };

  // ------------------------------------------------------------ map setup
  const map = L.map('map', { zoomControl: false, preferCanvas: false });
  L.control.zoom({ position: 'topright' }).addTo(map);
  if (!backend) L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    maxZoom: 19, subdomains: 'abcd',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
  }).addTo(map);

  const canvas = L.canvas({ padding: 0.3 });
  const layers = {
    coverage: L.layerGroup(),
    hotspots: L.layerGroup().addTo(map),
    blocked: L.layerGroup().addTo(map),
    search: L.layerGroup().addTo(map),
    routes: L.layerGroup().addTo(map),
    hospitals: L.layerGroup().addTo(map),
    incidents: L.layerGroup().addTo(map),
    ambulances: L.layerGroup().addTo(map),
  };

  const ambMarkers = new Map();
  const ambRoutes = new Map();
  const incMarkers = new Map();
  let state = null;
  let mode = 'incident';
  let severity = 2;
  let blockedSig = '';
  let hotspotSig = '';

  const ambIcon = (a) => L.divIcon({
    className: '',
    html: `<div class="amb-marker" style="background:${STATUS_COLOR[a.status]}">${a.id.slice(-2)}</div>`,
    iconSize: [30, 30], iconAnchor: [15, 15],
  });
  const incIcon = (i) => L.divIcon({
    className: '',
    html: `<div class="inc-marker">${i.status === 'queued' || i.status === 'dispatched' || i.status === 'stranded'
      ? `<div class="ring" style="background:${SEV[i.severity].color}55"></div>` : ''}
      <div class="core" style="background:${i.status === 'resolved' ? '#94a3b8' : SEV[i.severity].color}"></div></div>`,
    iconSize: [18, 18], iconAnchor: [9, 9],
  });

  // ------------------------------------------------------------ boot
  async function boot() {
    const meta = await api('/api/meta');
    $('cityName').textContent = meta.city;
    const badge = $('sourceBadge');
    badge.textContent = meta.source === 'osm'
      ? `OSM · ${meta.nodes.toLocaleString()} nodes · ${meta.edges.toLocaleString()} edges`
      : `Synthetic grid · ${meta.nodes.toLocaleString()} nodes`;
    if (meta.source !== 'osm') { badge.classList.add('warn'); badge.title = 'OpenStreetMap download failed; using an offline street grid'; }

    if (meta.roads) drawRoads(meta.roads);
    const [s, w, n, e] = meta.bbox;
    map.fitBounds([[s, w], [n, e]], { padding: [20, 20] });
    L.rectangle([[s, w], [n, e]], { color: '#2563eb', weight: 1, dashArray: '4 6', fill: false, interactive: false }).addTo(map);

    for (const h of meta.hospitals) {
      L.marker([h.lat, h.lng], {
        icon: L.divIcon({ className: '', html: '<div class="hosp-marker">H</div>', iconSize: [26, 26], iconAnchor: [13, 13] }),
        zIndexOffset: 500,
      }).bindTooltip(`<b>${esc(h.name)}</b>`, { direction: 'top', offset: [0, -12] }).addTo(layers.hospitals);
    }

    connect();
  }

  /** Standalone build has no tile server, so draw the road graph as the basemap. */
  function drawRoads(roads) {
    map.getContainer().style.background = '#eef0ea';
    const styles = {
      residential: [{ color: '#d6d9de', weight: 3 }, { color: '#ffffff', weight: 2 }],
      secondary: [{ color: '#d9c9a3', weight: 5 }, { color: '#fff4d6', weight: 3.5 }],
      primary: [{ color: '#e0b26b', weight: 6.5 }, { color: '#fde3a7', weight: 4.5 }],
      trunk: [{ color: '#d98f6a', weight: 7 }, { color: '#f9c9a8', weight: 5 }],
    };
    for (const cls of ['residential', 'secondary', 'primary', 'trunk']) {
      for (const st of styles[cls]) {
        L.polyline(roads[cls] || [], { renderer: canvas, interactive: false, lineCap: 'round', ...st }).addTo(map);
      }
    }
  }

  function connect() {
    if (backend) {
      $('liveDot').classList.add('on');
      backend.subscribe({ state: render, log: (evs) => evs.forEach(addLog) });
      return;
    }
    const es = new EventSource('/api/stream');
    es.addEventListener('open', () => $('liveDot').classList.add('on'));
    es.addEventListener('error', () => $('liveDot').classList.remove('on'));
    es.addEventListener('state', (e) => render(JSON.parse(e.data)));
    es.addEventListener('log', (e) => JSON.parse(e.data).forEach(addLog));
  }

  // ------------------------------------------------------------ render loop
  function render(s) {
    state = s;
    $('simClock').textContent = fmtClock(s.simTime);
    $('autoToggle').checked = s.auto;
    $('rushToggle').checked = s.rushHour;
    renderAmbulances(s);
    renderIncidents(s);
    renderKpis(s);
    renderBlocked(s);
    renderHotspots(s);
    renderDispatch(s.stats.lastDispatch);
    renderNetwork(s);
  }

  function renderAmbulances(s) {
    for (const a of s.ambulances) {
      let m = ambMarkers.get(a.id);
      if (!m) {
        m = L.marker([a.lat, a.lng], { icon: ambIcon(a), zIndexOffset: 1000 }).addTo(layers.ambulances);
        m.bindTooltip('', { direction: 'top', offset: [0, -14] });
        m._status = a.status;
        ambMarkers.set(a.id, m);
      }
      m.setLatLng([a.lat, a.lng]);
      if (m._status !== a.status) { m.setIcon(ambIcon(a)); m._status = a.status; }
      m.setTooltipContent(`<b>${a.id}</b> · ${STATUS_LABEL[a.status]}${a.incidentId ? ` → ${a.incidentId}` : ''}${a.eta != null ? `<br>ETA ${fmtMin(a.eta)}` : ''}`);

      let line = ambRoutes.get(a.id);
      if (a.route) {
        const style = { color: STATUS_COLOR[a.status], weight: 4.5, opacity: 0.85, dashArray: a.status === 'transporting' ? '8 6' : null };
        if (!line) { line = L.polyline(a.route, style).addTo(layers.routes); ambRoutes.set(a.id, line); }
        else { line.setLatLngs(a.route); line.setStyle(style); }
      } else if (line) { layers.routes.removeLayer(line); ambRoutes.delete(a.id); }
    }

    const idle = s.ambulances.filter((a) => a.status === 'idle').length;
    $('fleetCount').textContent = `${idle} of ${s.ambulances.length} available`;
    $('fleetList').innerHTML = s.ambulances.map((a) => `
      <div class="item" data-lat="${a.lat}" data-lng="${a.lng}">
        <div class="unit-icon" style="background:${STATUS_COLOR[a.status]}">${a.id.slice(-2)}</div>
        <div><div class="item-title">${a.id}</div>
          <div class="item-sub">${a.incidentId ? `Assigned ${a.incidentId}` : `Base ${a.base}`} · ${a.trips} trips</div></div>
        <div class="item-right"><span class="pill ${a.status}">${STATUS_LABEL[a.status]}</span>
          ${a.eta != null ? `<div class="small muted" style="margin-top:3px">${fmtMin(a.eta)}</div>` : ''}</div>
      </div>`).join('');
  }

  function renderIncidents(s) {
    const seen = new Set();
    for (const i of s.incidents) {
      seen.add(i.id);
      let m = incMarkers.get(i.id);
      const sig = i.status;
      if (!m) {
        m = L.marker([i.lat, i.lng], { icon: incIcon(i), zIndexOffset: 800 }).addTo(layers.incidents);
        m.bindTooltip('', { direction: 'top', offset: [0, -10] });
        incMarkers.set(i.id, m);
      } else if (m._sig !== sig) m.setIcon(incIcon(i));
      m._sig = sig;
      m.setTooltipContent(`<b>${i.id}</b> · ${SEV[i.severity].label}<br>${esc(i.type)}<br><span style="color:#64748b">${STATUS_LABEL[i.status]}${i.ambulance ? ' · ' + i.ambulance : ''}</span>`);
    }
    for (const [id, m] of incMarkers) if (!seen.has(id)) { layers.incidents.removeLayer(m); incMarkers.delete(id); }

    // Queued (triage order) first, then active, then recently resolved.
    const rank = { stranded: 0, queued: 1, dispatched: 2, on_scene: 3, transporting: 4, resolved: 5 };
    const qpos = new Map(s.queue.map((id, k) => [id, k]));
    const list = [...s.incidents].sort((a, b) =>
      rank[a.status] - rank[b.status] || (qpos.get(a.id) ?? 0) - (qpos.get(b.id) ?? 0) || b.reportedAt - a.reportedAt);
    $('incidentList').innerHTML = list.length ? list.map((i) => {
      const age = s.simTime - i.reportedAt;
      const right = i.status === 'dispatched' && i.etaAt ? `ETA ${fmtMin(i.etaAt - s.simTime)}`
        : i.arrivedAt ? `Resp ${fmtMin(i.arrivedAt - i.reportedAt)}` : `${fmtMin(age)} ago`;
      return `<div class="item" data-lat="${i.lat}" data-lng="${i.lng}">
        <div class="sev-bar s${i.severity}"></div>
        <div style="min-width:0"><div class="item-title">${i.id}${qpos.has(i.id) ? ` <span class="muted small">#${qpos.get(i.id) + 1} in queue</span>` : ''}</div>
          <div class="item-sub">${esc(i.type)}${i.street ? ' · ' + esc(i.street) : ''}</div></div>
        <div class="item-right"><span class="pill ${i.status}">${STATUS_LABEL[i.status]}</span><div class="small muted" style="margin-top:3px">${right}</div></div>
      </div>`;
    }).join('') : '<div class="empty">No incidents. Click the map to report one.</div>';
  }

  function renderKpis(s) {
    const active = s.incidents.filter((i) => i.status !== 'resolved').length;
    const idle = s.ambulances.filter((a) => a.status === 'idle').length;
    $('kpiActive').textContent = active;
    $('kpiQueued').textContent = `${s.queue.length} waiting in queue`;
    $('kpiFleet').textContent = `${idle}/${s.ambulances.length}`;
    $('kpiFleetFoot').textContent = `${s.ambulances.length - idle} on assignment`;
    $('kpiAvg').textContent = s.stats.avgResponse == null ? '—' : `${(s.stats.avgResponse / 60).toFixed(1)}m`;
    $('kpiP90').textContent = `P90 ${fmtMin(s.stats.p90Response)}`;
    $('kpiResolved').textContent = s.stats.resolved;
    $('kpiReroutes').textContent = `${s.stats.reroutes} reroutes`;
    renderSpark(s.stats.responseHistory);
  }

  function renderSpark(hist) {
    const svg = $('spark');
    if (!hist.length) { svg.innerHTML = '<text x="150" y="40" text-anchor="middle" fill="#94a3b8" font-size="12">No completed responses yet</text>'; return; }
    const max = Math.max(...hist, 600);
    const W = 300, H = 70, pad = 6;
    const x = (i) => (hist.length === 1 ? W / 2 : pad + (i * (W - 2 * pad)) / (hist.length - 1));
    const y = (v) => H - pad - (v / max) * (H - 2 * pad);
    const pts = hist.map((v, i) => `${x(i)},${y(v)}`).join(' ');
    const target = y(480);
    svg.innerHTML = `
      <line x1="0" x2="${W}" y1="${target}" y2="${target}" stroke="#fca5a5" stroke-dasharray="4 4" />
      <text x="${W - 4}" y="${target - 4}" text-anchor="end" fill="#ef4444" font-size="10">8 min target</text>
      <polygon points="${x(0)},${H} ${pts} ${x(hist.length - 1)},${H}" fill="#2563eb14" />
      <polyline points="${pts}" fill="none" stroke="#2563eb" stroke-width="2" stroke-linejoin="round" />
      ${hist.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="2.5" fill="${v > 480 ? '#dc2626' : '#2563eb'}" />`).join('')}`;
  }

  function renderBlocked(s) {
    const sig = JSON.stringify(s.blocked);
    if (sig === blockedSig) return;
    blockedSig = sig;
    layers.blocked.clearLayers();
    for (const seg of s.blocked) {
      L.polyline(seg, { color: '#fff', weight: 9, opacity: 0.9, interactive: false }).addTo(layers.blocked);
      L.polyline(seg, { color: '#dc2626', weight: 5, dashArray: '6 5', interactive: false }).addTo(layers.blocked);
    }
  }

  function renderHotspots(s) {
    const sig = JSON.stringify(s.hotspots);
    if (sig === hotspotSig) return;
    hotspotSig = sig;
    layers.hotspots.clearLayers();
    for (const h of s.hotspots) {
      L.circle([h.lat, h.lng], { radius: h.radius, color: '#f97316', weight: 1, fillColor: '#fb923c', fillOpacity: 0.14, interactive: false }).addTo(layers.hotspots);
    }
  }

  function renderDispatch(d) {
    if (!d) return;
    const pct = (100 * d.settled) / d.totalNodes;
    $('dispatchInfo').innerHTML = `
      <dl class="kv">
        <dt>Assignment</dt><dd>${d.ambulance} → ${d.incident}</dd>
        <dt>Idle units considered</dt><dd>${d.candidates}</dd>
        <dt>Road ETA</dt><dd>${fmtMin(d.etaSeconds)}</dd>
        <dt>Search time</dt><dd>${d.ms.toFixed(2)} ms</dd>
      </dl>
      <div class="algo-meta"><span>Nodes settled (reverse Dijkstra, early exit)</span><span>${d.settled.toLocaleString()} / ${d.totalNodes.toLocaleString()}</span></div>
      <div class="bar"><div style="width:${Math.max(pct, 0.5)}%;background:#2563eb"></div></div>
      <div class="callout ${d.crowDiffers ? 'warn' : ''}" style="margin-top:10px">${d.crowDiffers
        ? `Straight-line nearest was <b>${d.crowFlies}</b>, but <b>${d.ambulance}</b> is faster by road (one-way streets, closures, traffic).`
        : `One search from the incident covered all ${d.candidates} idle units. That is about ${(100 - pct).toFixed(0)}% less work than searching the whole city.`}</div>`;
  }

  function renderNetwork(s) {
    const st = s.stats;
    $('networkStats').innerHTML = `
      <div class="stat"><b>${st.closedRoads}</b><span>Closed roads</span></div>
      <div class="stat"><b style="color:${st.components > 1 ? '#dc2626' : 'inherit'}">${st.components}</b><span>Components</span></div>
      <div class="stat"><b>${st.isolatedNodes.toLocaleString()}</b><span>Cut-off nodes</span></div>
      <div class="stat"><b>${st.cache.hits}/${st.cache.hits + st.cache.misses}</b><span>LRU cache hits</span></div>
      <div class="stat"><b>${st.reroutes}</b><span>A* reroutes</span></div>
      <div class="stat"><b>${st.stranded}</b><span>Stranded calls</span></div>`;
  }

  // ------------------------------------------------------------ activity log
  const seenLog = new Set();
  function addLog(ev) {
    const key = `${ev.t}|${ev.text}`;
    if (seenLog.has(key)) return;
    seenLog.add(key);
    const row = document.createElement('div');
    row.className = `log-row ${ev.type}`;
    row.innerHTML = `<span class="t">${fmtClock(ev.t)}</span><span class="m">${esc(ev.text)}</span>`;
    const log = $('log');
    log.prepend(row);
    while (log.children.length > 80) log.lastChild.remove();
  }

  // ------------------------------------------------------------ tools
  const hints = {
    incident: 'Click anywhere on the map to report an incident',
    route: 'Route planner: click a start point',
    block: 'Click a road to close or reopen it',
  };
  function setMode(m) {
    mode = m;
    document.querySelectorAll('#modeSwitch button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
    document.querySelectorAll('.tool-body').forEach((el) => el.classList.toggle('hidden', el.dataset.for !== m));
    $('mapHint').textContent = hints[m];
    map.getContainer().classList.remove('mode-incident', 'mode-route', 'mode-block');
    map.getContainer().classList.add(`mode-${m}`);
    routeStart = null;
  }
  $('modeSwitch').addEventListener('click', (e) => { if (e.target.dataset.mode) setMode(e.target.dataset.mode); });
  $('severityChips').addEventListener('click', (e) => {
    const sev = e.target.dataset.sev;
    if (!sev) return;
    severity = +sev;
    document.querySelectorAll('#severityChips .chip').forEach((c) => c.classList.toggle('active', c.dataset.sev === sev));
  });

  let routeStart = null;
  let lastRoute = null;
  let animToken = 0;

  map.on('click', async (e) => {
    const { lat, lng } = e.latlng;
    try {
      if (mode === 'incident') {
        await api('/api/incidents', { method: 'POST', body: { lat, lng, severity } });
      } else if (mode === 'block') {
        await api('/api/roads/toggle', { method: 'POST', body: { lat, lng } });
      } else if (mode === 'route') {
        if (!routeStart) {
          clearRoute();
          routeStart = { lat, lng };
          L.marker([lat, lng], { icon: pinIcon('#0f172a') }).addTo(layers.search);
          $('mapHint').textContent = 'Route planner: now click a destination';
        } else {
          const from = routeStart;
          routeStart = null;
          $('mapHint').textContent = 'Running Dijkstra and A*…';
          lastRoute = await api('/api/route', { method: 'POST', body: { from, to: { lat, lng } } });
          $('replayBtn').disabled = false;
          renderRouteCompare(lastRoute);
          animateSearch(lastRoute);
          $('mapHint').textContent = hints.route;
        }
      }
    } catch (err) {
      $('mapHint').textContent = err.message;
      setTimeout(() => { $('mapHint').textContent = hints[mode]; }, 2500);
    }
  });

  const pinIcon = (color) => L.divIcon({ className: '', html: `<div class="pin" style="background:${color}"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] });

  function clearRoute() { animToken++; layers.search.clearLayers(); }
  $('clearRouteBtn').addEventListener('click', () => {
    clearRoute(); lastRoute = null; routeStart = null; $('replayBtn').disabled = true;
    $('routeCompare').className = 'empty';
    $('routeCompare').textContent = 'Use the route planner to compare algorithms.';
    $('routeCache').textContent = '';
  });
  $('replayBtn').addEventListener('click', () => lastRoute && animateSearch(lastRoute));
  $('clearBlocksBtn').addEventListener('click', () => api('/api/roads/blocks', { method: 'DELETE' }));

  /** Animate the order in which each algorithm settled nodes, then draw the shortest paths. */
  function animateSearch(r) {
    clearRoute();
    const token = animToken;
    L.marker(r.from, { icon: pinIcon('#0f172a') }).addTo(layers.search);
    L.marker(r.to, { icon: pinIcon('#dc2626') }).addTo(layers.search);
    const runs = [
      { pts: r.dijkstra.explored, color: '#0ea5e9', i: 0 },
      { pts: r.astar.explored, color: '#7c3aed', i: 0 },
    ];
    const frames = 90;
    const step = () => {
      if (token !== animToken) return;
      let done = true;
      for (const run of runs) {
        const per = Math.max(1, Math.ceil(run.pts.length / frames));
        const end = Math.min(run.pts.length, run.i + per);
        for (; run.i < end; run.i++) {
          L.circleMarker(run.pts[run.i], {
            renderer: canvas, radius: 2.6, stroke: false, fillColor: run.color, fillOpacity: 0.45, interactive: false,
          }).addTo(layers.search);
        }
        if (run.i < run.pts.length) done = false;
      }
      if (!done) requestAnimationFrame(step);
      else {
        if (r.dijkstra.found) L.polyline(r.dijkstra.path, { color: '#0ea5e9', weight: 8, opacity: 0.5 }).addTo(layers.search);
        if (r.astar.found) L.polyline(r.astar.path, { color: '#7c3aed', weight: 3.5, opacity: 0.95, dashArray: '2 7', lineCap: 'round' }).addTo(layers.search);
      }
    };
    requestAnimationFrame(step);
  }

  function renderRouteCompare(r) {
    const d = r.dijkstra, a = r.astar;
    $('routeCache').textContent = r.cached ? 'served from LRU cache' : `cache ${r.cache.hits} hits / ${r.cache.misses} misses`;
    if (!d.found) {
      $('routeCompare').className = '';
      $('routeCompare').innerHTML = '<div class="callout warn">No route: the destination is cut off by road closures or one-way streets.</div>';
      return;
    }
    const max = Math.max(d.settled, a.settled);
    const row = (x, name, color) => `
      <div class="algo">
        <div class="algo-head"><span class="algo-name"><i style="background:${color}"></i>${name}</span><span><b>${x.settled.toLocaleString()}</b> <span class="muted small">nodes</span></span></div>
        <div class="bar"><div style="width:${(100 * x.settled) / max}%;background:${color}"></div></div>
        <div class="algo-meta"><span>${fmtMin(x.seconds)} · ${fmtKm(x.meters)}</span><span>${x.ms.toFixed(2)} ms</span></div>
      </div>`;
    const saving = 100 * (1 - a.settled / d.settled);
    $('routeCompare').className = '';
    $('routeCompare').innerHTML = row(d, 'Dijkstra', '#0ea5e9') + row(a, 'A* (haversine heuristic)', '#7c3aed') +
      `<div class="callout">A* found the same optimal route (${fmtMin(a.seconds)}) and explored <b>${saving.toFixed(0)}% fewer</b> intersections, because its heuristic never overestimates the remaining travel time.</div>`;
  }

  // incident/fleet list -> fly to
  for (const id of ['incidentList', 'fleetList']) {
    $(id).addEventListener('click', (e) => {
      const it = e.target.closest('.item');
      if (it) map.flyTo([+it.dataset.lat, +it.dataset.lng], Math.max(map.getZoom(), 16), { duration: 0.6 });
    });
  }

  // ------------------------------------------------------------ toggles
  $('autoToggle').addEventListener('change', (e) => api('/api/auto', { method: 'POST', body: { auto: e.target.checked } }));
  $('rushToggle').addEventListener('change', (e) => api('/api/traffic', { method: 'POST', body: { rushHour: e.target.checked } }));
  $('coverageToggle').addEventListener('change', async (e) => {
    const on = e.target.checked;
    $('coverageLegend').classList.toggle('hidden', !on);
    if (!on) { map.removeLayer(layers.coverage); $('coverageStats').innerHTML = ''; return; }
    const c = await api('/api/coverage?threshold=8');
    layers.coverage.clearLayers();
    for (const [lat, lng, t] of c.points) {
      const min = t / 60;
      const k = t < 0 ? 4 : min < 3 ? 0 : min < 5 ? 1 : min < 8 ? 2 : min < 12 ? 3 : 4;
      L.circleMarker([lat, lng], { renderer: canvas, radius: 3.2, stroke: false, fillColor: COVER_COLORS[k], fillOpacity: 0.7, interactive: false }).addTo(layers.coverage);
    }
    layers.coverage.addTo(map);
    const total = c.bins.reduce((x, y) => x + y, 0);
    $('coverageStats').innerHTML = `
      <div class="cov-bar">${c.bins.map((b, k) => `<div style="width:${(100 * b) / total}%;background:${COVER_COLORS[k]}"></div>`).join('')}</div>
      <dl class="kv" style="margin-top:8px">
        <dt>Avg time to hospital</dt><dd>${fmtMin(c.avgSeconds)}</dd>
        <dt>Worst-case location</dt><dd>${fmtMin(c.worstSeconds)}</dd>
        <dt>Beyond 8-min target</dt><dd style="color:${c.underservedPct > 10 ? '#dc2626' : 'inherit'}">${c.underservedPct.toFixed(1)}%</dd>
        <dt>Computed in</dt><dd>${c.ms} ms</dd>
      </dl>
      <p class="help" style="margin-top:0">This uses one multi-source Dijkstra from every hospital, O((V+E) log V). All-pairs Floyd–Warshall would be O(V³) on ${total.toLocaleString()} nodes.</p>`;
  });

  setMode('incident');
  boot().catch((err) => { $('mapHint').textContent = `Failed to load: ${err.message}`; });
})();
