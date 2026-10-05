'use strict';

/**
 * 2-d tree over graph nodes for nearest-neighbour snapping (map click -> road
 * node) and radius queries (traffic hotspots). Coordinates are projected
 * equirectangularly so Euclidean distance approximates ground distance at
 * city scale.
 */
class KDTree {
  constructor(lat, lng, ids = null) {
    const n = lat.length;
    this.refLat = 0;
    for (let i = 0; i < n; i++) this.refLat += lat[i];
    this.refLat = n ? this.refLat / n : 0;
    this.cos = Math.cos((this.refLat * Math.PI) / 180);
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    for (let i = 0; i < n; i++) { this.x[i] = lng[i] * this.cos; this.y[i] = lat[i]; }

    const idx = ids ? Int32Array.from(ids) : Int32Array.from({ length: n }, (_, i) => i);
    // Implicit tree: node array is the index array arranged so the median of
    // each subrange is its root, alternating split axis by depth.
    this.idx = idx;
    this._build(0, idx.length - 1, 0);
  }

  _coord(id, axis) { return axis === 0 ? this.x[id] : this.y[id]; }

  _build(lo, hi, depth) {
    if (lo >= hi) return;
    const mid = (lo + hi) >> 1;
    this._select(lo, hi, mid, depth & 1);
    this._build(lo, mid - 1, depth + 1);
    this._build(mid + 1, hi, depth + 1);
  }

  /** Quickselect so idx[k] holds the median on `axis` for [lo, hi]. O(n) avg. */
  _select(lo, hi, k, axis) {
    const a = this.idx;
    while (hi > lo) {
      const pivot = this._coord(a[(lo + hi) >> 1], axis);
      let i = lo, j = hi;
      while (i <= j) {
        while (this._coord(a[i], axis) < pivot) i++;
        while (this._coord(a[j], axis) > pivot) j--;
        if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
      }
      if (k <= j) hi = j; else if (k >= i) lo = i; else return;
    }
  }

  /** Nearest node id to (lat, lng). O(log n) expected. */
  nearest(lat, lng) {
    const qx = lng * this.cos, qy = lat;
    let best = -1, bestD = Infinity;
    const visit = (lo, hi, depth) => {
      if (lo > hi) return;
      const mid = (lo + hi) >> 1;
      const id = this.idx[mid];
      const dx = this.x[id] - qx, dy = this.y[id] - qy;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = id; }
      const axis = depth & 1;
      const diff = (axis === 0 ? qx : qy) - this._coord(id, axis);
      const [nearLo, nearHi, farLo, farHi] = diff < 0
        ? [lo, mid - 1, mid + 1, hi]
        : [mid + 1, hi, lo, mid - 1];
      visit(nearLo, nearHi, depth + 1);
      if (diff * diff < bestD) visit(farLo, farHi, depth + 1); // prune
    };
    visit(0, this.idx.length - 1, 0);
    return best;
  }

  /** All node ids within `meters` of (lat, lng). */
  withinRadius(lat, lng, meters) {
    const r = meters / 111320; // degrees of latitude
    const r2 = r * r;
    const qx = lng * this.cos, qy = lat;
    const out = [];
    const visit = (lo, hi, depth) => {
      if (lo > hi) return;
      const mid = (lo + hi) >> 1;
      const id = this.idx[mid];
      const dx = this.x[id] - qx, dy = this.y[id] - qy;
      if (dx * dx + dy * dy <= r2) out.push(id);
      const axis = depth & 1;
      const diff = (axis === 0 ? qx : qy) - this._coord(id, axis);
      if (diff <= r) visit(lo, mid - 1, depth + 1);
      if (diff >= -r) visit(mid + 1, hi, depth + 1);
    };
    visit(0, this.idx.length - 1, 0);
    return out;
  }
}

module.exports = KDTree;
