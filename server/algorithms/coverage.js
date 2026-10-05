'use strict';

const { search } = require('./search');

/**
 * Hospital reachability: a single multi-source Dijkstra from every hospital
 * yields, for every intersection, the travel time to its nearest hospital in
 * O((V + E) log V). (All-pairs Floyd–Warshall would be O(V^3) — billions of
 * operations on a real city — and we only need the nearest-of-k answer.)
 *
 * Runs on the reverse graph so the time is "ambulance from location to
 * hospital", respecting one-way streets.
 */
function hospitalCoverage(graph, thresholdSeconds = 480) {
  const t0 = Date.now();
  const sources = graph.hospitals.map((h) => h.node);
  const { dist, prev } = search(graph, { sources, reverse: true });

  // Which hospital "owns" each node: follow predecessor pointers to a source
  // (memoised so the whole pass is O(V)).
  const owner = new Int32Array(graph.n).fill(-2);
  sources.forEach((s, i) => { owner[s] = i; });
  const resolve = (v) => {
    const stack = [];
    while (owner[v] === -2 && prev[v] !== -1) { stack.push(v); v = prev[v]; }
    const o = owner[v] === -2 ? -1 : owner[v];
    for (const s of stack) owner[s] = o;
    return o;
  };

  const points = [];
  const bins = [0, 0, 0, 0, 0]; // <3, 3-5, 5-8, 8-12, >12 min / unreachable
  const perHospital = graph.hospitals.map(() => 0);
  let sum = 0, reachable = 0, worst = 0;
  for (let v = 0; v < graph.n; v++) {
    const t = dist[v];
    const o = resolve(v);
    if (o >= 0) perHospital[o]++;
    if (t !== Infinity) { sum += t; reachable++; if (t > worst) worst = t; }
    const min = t / 60;
    bins[min < 3 ? 0 : min < 5 ? 1 : min < 8 ? 2 : min < 12 ? 3 : 4]++;
    points.push([+graph.lat[v].toFixed(5), +graph.lng[v].toFixed(5), t === Infinity ? -1 : Math.round(t)]);
  }
  // Ward choropleth: mean minutes to hospital over the ward's intersections.
  const wardSum = new Float64Array(graph.wards.length), wardCnt = new Int32Array(graph.wards.length);
  for (let v = 0; v < graph.n; v++) {
    const w = graph.wardOf[v];
    if (w >= 0 && dist[v] !== Infinity) { wardSum[w] += dist[v]; wardCnt[w]++; }
  }
  const wards = graph.wards.map((w, i) => ({ name: w.name, avgSeconds: wardCnt[i] ? wardSum[i] / wardCnt[i] : null }));
  const underserved = points.filter((p) => p[2] < 0 || p[2] > thresholdSeconds).length;
  return {
    points,
    bins,
    wards,
    avgSeconds: reachable ? sum / reachable : 0,
    worstSeconds: worst,
    underservedPct: (100 * underserved) / graph.n,
    thresholdSeconds,
    perHospital: graph.hospitals.map((h, i) => ({ id: h.id, name: h.name, nodes: perHospital[i] })),
    ms: Date.now() - t0,
  };
}

module.exports = { hospitalCoverage };
