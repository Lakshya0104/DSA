'use strict';

const test = require('node:test');
const assert = require('node:assert');
const IndexedMinHeap = require('../server/ds/IndexedMinHeap');
const PriorityQueue = require('../server/ds/PriorityQueue');
const KDTree = require('../server/ds/KDTree');
const UnionFind = require('../server/ds/UnionFind');
const LRUCache = require('../server/ds/LRUCache');

const rng = (seed) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

test('IndexedMinHeap pops in key order and supports decrease-key', () => {
  const r = rng(1);
  const h = new IndexedMinHeap(500);
  const keys = new Map();
  for (let i = 0; i < 500; i++) { const k = r() * 1000; keys.set(i, k); h.pushOrDecrease(i, k); }
  for (let i = 0; i < 500; i += 3) { const k = keys.get(i) / 2; keys.set(i, k); h.pushOrDecrease(i, k); }
  h.pushOrDecrease(7, 1e9); // larger key must be ignored
  const expected = [...keys.entries()].sort((a, b) => a[1] - b[1]).map((e) => e[0]);
  const got = [];
  while (!h.isEmpty()) got.push(h.pop());
  assert.deepStrictEqual(got, expected);
});

test('PriorityQueue orders incidents by severity then time', () => {
  const q = new PriorityQueue((a, b) => a.severity - b.severity || a.t - b.t);
  [[3, 1], [1, 5], [2, 2], [1, 3], [3, 0]].forEach(([severity, t]) => q.push({ severity, t }));
  const out = [];
  while (!q.isEmpty()) { const x = q.pop(); out.push(`${x.severity}:${x.t}`); }
  assert.deepStrictEqual(out, ['1:3', '1:5', '2:2', '3:0', '3:1']);
});

test('KDTree nearest and radius match brute force', () => {
  const r = rng(42);
  const lat = [], lng = [];
  for (let i = 0; i < 3000; i++) { lat.push(12.9 + r() * 0.1); lng.push(77.5 + r() * 0.1); }
  const kd = new KDTree(lat, lng);
  const d2 = (i, qa, qo) => ((lng[i] - qo) * kd.cos) ** 2 + (lat[i] - qa) ** 2;
  for (let t = 0; t < 200; t++) {
    const qa = 12.9 + r() * 0.1, qo = 77.5 + r() * 0.1;
    let best = 0;
    for (let i = 1; i < lat.length; i++) if (d2(i, qa, qo) < d2(best, qa, qo)) best = i;
    assert.strictEqual(kd.nearest(qa, qo), best);
    const rad = 400 / 111320;
    const brute = lat.map((_, i) => i).filter((i) => d2(i, qa, qo) <= rad * rad).sort((a, b) => a - b);
    assert.deepStrictEqual(kd.withinRadius(qa, qo, 400).sort((a, b) => a - b), brute);
  }
});

test('UnionFind tracks components', () => {
  const uf = new UnionFind(6);
  uf.union(0, 1); uf.union(1, 2); uf.union(3, 4);
  assert.strictEqual(uf.components, 3);
  assert.strictEqual(uf.find(0), uf.find(2));
  assert.notStrictEqual(uf.find(0), uf.find(3));
  assert.strictEqual(uf.size[uf.largestRoot()], 3);
});

test('LRUCache evicts least recently used', () => {
  const c = new LRUCache(2);
  c.set('a', 1); c.set('b', 2);
  assert.strictEqual(c.get('a'), 1);
  c.set('c', 3); // evicts b
  assert.strictEqual(c.get('b'), undefined);
  assert.strictEqual(c.get('a'), 1);
  assert.strictEqual(c.get('c'), 3);
  assert.strictEqual(c.hits, 3);
  assert.strictEqual(c.misses, 1);
});
