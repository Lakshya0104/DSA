'use strict';

const fs = require('fs');
const path = require('path');
const UnionFind = require('../ds/UnionFind');
const Graph = require('./Graph');
const { haversine } = require('./geo');

// Typical urban speeds (km/h) by OSM highway class, used when maxspeed is absent.
const SPEEDS = {
  motorway: 80, motorway_link: 50, trunk: 60, trunk_link: 40, primary: 45, primary_link: 35,
  secondary: 38, secondary_link: 30, tertiary: 32, tertiary_link: 25, unclassified: 25,
  residential: 22, living_street: 12,
};
const HIGHWAYS = Object.keys(SPEEDS).join('|');

function parseSpeed(tag, cls) {
  const v = parseFloat(tag);
  const kmh = Number.isFinite(v) && v > 0 ? (/mph/.test(tag) ? v * 1.609 : v) : SPEEDS[cls] || 25;
  return kmh / 3.6;
}

async function overpass(query) {
  const urls = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  let lastErr;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(90000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

/** Convert raw OSM ways into a directed edge list, keeping the largest connected component. */
function buildFromOsm(roadsJson, hospitalsJson, city) {
  const nodePos = new Map();
  for (const el of roadsJson.elements) if (el.type === 'node') nodePos.set(el.id, [el.lat, el.lon]);

  const idOf = new Map(); const lat = []; const lng = [];
  const getId = (osmId) => {
    let id = idOf.get(osmId);
    if (id === undefined) {
      const p = nodePos.get(osmId);
      id = lat.length; idOf.set(osmId, id); lat.push(p[0]); lng.push(p[1]);
    }
    return id;
  };

  const raw = [];
  for (const w of roadsJson.elements) {
    if (w.type !== 'way' || !w.tags) continue;
    const cls = w.tags.highway;
    const speed = parseSpeed(w.tags.maxspeed, cls);
    const ow = w.tags.oneway;
    const oneway = ow === 'yes' || ow === 'true' || ow === '1' || cls === 'motorway' || w.tags.junction === 'roundabout';
    const reverse = ow === '-1';
    const nodes = w.nodes.filter((n) => nodePos.has(n));
    for (let i = 0; i + 1 < nodes.length; i++) {
      const a = getId(nodes[i]), b = getId(nodes[i + 1]);
      if (a === b) continue;
      const base = { speed, roadClass: cls, name: w.tags.name || w.tags.ref || '' };
      if (!reverse) raw.push({ from: a, to: b, ...base });
      if (!oneway || reverse) raw.push({ from: b, to: a, ...base });
    }
  }

  // Keep only the largest connected component so every node is reachable.
  const uf = new UnionFind(lat.length);
  for (const e of raw) uf.union(e.from, e.to);
  const root = uf.largestRoot();
  const remap = new Int32Array(lat.length).fill(-1);
  const kLat = [], kLng = [];
  for (let i = 0; i < lat.length; i++) {
    if (uf.find(i) === root) { remap[i] = kLat.length; kLat.push(lat[i]); kLng.push(lng[i]); }
  }
  const edges = raw.filter((e) => remap[e.from] >= 0)
    .map((e) => ({ ...e, from: remap[e.from], to: remap[e.to] }));

  const hospitals = (hospitalsJson?.elements || [])
    .map((el) => ({
      name: el.tags?.name || 'Hospital',
      lat: el.lat ?? el.center?.lat, lng: el.lon ?? el.center?.lon,
    }))
    .filter((h) => h.lat && h.name !== 'Hospital')
    .slice(0, 12);

  return { lat: kLat, lng: kLng, edges, hospitals: hospitals.length ? hospitals : city.hospitals, meta: { source: 'osm', city: city.name } };
}

/**
 * Offline fallback: a jittered street grid with arterial roads laid over the
 * same bounding box, so the app still runs without internet access.
 */
function buildSynthetic(city) {
  const [s, w, n, e] = city.bbox;
  const R = 46, C = 46;
  const lat = [], lng = [], edges = [];
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      lat.push(s + ((n - s) * r) / (R - 1) + (rand() - 0.5) * 0.00025);
      lng.push(w + ((e - w) * c) / (C - 1) + (rand() - 0.5) * 0.00025);
    }
  }
  const id = (r, c) => r * C + c;
  const add = (a, b, cls, name) => {
    const speed = SPEEDS[cls] / 3.6;
    edges.push({ from: a, to: b, speed, roadClass: cls, name });
    edges.push({ from: b, to: a, speed, roadClass: cls, name });
  };
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      const rowCls = r % 9 === 0 ? 'primary' : r % 3 === 0 ? 'secondary' : 'residential';
      const colCls = c % 9 === 0 ? 'primary' : c % 3 === 0 ? 'secondary' : 'residential';
      if (c + 1 < C && (rowCls !== 'residential' || rand() > 0.12)) add(id(r, c), id(r, c + 1), rowCls, `Cross Road ${r + 1}`);
      if (r + 1 < R && (colCls !== 'residential' || rand() > 0.12)) add(id(r, c), id(r + 1, c), colCls, `Main Road ${c + 1}`);
    }
  }
  for (let k = 0; k + 1 < Math.min(R, C); k++) add(id(k, k), id(k + 1, k + 1), 'trunk', 'Outer Ring Road');
  for (const e2 of edges) e2.length = haversine(lat[e2.from], lng[e2.from], lat[e2.to], lng[e2.to]);
  return { lat, lng, edges, hospitals: city.hospitals, meta: { source: 'synthetic', city: city.name } };
}

