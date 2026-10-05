'use strict';

const { EventEmitter } = require('events');
const PriorityQueue = require('../ds/PriorityQueue');
const LRUCache = require('../ds/LRUCache');
const { search, tracePath, dijkstra, astar } = require('../algorithms/search');
const { haversine } = require('../graph/geo');

const SEVERITY = { 1: 'Critical', 2: 'Serious', 3: 'Minor' };
const INCIDENT_TYPES = {
  1: ['Cardiac arrest', 'Major road accident', 'Stroke', 'Building fire injuries'],
  2: ['Two-wheeler collision', 'Breathing difficulty', 'Fall from height', 'Burn injury'],
  3: ['Minor injury', 'Fainting', 'Fever / dehydration', 'Sprain'],
};

/** First index i with arr[i] >= x (arr sorted ascending). */
function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

class Simulation extends EventEmitter {
  constructor(graph, cfg) {
    super();
    this.g = graph;
    this.cfg = cfg;
    this.simTime = 0;
    this.auto = true;
    this.rushHour = false;
    this.nextIncidentAt = 20;
    this.incidentSeq = 0;
    this.incidents = new Map();
    // Triage queue: lower severity number = more urgent; ties -> reported first.
    this.queue = new PriorityQueue((a, b) => a.severity - b.severity || a.reportedAt - b.reportedAt);
    this.routeCache = new LRUCache(200);
    this.events = [];
    this.stats = {
      dispatched: 0, resolved: 0, responseTimes: [], reroutes: 0,
      lastDispatch: null, stranded: 0,
      closed: [],                 // finished calls, for analytics
      hospitalLoad: new Map(),    // hospital -> patients received
      wardCalls: new Map(),       // ward -> calls
      reported: [],               // [simTime, severity] of every call
      responseBySev: [],          // [severity, seconds]
    };
    this.ambulances = Array.from({ length: cfg.FLEET_SIZE }, (_, i) => {
      const h = graph.hospitals[i % graph.hospitals.length];
      return {
        id: `AMB-${String(i + 1).padStart(2, '0')}`,
        node: h.node, base: h.id, baseName: h.name, status: 'idle', route: null, incidentId: null, timerUntil: 0, trips: 0,
        busy: 0, meters: 0,
      };
    });
    this.connectivity = graph.connectivity();
    this.seed = 12345;
  }

  rand() { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647; }

  log(type, text) {
    const ev = { t: this.simTime, type, text };
    this.events.push(ev);
    if (this.events.length > 80) this.events.shift();
    this.emit('event', ev);
  }

  // ---------------------------------------------------------------- routes

  /**
   * Freeze a node path into a timed route: cumulative travel seconds per
   * vertex so position lookups are a binary search over `cum`.
   */
  _makeRoute(path, edges) {
    const cum = new Float64Array(path.length);
    for (let i = 0; i < edges.length; i++) cum[i + 1] = cum[i] + this.g.cost(edges[i]);
    let meters = 0;
    for (const e of edges) meters += this.g.length[e];
    return { path, edges, cum, meters, start: this.simTime, total: cum[cum.length - 1] };
  }

  _fromForward(res, target) {
    const path = tracePath(res.prev, target);
    return this._makeRoute(path, path.slice(1).map((v) => res.prevEdge[v]));
  }

  _fromReverse(res, origin) {
    // Reverse search grows from the destination, so following prev from the
    // origin already walks forward toward the destination.
    const path = tracePath(res.prev, origin, true);
    return this._makeRoute(path, path.slice(0, -1).map((v) => res.prevEdge[v]));
  }

  /** Where an ambulance is along its route right now. */
  _progress(amb) {
    const r = amb.route;
    const elapsed = Math.min(this.simTime - r.start, r.total);
    let i = lowerBound(r.cum, elapsed);
    if (i === 0) return { seg: 0, frac: 0, elapsed };
    const segLen = r.cum[i] - r.cum[i - 1];
    return { seg: i - 1, frac: segLen ? (elapsed - r.cum[i - 1]) / segLen : 1, elapsed };
  }

  _position(amb) {
    if (!amb.route) return [this.g.lat[amb.node], this.g.lng[amb.node]];
    const { seg, frac } = this._progress(amb);
    const p = amb.route.path;
    const a = p[seg], b = p[Math.min(seg + 1, p.length - 1)];
    return [
      this.g.lat[a] + (this.g.lat[b] - this.g.lat[a]) * frac,
      this.g.lng[a] + (this.g.lng[b] - this.g.lng[a]) * frac,
    ];
  }

