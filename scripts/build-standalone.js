'use strict';
/**
 * Builds a single self-contained HTML file (dist/rescueroute.html) that runs
 * the backend modules in the browser. Useful for sharing a prototype link
 * where no Node server is available. Map tiles and the OSM download are not
 * available there, so the road graph itself is drawn as the map.
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const modules = [
  'server/ds/IndexedMinHeap.js', 'server/ds/PriorityQueue.js', 'server/ds/KDTree.js',
  'server/ds/UnionFind.js', 'server/ds/LRUCache.js', 'server/graph/geo.js', 'server/graph/Graph.js',
  'server/graph/loader.js', 'server/algorithms/search.js', 'server/algorithms/coverage.js',
  'server/sim/Simulation.js', 'server/config.js', 'server/basemap.js',
];

const bundle = `
(function () {
  var process = { env: {}, hrtime: { bigint: function () { return BigInt(Math.round(performance.now() * 1e6)); } } };
  function EventEmitter() { this._h = {}; }
  EventEmitter.prototype.on = function (n, f) { (this._h[n] = this._h[n] || []).push(f); return this; };
  EventEmitter.prototype.emit = function (n, a) { (this._h[n] || []).forEach(function (f) { f(a); }); };
  var builtins = { events: { EventEmitter: EventEmitter }, fs: {}, path: { join: function () { return ''; }, basename: function (x) { return x; } } };
  var defs = {}, cache = {};
  function norm(from, req) {
    var parts = from.split('/'); parts.pop();
    req.split('/').forEach(function (p) { if (p === '..') parts.pop(); else if (p !== '.') parts.push(p); });
    var r = parts.join('/'); return /\\.js$/.test(r) ? r : r + '.js';
  }
  function load(id) {
    if (cache[id]) return cache[id].exports;
    var module = cache[id] = { exports: {} };
    defs[id](module, module.exports, function (r) { return builtins[r] || load(norm(id, r)); });
    return module.exports;
  }
${modules.map((m) => `  defs[${JSON.stringify(m)}] = function (module, exports, require) {\n${read(m)}\n};`).join('\n')}
  window.RR_REQUIRE = load;
})();
`;

const adapter = read('scripts/standalone-backend.js')
  .replace('/*__BENGALURU__*/null', fs.readFileSync(path.join(root, 'data/bengaluru.json'), 'utf8'));
const leafletCss = fs.readFileSync(require.resolve('leaflet/dist/leaflet.css'), 'utf8');
let html = read('public/index.html');
html = html
  .replace(/<!doctype html>\s*<html[^>]*>\s*<head>/i, '')
  .replace(/<meta charset[^>]*>\s*<meta name="viewport"[^>]*>/, '')
  .replace('<title>RescueRoute — Emergency Dispatch</title>', '<title>RescueRoute</title>')
  .replace('<link rel="stylesheet" href="vendor/leaflet/leaflet.css" />', `<style>${leafletCss}</style>`)
  .replace('<link rel="stylesheet" href="styles.css" />', `<style>${read('public/styles.css')}</style>`)
  .replace(/<\/head>\s*<body>/, '')
  .replace('<script src="vendor/leaflet/leaflet.js"></script>',
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js"></script>')
  .replace('<script src="app.js"></script>',
    `<script>${bundle}</script>\n<script>${adapter}</script>\n<script>${read('public/app.js')}</script>`)
  .replace(/<\/body>\s*<\/html>\s*$/, '');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/rescueroute.html'), html);
console.log('wrote dist/rescueroute.html', (html.length / 1024).toFixed(0) + ' KB');
