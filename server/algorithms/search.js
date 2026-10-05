'use strict';

const IndexedMinHeap = require('../ds/IndexedMinHeap');

/**
 * Best-first search over the road graph. One implementation, three uses:
 *  - Dijkstra:        heuristic = null
 *  - A*:              heuristic = admissible straight-line time to the goal
 *  - Multi-source:    several sources at distance 0 (hospital coverage)
 *  - Reverse search:  walk incoming edges, i.e. "who can reach X fastest?"
 *
 * Stops as soon as the first target is settled (early termination), which is
 * what makes dispatch queries fast on a city-sized graph.
 *
 * @returns {{dist, prev, prevEdge, reached, settled, explored}}
 */
function search(graph, {
  sources, targets = null, heuristic = null, reverse = false, recordExplored = false, maxCost = Infinity,
}) {
  const n = graph.n;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const prevEdge = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const pq = new IndexedMinHeap(n);
  const targetSet = targets ? new Set(targets) : null;
  const explored = recordExplored ? [] : null;
  const adj = reverse ? graph.in : graph.out;
  const other = reverse ? graph.from : graph.to;
  const h = heuristic || (() => 0);

  for (const s of sources) {
    dist[s] = 0;
    pq.pushOrDecrease(s, h(s));
  }

  let reached = -1;
  let settled = 0;
  while (!pq.isEmpty()) {
    const u = pq.pop();
    closed[u] = 1;
    settled++;
    if (explored) explored.push(u);
    if (dist[u] > maxCost) break;
    if (targetSet && targetSet.has(u)) { reached = u; break; }

    for (const e of adj[u]) {
      const w = graph.cost(e);
      if (w === Infinity) continue; // closed road
      const v = other[e];
      if (closed[v]) continue;
      const nd = dist[u] + w;
      if (nd < dist[v]) {
        dist[v] = nd;
        prev[v] = u;
        prevEdge[v] = e;
        pq.pushOrDecrease(v, nd + h(v));
      }
    }
  }
  return { dist, prev, prevEdge, reached, settled, explored };
}

/** Walk predecessor links back from `node`. For a forward search the result is reversed into source->node order. */
function tracePath(prev, node, reverse = false) {
  const path = [];
  for (let v = node; v !== -1; v = prev[v]) path.push(v);
  if (!reverse) path.reverse();
  return path;
}

function dijkstra(graph, source, target, opts = {}) {
  const t0 = process.hrtime.bigint();
  const r = search(graph, { sources: [source], targets: [target], ...opts });
  return finish(graph, r, target, t0, 'dijkstra');
}

function astar(graph, source, target, opts = {}) {
  const t0 = process.hrtime.bigint();
  const r = search(graph, {
    sources: [source], targets: [target], heuristic: (v) => graph.heuristic(v, target), ...opts,
  });
  return finish(graph, r, target, t0, 'astar');
}

function finish(graph, r, target, t0, algo) {
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const found = r.reached === target;
  const path = found ? tracePath(r.prev, target) : [];
  const edges = path.slice(1).map((v) => r.prevEdge[v]);
  let meters = 0;
  for (const e of edges) meters += graph.length[e];
  return {
    algo, found, path, edges, seconds: found ? r.dist[target] : Infinity, meters,
    settled: r.settled, ms, explored: r.explored,
  };
}

module.exports = { search, tracePath, dijkstra, astar };