  /**
   * Recompute an ambulance's route from the end of the segment it is on
   * (it can't U-turn mid-block), keeping the current segment so its marker
   * doesn't jump.
   */
  _reroute(amb, reason) {
    const r = amb.route;
    const { seg, elapsed } = this._progress(amb);
    if (seg >= r.path.length - 1) return false;
    const segStart = r.path[seg], ahead = r.path[seg + 1], goal = r.path[r.path.length - 1];
    const res = astar(this.g, ahead, goal);
    if (!res.found) {
      this.log('warn', `${amb.id}: no open route to destination — holding position`);
      return false;
    }
    const segCost = r.cum[seg + 1] - r.cum[seg];
    const newRemaining = segCost + res.seconds;
    const oldRemaining = r.total - r.cum[seg];
    if (reason === 'traffic' && newRemaining > oldRemaining * 0.95 && !this._routeBlocked(amb)) return false;

    const path = [segStart, ...res.path];
    const edges = [r.edges[seg], ...res.edges];
    const route = this._makeRoute(path, edges);
    route.start = this.simTime - (elapsed - r.cum[seg]);
    amb.route = route;
    this.stats.reroutes++;
    const delta = (newRemaining - oldRemaining) / 60;
    this.log('reroute', `${amb.id} rerouted (${reason}) · A* explored ${res.settled.toLocaleString()} nodes · ETA ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} min`);
    return true;
  }

  _routeBlocked(amb) {
    const r = amb.route;
    const { seg } = this._progress(amb);
    for (let i = seg + 1; i < r.edges.length; i++) if (this.g.blocked[r.edges[i]]) return true;
    return false;
  }

  // ---------------------------------------------------------------- incidents

  reportIncident({ lat, lng, severity, type }) {
    severity = [1, 2, 3].includes(+severity) ? +severity : 2;
    const node = this.g.nearestNode(lat, lng);
    const id = `INC-${String(++this.incidentSeq).padStart(4, '0')}`;
    const pool = INCIDENT_TYPES[severity];
    const inc = {
      id, node, lat: this.g.lat[node], lng: this.g.lng[node], severity,
      type: type || pool[Math.floor(this.rand() * pool.length)],
      status: 'queued', reportedAt: this.simTime, ambulance: null, hospital: null,
      arrivedAt: null, resolvedAt: null, street: this.g.nearestLandmark(node) || this._streetName(node),
      ward: this.g.wardName(node),
    };
    this.stats.reported.push([this.simTime, severity]);
    if (inc.ward) this.stats.wardCalls.set(inc.ward, (this.stats.wardCalls.get(inc.ward) || 0) + 1);
    this.incidents.set(id, inc);
    this.queue.push(inc);
    this.log('incident', `${id} ${SEVERITY[severity]}: ${inc.type}${inc.street ? ' near ' + inc.street : ''}`);
    this._dispatchPending();
    return inc;
  }

  _streetName(node) {
    for (const e of this.g.out[node]) if (this.g.name[e]) return this.g.name[e];
    for (const e of this.g.in[node]) if (this.g.name[e]) return this.g.name[e];
    return '';
  }

  /**
   * Pop incidents in triage order and send the ambulance with the shortest
   * *road* travel time. One reverse Dijkstra from the incident with all idle
   * ambulances as targets stops at the first one settled — O(explored log n)
   * instead of running k separate searches.
   */
  _dispatchPending() {
    while (!this.queue.isEmpty()) {
      const idle = this.ambulances.filter((a) => a.status === 'idle');
      if (!idle.length) return;
      const inc = this.queue.pop();
      if (inc.status !== 'queued') continue;

      const t0 = process.hrtime.bigint();
      const res = search(this.g, { sources: [inc.node], targets: idle.map((a) => a.node), reverse: true });
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (res.reached === -1) {
        inc.status = 'stranded';
        this.stats.stranded++;
        this.log('warn', `${inc.id} is cut off by road closures — no ambulance can reach it`);
        continue;
      }
      const amb = idle.find((a) => a.node === res.reached);

      // Compare with the naive "closest as the crow flies" choice.
      let crow = null, crowD = Infinity;
      for (const a of idle) {
        const d = haversine(this.g.lat[a.node], this.g.lng[a.node], inc.lat, inc.lng);
        if (d < crowD) { crowD = d; crow = a; }
      }

      amb.route = this._fromReverse(res, amb.node);
      amb.status = 'to_scene';
      amb.incidentId = inc.id;
      amb.trips++;
      inc.status = 'dispatched';
      inc.ambulance = amb.id;
      inc.dispatchedAt = this.simTime;
      inc.etaAt = this.simTime + amb.route.total;
      this.stats.dispatched++;
      this.stats.lastDispatch = {
        incident: inc.id, ambulance: amb.id, settled: res.settled, totalNodes: this.g.n, ms,
        etaSeconds: amb.route.total, candidates: idle.length,
        crowFlies: crow.id, crowDiffers: crow.id !== amb.id,
      };
      this.log('dispatch', `${amb.id} → ${inc.id} · ETA ${(amb.route.total / 60).toFixed(1)} min · reverse Dijkstra settled ${res.settled.toLocaleString()} / ${this.g.n.toLocaleString()} nodes in ${ms.toFixed(1)} ms`);
      if (crow.id !== amb.id) this.log('info', `Straight-line nearest was ${crow.id}, but ${amb.id} is faster by road`);
    }
  }

