'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Graph = require('../server/graph/Graph');
const { buildFromOsm } = require('../server/graph/loader');

test('OSM ways become directed edges, one-ways respected, islands dropped', () => {
  const node = (id, lat, lon) => ({ type: 'node', id, lat, lon });
  const roads = {
    elements: [
      node(1, 12.95, 77.60), node(2, 12.951, 77.60), node(3, 12.952, 77.60), node(4, 12.952, 77.601),
      node(8, 12.97, 77.62), node(9, 12.971, 77.62), // disconnected island
      { type: 'way', id: 10, nodes: [1, 2, 3], tags: { highway: 'primary', name: 'MG Road', maxspeed: '40' } },
      { type: 'way', id: 11, nodes: [3, 4], tags: { highway: 'residential', oneway: 'yes' } },
      { type: 'way', id: 12, nodes: [4, 1], tags: { highway: 'residential', oneway: '-1' } },
      { type: 'way', id: 13, nodes: [8, 9], tags: { highway: 'residential' } },
    ],
  };
  const hosp = { elements: [{ type: 'way', id: 99, center: { lat: 12.9505, lon: 77.6 }, tags: { amenity: 'hospital', name: 'City Hospital' } }] };
  const data = buildFromOsm(roads, hosp, { name: 'Test', hospitals: [] });
  assert.strictEqual(data.lat.length, 4, 'island removed');
  assert.strictEqual(data.edges.length, 4 + 1 + 1);
  const g = new Graph(data);
  assert.strictEqual(g.hospitals[0].name, 'City Hospital');
  const idx = (lat, lng) => g.nearestNode(lat, lng);
  const has = (a, b) => g.out[a].some((e) => g.to[e] === b);
  assert.ok(has(idx(12.952, 77.60), idx(12.952, 77.601)));
  assert.ok(!has(idx(12.952, 77.601), idx(12.952, 77.60)), 'oneway=yes');
  assert.ok(has(idx(12.95, 77.60), idx(12.952, 77.601)), 'oneway=-1 runs against way direction');
  assert.ok(Math.abs(g.speed[g.out[idx(12.95, 77.60)].find((e) => g.roadClass[e] === 'primary')] - 40 / 3.6) < 1e-9);
});
