'use strict';

/**
 * Binary min-heap keyed by integer ids (graph node indices) with O(log n)
 * decrease-key. A position index lets Dijkstra/A* update a node's priority in
 * place instead of pushing duplicates (the "lazy deletion" approach).
 */
class IndexedMinHeap {
  constructor(capacity) {
    this.heap = [];                         // heap of ids
    this.pos = new Int32Array(capacity).fill(-1); // id -> index in heap
    this.key = new Float64Array(capacity);  // id -> priority
  }

  get size() { return this.heap.length; }
  isEmpty() { return this.heap.length === 0; }
  has(id) { return this.pos[id] !== -1; }

  /** Insert id, or lower its key if it is already queued with a larger one. */
  pushOrDecrease(id, key) {
    if (this.pos[id] === -1) {
      this.key[id] = key;
      this.pos[id] = this.heap.length;
      this.heap.push(id);
      this._up(this.heap.length - 1);
    } else if (key < this.key[id]) {
      this.key[id] = key;
      this._up(this.pos[id]);
    }
  }

  peekKey() { return this.heap.length ? this.key[this.heap[0]] : Infinity; }

  pop() {
    const h = this.heap;
    const top = h[0];
    const last = h.pop();
    this.pos[top] = -1;
    if (h.length) {
      h[0] = last;
      this.pos[last] = 0;
      this._down(0);
    }
    return top;
  }

  _up(i) {
    const h = this.heap, k = this.key, p = this.pos;
    const id = h[i];
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (k[h[parent]] <= k[id]) break;
      h[i] = h[parent]; p[h[i]] = i;
      i = parent;
    }
    h[i] = id; p[id] = i;
  }

  _down(i) {
    const h = this.heap, k = this.key, p = this.pos, n = h.length;
    const id = h[i];
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && k[h[c + 1]] < k[h[c]]) c++;
      if (k[h[c]] >= k[id]) break;
      h[i] = h[c]; p[h[i]] = i;
      i = c;
    }
    h[i] = id; p[id] = i;
  }
}

module.exports = IndexedMinHeap;