  _sendToHospital(amb, inc) {
    // Forward multi-target search: first hospital settled is the closest by road.
    const res = search(this.g, { sources: [amb.node], targets: this.g.hospitals.map((h) => h.node) });
    if (res.reached === -1) { this.log('warn', `${amb.id}: no hospital reachable`); return; }
    const h = this.g.hospitals.find((x) => x.node === res.reached);
    amb.route = this._fromForward(res, res.reached);
    amb.status = 'transporting';
    inc.status = 'transporting';
    inc.hospital = h.name;
    this.log('transport', `${amb.id} transporting ${inc.id} to ${h.name} · ${(amb.route.total / 60).toFixed(1)} min`);
  }

  // ---------------------------------------------------------------- city controls

  toggleRoad(lat, lng) {
    const { edge, distance } = this.g.nearestEdge(lat, lng);
    if (edge < 0 || distance > 80) return null;
    const twin = this.g.twin(edge);
    const block = !this.g.blocked[edge];
    for (const e of [edge, twin]) if (e >= 0) this.g.blocked[e] = block ? 1 : 0;
    this._graphChanged();
    const name = this.g.name[edge] || 'Unnamed road';
    this.log(block ? 'block' : 'unblock', `${name} ${block ? 'closed' : 'reopened'}`);
    if (block) {
      for (const amb of this.ambulances) if (amb.route && this._routeBlocked(amb)) this._reroute(amb, 'road closed');
    }
    // A reopened road may reconnect a stranded incident.
    if (!block) this._requeueStranded();
    return { edge, blocked: block, name };
  }

  clearBlocks() {
    this.g.blocked.fill(0);
    this._graphChanged();
    this._requeueStranded();
    this.log('unblock', 'All road closures cleared');
  }

  _requeueStranded() {
    for (const inc of this.incidents.values()) {
      if (inc.status === 'stranded') { inc.status = 'queued'; this.queue.push(inc); }
    }
    this._dispatchPending();
  }

