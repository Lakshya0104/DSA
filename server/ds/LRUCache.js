'use strict';

/**
 * LRU cache: hash map + doubly linked list, O(1) get/put. Caches computed
 * routes; keys embed the graph version so road closures invalidate entries.
 */
class LRUCache {
  constructor(capacity) {
    this.capacity = capacity;
    this.map = new Map();
    this.head = { prev: null, next: null }; // most recent after head
    this.tail = { prev: this.head, next: null };
    this.head.next = this.tail;
    this.hits = 0;
    this.misses = 0;
  }

  _unlink(n) { n.prev.next = n.next; n.next.prev = n.prev; }
  _pushFront(n) {
    n.next = this.head.next; n.prev = this.head;
    this.head.next.prev = n; this.head.next = n;
  }

  get(key) {
    const n = this.map.get(key);
    if (!n) { this.misses++; return undefined; }
    this.hits++;
    this._unlink(n); this._pushFront(n);
    return n.value;
  }

  set(key, value) {
    let n = this.map.get(key);
    if (n) { n.value = value; this._unlink(n); this._pushFront(n); return; }
    n = { key, value, prev: null, next: null };
    this.map.set(key, n);
    this._pushFront(n);
    if (this.map.size > this.capacity) {
      const lru = this.tail.prev;
      this._unlink(lru);
      this.map.delete(lru.key);
    }
  }

  clear() {
    this.map.clear();
    this.head.next = this.tail; this.tail.prev = this.head;
  }

  get size() { return this.map.size; }
}

module.exports = LRUCache;
