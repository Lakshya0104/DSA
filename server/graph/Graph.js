'use strict';

const KDTree = require('../ds/KDTree');
const UnionFind = require('../ds/UnionFind');
const { haversine, pointToSegment } = require('./geo');

/**
 * Directed, weighted road graph stored as adjacency lists of edge ids
 * (forward and reverse). Edge cost = travel time in seconds:
 *   length / speed * trafficFactor, or Infinity if the road is closed.
 */
class Graph {
  constructor({ lat, lng, edges, hospitals, meta }) {
    this.lat = Float64Array.from(lat);
    this.lng = Float64Array.from(lng);
    this.n = this.lat.length;
    this.meta = meta;

    const m = edges.length;
    this.from = new Int32Array(m);
    this.to = new Int32Array(m);
    this.length = new Float64Array(m);   // metres
    this.speed = new Float64Array(m);    // m/s
    this.traffic = new Float64Array(m).fill(1);
    this.blocked = new Uint8Array(m);
    this.roadClass = new Array(m);
    this.name = new Array(m);
    this.out = Array.from({ length: this.n }, () => []);
    this.in = Array.from({ length: this.n }, () => []);
    this.maxSpeed = 0;

    edges.forEach((e, i) => {
      this.from[i] = e.from; this.to[i] = e.to;
      this.length[i] = e.length ?? haversine(lat[e.from], lng[e.from], lat[e.to], lng[e.to]);
      this.speed[i] = e.speed;
      this.roadClass[i] = e.roadClass || 'road';
      this.name[i] = e.name || '';
      this.out[e.from].push(i);
      this.in[e.to].push(i);
      if (e.speed > this.maxSpeed) this.maxSpeed = e.speed;
    });
    this.m = m;
    this.version = 0; // bumped on any cost change -> invalidates route cache

    this.kd = new KDTree(this.lat, this.lng);
    this.hospitals = hospitals.map((h, i) => ({
      id: `H${i + 1}`, name: h.name, node: this.nearestNode(h.lat, h.lng),
      lat: h.lat, lng: h.lng,
    }));
  }

  cost(e) {
    return this.blocked[e] ? Infinity : (this.length[e] / this.speed[e]) * this.traffic[e];
  }

  nearestNode(lat, lng) { return this.kd.nearest(lat, lng); }

  /** Straight-line lower bound on travel time (admissible A* heuristic). */
  heuristic(a, b) {
    return haversine(this.lat[a], this.lng[a], this.lat[b], this.lng[b]) / this.maxSpeed;
  }

  /** Closest road segment to a point: KD-tree for candidate nodes, then exact check. */
  nearestEdge(lat, lng) {
    const candidates = this.kd.withinRadius(lat, lng, 120);
    if (!candidates.length) candidates.push(this.nearestNode(lat, lng));
    let best = -1, bestD = Infinity;
    for (const v of candidates) {
      for (const e of this.out[v]) {
        const d = pointToSegment(lat, lng, this.lat[this.from[e]], this.lng[this.from[e]],
          this.lat[this.to[e]], this.lng[this.to[e]]);
        if (d < bestD) { bestD = d; best = e; }
      }
    }
    return { edge: best, distance: bestD };
  }

  /** Edge u->v and its reverse twin v->u if the road is two-way. */
  twin(e) {
    for (const f of this.out[this.to[e]]) if (this.to[f] === this.from[e]) return f;
    return -1;
  }

  /**
   * Union-find over open roads (ignoring direction) to measure how fragmented
   * the network becomes as roads are closed.
   */
  connectivity() {
    const uf = new UnionFind(this.n);
    for (let e = 0; e < this.m; e++) if (!this.blocked[e]) uf.union(this.from[e], this.to[e]);
    const root = uf.largestRoot();
    const mainSize = uf.size[root];
    return { components: uf.components, isolatedNodes: this.n - mainSize, uf, root };
  }

  edgeCoords(e) {
    return [[this.lat[this.from[e]], this.lng[this.from[e]]], [this.lat[this.to[e]], this.lng[this.to[e]]]];
  }

  pathCoords(path) { return path.map((v) => [this.lat[v], this.lng[v]]); }
}

module.exports = Graph;