  /**
   * Simulated congestion: pick hotspots, then use a KD-tree radius query to
   * slow every major road within 700 m. Moving ambulances re-plan only if the
   * new A* route is clearly faster.
   */
  setRushHour(on) {
    this.rushHour = on;
    this.g.traffic.fill(1);
    if (on) {
      const major = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'trunk_link', 'primary_link', 'secondary_link']);
      this.hotspots = [];
      for (let k = 0; k < 4; k++) {
        const v = Math.floor(this.rand() * this.g.n);
        const lat = this.g.lat[v], lng = this.g.lng[v];
        this.hotspots.push({ lat, lng, radius: 700 });
        for (const u of this.g.kd.withinRadius(lat, lng, 700)) {
          for (const e of this.g.out[u]) {
            const f = major.has(this.g.roadClass[e]) ? 2.2 + this.rand() * 1.3 : 1.4;
            this.g.traffic[e] = Math.max(this.g.traffic[e], f);
          }
        }
      }
      // Background slowdown on arterials city-wide.
      for (let e = 0; e < this.g.m; e++) if (major.has(this.g.roadClass[e])) this.g.traffic[e] = Math.max(this.g.traffic[e], 1.25);
    } else {
      this.hotspots = [];
    }
    this._graphChanged();
    this.log('traffic', on ? 'Rush hour: congestion around 4 hotspots' : 'Traffic back to free-flow');
    for (const amb of this.ambulances) if (amb.route) this._reroute(amb, 'traffic');
  }

  _graphChanged() {
    this.g.version++;
    this.routeCache.clear();
    this.connectivity = this.g.connectivity();
  }

  /** Route planner: run Dijkstra and A* on the same query for comparison (cached in LRU). */
  compareRoutes(a, b) {
    const from = this.g.nearestNode(a.lat, a.lng), to = this.g.nearestNode(b.lat, b.lng);
    const key = `${from}:${to}:${this.g.version}`;
    const cached = this.routeCache.get(key);
    if (cached) return { ...cached, cached: true, cache: this._cacheStats() };
    const d = dijkstra(this.g, from, to, { recordExplored: true });
    const s = astar(this.g, from, to, { recordExplored: true });
    const pack = (r) => ({
      algo: r.algo, found: r.found, seconds: r.seconds, meters: r.meters, settled: r.settled,
      ms: r.ms, path: this.g.pathCoords(r.path), explored: sample(r.explored, 6000).map((v) => [this.g.lat[v], this.g.lng[v]]),
    });
    const result = { from: [this.g.lat[from], this.g.lng[from]], to: [this.g.lat[to], this.g.lng[to]], dijkstra: pack(d), astar: pack(s), totalNodes: this.g.n };
    this.routeCache.set(key, result);
    return { ...result, cached: false, cache: this._cacheStats() };
  }

  _cacheStats() { return { hits: this.routeCache.hits, misses: this.routeCache.misses, size: this.routeCache.size }; }

  // ---------------------------------------------------------------- clock

  tick(dt) {
    this.simTime += dt;

    if (this.auto && this.simTime >= this.nextIncidentAt) {
      const v = Math.floor(this.rand() * this.g.n);
      const r = this.rand();
      this.reportIncident({ lat: this.g.lat[v], lng: this.g.lng[v], severity: r < 0.25 ? 1 : r < 0.7 ? 2 : 3 });
      this.nextIncidentAt = this.simTime + 60 + this.rand() * 120; // ~ every 1–3 sim-minutes
    }

    for (const amb of this.ambulances) {
      const inc = amb.incidentId ? this.incidents.get(amb.incidentId) : null;
      if (amb.status !== 'idle') amb.busy += dt;
      if (amb.route && this.simTime - amb.route.start >= amb.route.total) {
        amb.meters += amb.route.meters;
        amb.node = amb.route.path[amb.route.path.length - 1];
        amb.route = null;
        if (amb.status === 'to_scene') {
          amb.status = 'on_scene';
          amb.timerUntil = this.simTime + this.cfg.ON_SCENE_SECONDS * (inc.severity === 1 ? 1.4 : 1);
          inc.status = 'on_scene';
          inc.arrivedAt = this.simTime;
          this.stats.responseTimes.push(inc.arrivedAt - inc.reportedAt);
          this.stats.responseBySev.push([inc.severity, inc.arrivedAt - inc.reportedAt]);
          this.log('arrive', `${amb.id} on scene at ${inc.id} · response ${((inc.arrivedAt - inc.reportedAt) / 60).toFixed(1)} min`);
        } else if (amb.status === 'transporting') {
          amb.status = 'handover';
          amb.timerUntil = this.simTime + this.cfg.HANDOVER_SECONDS;
          inc.status = 'resolved';
          inc.resolvedAt = this.simTime;
          this.stats.resolved++;
          this.stats.hospitalLoad.set(inc.hospital, (this.stats.hospitalLoad.get(inc.hospital) || 0) + 1);
          this._close(inc);
          this.log('resolve', `${inc.id} handed over at ${inc.hospital}`);
        }
      } else if (amb.status === 'on_scene' && this.simTime >= amb.timerUntil) {
        if (inc.severity === 3 && this.rand() < 0.5) {
          inc.status = 'resolved'; inc.resolvedAt = this.simTime; inc.hospital = 'Treated on scene';
          this.stats.resolved++;
          this._close(inc);
          amb.status = 'idle'; amb.incidentId = null;
          this.log('resolve', `${inc.id} treated on scene; ${amb.id} available`);
        } else {
          this._sendToHospital(amb, inc);
        }
      } else if (amb.status === 'handover' && this.simTime >= amb.timerUntil) {
        amb.status = 'idle';
        amb.incidentId = null;
        this.log('info', `${amb.id} available`);
      }
    }

    // Drop resolved incidents after a while.
    for (const [id, inc] of this.incidents) {
      if (inc.resolvedAt !== null && this.simTime - inc.resolvedAt > 300) this.incidents.delete(id);
    }
    this._dispatchPending();
  }

  _close(inc) {
    this.stats.closed.push({
      id: inc.id, severity: inc.severity, response: inc.arrivedAt - inc.reportedAt,
      total: inc.resolvedAt - inc.reportedAt, ward: inc.ward, hospital: inc.hospital,
    });
    if (this.stats.closed.length > 500) this.stats.closed.shift();
  }

  analytics() {
    const st = this.stats;
    const rt = st.responseTimes;
    const hist = new Array(8).fill(0); // 2-minute bins, last one = 14+
    for (const t of rt) hist[Math.min(7, Math.floor(t / 120))]++;
    const bySev = [1, 2, 3].map((sv) => {
      const c = st.responseBySev.filter((x) => x[0] === sv);
      return { severity: sv, calls: st.reported.filter((r) => r[1] === sv).length, avgResponse: c.length ? c.reduce((a, x) => a + x[1], 0) / c.length : null };
    });
    const bucket = 300; // 5 sim-minutes
    const nowB = Math.floor(this.simTime / bucket);
    const timeline = [];
    for (let b = Math.max(0, nowB - 11); b <= nowB; b++) {
      const row = { t: b * bucket, s1: 0, s2: 0, s3: 0 };
      for (const [t, sv] of st.reported) if (Math.floor(t / bucket) === b) row['s' + sv]++;
      timeline.push(row);
    }
    const sortMap = (m, k) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([name, value]) => ({ name, value }));
    return {
      histogram: hist,
      sla: rt.length ? rt.filter((t) => t <= 480).length / rt.length : null,
      bySeverity: bySev,
      timeline,
      hospitalLoad: sortMap(st.hospitalLoad, 8),
      wardCalls: sortMap(st.wardCalls, 8),
      totalCalls: st.reported.length,
    };
  }

  // ---------------------------------------------------------------- views

  snapshot() {
    const g = this.g;
    const round = (x) => Math.round(x * 1e5) / 1e5;
    const ambulances = this.ambulances.map((a) => {
      const [lat, lng] = this._position(a);
      let route = null, eta = null;
      if (a.route) {
        const { seg } = this._progress(a);
        route = [[round(lat), round(lng)], ...a.route.path.slice(seg + 1).map((v) => [round(g.lat[v]), round(g.lng[v])])];
        eta = a.route.total - (this.simTime - a.route.start);
      }
      return {
        id: a.id, lat, lng, status: a.status, incidentId: a.incidentId, route, eta, trips: a.trips, base: a.base,
        baseName: a.baseName, utilization: this.simTime ? a.busy / this.simTime : 0, km: a.meters / 1000,
        place: a.route ? '' : this.g.nearestLandmark(a.node),
      };
    });
    const incidents = [...this.incidents.values()].map((i) => ({
      id: i.id, lat: i.lat, lng: i.lng, severity: i.severity, type: i.type, status: i.status,
      ambulance: i.ambulance, hospital: i.hospital, reportedAt: i.reportedAt, arrivedAt: i.arrivedAt,
      etaAt: i.etaAt, street: i.street, ward: i.ward, dispatchedAt: i.dispatchedAt ?? null, resolvedAt: i.resolvedAt,
    }));
    const rt = this.stats.responseTimes;
    const sorted = [...rt].sort((a, b) => a - b);
    const blocked = [];
    for (let e = 0; e < g.m; e++) {
      if (g.blocked[e] && (g.twin(e) < 0 || e < g.twin(e))) blocked.push(g.edgeCoords(e));
    }
    return {
      simTime: this.simTime,
      auto: this.auto,
      rushHour: this.rushHour,
      hotspots: this.hotspots || [],
      ambulances,
      incidents,
      queue: this.queue.toSortedArray().filter((i) => i.status === 'queued').map((i) => i.id),
      blocked,
      analytics: this.analytics(),
      stats: {
        dispatched: this.stats.dispatched,
        resolved: this.stats.resolved,
        reroutes: this.stats.reroutes,
        stranded: this.stats.stranded,
        avgResponse: rt.length ? rt.reduce((s, x) => s + x, 0) / rt.length : null,
        p90Response: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] : null,
        responseHistory: rt.slice(-30),
        lastDispatch: this.stats.lastDispatch,
        cache: this._cacheStats(),
        components: this.connectivity.components,
        isolatedNodes: this.connectivity.isolatedNodes,
        closedRoads: blocked.length,
      },
    };
  }
}

function sample(arr, max) {
  if (!arr || arr.length <= max) return arr || [];
  const out = [];
  const step = arr.length / max;
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

module.exports = { Simulation, SEVERITY };
