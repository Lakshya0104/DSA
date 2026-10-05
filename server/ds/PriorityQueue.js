'use strict';

/**
 * Generic binary heap with a comparator. Used for the incident triage queue
 * (most severe first, then oldest first).
 */
class PriorityQueue {
  constructor(compare) {
    this.compare = compare; // (a, b) => negative if a should come out first
    this.items = [];
  }

  get size() { return this.items.length; }
  isEmpty() { return this.items.length === 0; }
  peek() { return this.items[0]; }

  push(item) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.compare(a[i], a[p]) >= 0) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }

  pop() {
    const a = this.items;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && this.compare(a[l], a[m]) < 0) m = l;
        if (r < a.length && this.compare(a[r], a[m]) < 0) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }

  /** Items in priority order without mutating the heap (O(n log n)). */
  toSortedArray() {
    return [...this.items].sort(this.compare);
  }
}

module.exports = PriorityQueue;