// Bus-corridor speeds (km/h) reflecting Bengaluru traffic, keyed by class.
const BMTC_SPEEDS = { trunk: 38, primary: 32, secondary: 27, residential: 22 };

/**
 * Real Bengaluru network prebuilt by scripts/build_bengaluru.py from BMTC
 * route geometry; every edge is two-way.
 */
function buildFromBmtc(raw, city) {
  const edges = [];
  for (const [a, b, cls] of raw.edges) {
    const speed = BMTC_SPEEDS[cls] / 3.6;
    const length = haversine(raw.lat[a], raw.lng[a], raw.lat[b], raw.lng[b]);
    edges.push({ from: a, to: b, speed, roadClass: cls, length }, { from: b, to: a, speed, roadClass: cls, length });
  }
  return {
    lat: raw.lat, lng: raw.lng, edges, hospitals: raw.hospitals, wards: raw.wards, landmarks: raw.landmarks,
    meta: { source: 'bmtc', city: city.name },
  };
}

async function loadGraph(city, { dataDir, offline = false, log = console.log } = {}) {
  const bundled = path.join(dataDir, `${city.key}.json`);
  if (fs.existsSync(bundled)) {
    log(`Loading real road network ${path.basename(bundled)}`);
    return new Graph(buildFromBmtc(JSON.parse(fs.readFileSync(bundled, 'utf8')), city));
  }
  const cacheFile = path.join(dataDir, `osm-${city.key}.json`);
  if (fs.existsSync(cacheFile)) {
    log(`Loading cached road network ${path.basename(cacheFile)}`);
    return new Graph(JSON.parse(fs.readFileSync(cacheFile, 'utf8')));
  }
  if (!offline) {
    const [s, w, n, e] = city.bbox;
    const bbox = `${s},${w},${n},${e}`;
    try {
      log(`Downloading OpenStreetMap roads for ${city.name} (${bbox}) ...`);
      const roads = await overpass(`[out:json][timeout:80];way["highway"~"^(${HIGHWAYS})$"](${bbox});(._;>;);out body qt;`);
      const hosp = await overpass(`[out:json][timeout:60];(node["amenity"="hospital"](${bbox});way["amenity"="hospital"](${bbox}););out center tags;`)
        .catch(() => null);
      const data = buildFromOsm(roads, hosp, city);
      fs.writeFileSync(cacheFile, JSON.stringify(data));
      log(`Road network: ${data.lat.length} nodes, ${data.edges.length} directed edges (cached)`);
      return new Graph(data);
    } catch (err) {
      log(`OSM download failed (${err.message}); using synthetic street grid.`);
    }
  }
  return new Graph(buildSynthetic(city));
}

module.exports = { loadGraph, buildFromOsm, buildSynthetic, buildFromBmtc };
