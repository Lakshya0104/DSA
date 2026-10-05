'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Graph = require('../server/graph/Graph');
const { buildSynthetic } = require('../server/graph/loader');
const { dijkstra, astar, search } = require('../server/algorithms/search');
const { hospitalCoverage } = require('../server/algorithms/coverage');
const { Simulation } = require('../server/sim/Simulation');
const cfg = require('../server/config');

const makeGraph = () => new Graph(buildSynthetic(cfg.CITIES.bengaluru));

/** Reference Bellman-Ford to validate optimality. */
function bellmanFord(g, s) {
  const d = new Float64Array(g.n).fill(Infinity);
  d[s] = 0;
  for (let it = 0; it < g.n; it++) {
    let changed = false;
    for (let e = 0; e < g.m; e++) {
      const nd = d[g.from[e]] + g.cost(e);
      if (nd < d[g.to[e]]) { d[g.to[e]] = nd; changed = true; }
    }
    if (!changed) break;
  }
  return d;
}

test('Dijkstra and A* both return the optimal travel time', () => {
  const g = makeGraph();
  const ref = bellmanFord(g, 0);
  for (const t of [5, 300, 1200, 2000, g.n - 1]) {
    const d = dijkstra(g, 0, t), a = astar(g, 0, t);
    assert.ok(Math.abs(d.seconds - ref[t]) < 1e-6);
    assert.ok(Math.abs(a.seconds - ref[t]) < 1e-6);
    assert.ok(a.settled <= d.settled, 'A* should never settle more nodes');
    let sum = 0;
    for (const e of a.edges) sum += g.cost(e);
    assert.ok(Math.abs(sum - a.seconds) < 1e-6, 'path edges add up to cost');
  }
});

test('closed roads are avoided and can disconnect the graph', () => {
  const g = makeGraph();
  const target = 3;
  const before = dijkstra(g, 0, target).seconds;
  const e = g.out[1].find((x) => g.to[x] === 2);
  g.blocked[e] = 1; g.blocked[g.twin(e)] = 1;
  assert.ok(dijkstra(g, 0, target).seconds >= before);
  for (const x of g.in[target]) g.blocked[x] = 1;
  for (const x of g.out[target]) g.blocked[x] = 1;
  assert.strictEqual(dijkstra(g, 0, target).found, false);
  assert.ok(g.connectivity().components > 1);
});

test('reverse multi-target search finds the ambulance with the least road time', () => {
  const g = makeGraph();
  const incident = 1000;
  const units = [10, 500, 1500, 2100];
  const res = search(g, { sources: [incident], targets: units, reverse: true });
  const times = units.map((u) => dijkstra(g, u, incident).seconds);
  const best = units[times.indexOf(Math.min(...times))];
  assert.strictEqual(res.reached, best);
  assert.ok(Math.abs(res.dist[best] - Math.min(...times)) < 1e-6);
});

test('coverage assigns a finite time to every node', () => {
  const g = makeGraph();
  const c = hospitalCoverage(g);
  assert.strictEqual(c.points.length, g.n);
  assert.ok(c.points.every((p) => p[2] >= 0));
  assert.strictEqual(c.perHospital.reduce((s, h) => s + h.nodes, 0), g.n);
});

test('simulation dispatches, transports and resolves incidents', () => {
  const g = makeGraph();
  const sim = new Simulation(g, { ...cfg, FLEET_SIZE: 3 });
  sim.auto = false;
  const incs = [3, 2, 1, 1].map((sev, k) => sim.reportIncident({ lat: g.lat[k * 400 + 50], lng: g.lng[k * 400 + 50], severity: sev }));
  // 3 units, 4 calls: the minor call (reported first) must be the one waiting.
  assert.deepStrictEqual(incs.map((i) => i.status), ['dispatched', 'dispatched', 'dispatched', 'queued']);
  for (let i = 0; i < 2000; i++) sim.tick(3);
  assert.ok(incs.every((i) => i.status === 'resolved'), incs.map((i) => i.status).join());
  assert.strictEqual(sim.snapshot().stats.resolved, 4);
});

test('closing a road on an active route triggers a reroute', () => {
  const g = makeGraph();
  const sim = new Simulation(g, { ...cfg, FLEET_SIZE: 1 });
  sim.auto = false;
  sim.reportIncident({ lat: g.lat[g.n - 1], lng: g.lng[g.n - 1], severity: 1 });
  const amb = sim.ambulances[0];
  const e = amb.route.edges[Math.floor(amb.route.edges.length / 2)];
  const mid = g.edgeCoords(e);
  sim.toggleRoad((mid[0][0] + mid[1][0]) / 2, (mid[0][1] + mid[1][1]) / 2);
  assert.strictEqual(sim.stats.reroutes, 1);
  assert.ok(!amb.route.edges.slice(1).some((x) => g.blocked[x]));
});
