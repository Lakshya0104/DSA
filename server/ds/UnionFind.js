'use strict';

/** Disjoint-set union with path halving + union by size. ~O(α(n)) per op. */
class UnionFind {
  constructor(n) {
    this.parent = Int32Array.from({ length: n }, (_, i) => i);
    this.size = new Int32Array(n).fill(1);
    this.components = n;
  }

  find(x) {
    const p = this.parent;
    while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; }
    return x;
  }

  union(a, b) {
    let ra = this.find(a), rb = this.find(b);
    if (ra === rb) return false;
    if (this.size[ra] < this.size[rb]) [ra, rb] = [rb, ra];
    this.parent[rb] = ra;
    this.size[ra] += this.size[rb];
    this.components--;
    return true;
  }

  /** Root of the largest set. */
  largestRoot() {
    let best = 0, bestSize = -1;
    for (let i = 0; i < this.parent.length; i++) {
      if (this.parent[i] === i && this.size[i] > bestSize) { bestSize = this.size[i]; best = i; }
    }
    return best;
  }
}

module.exports = UnionFind;
