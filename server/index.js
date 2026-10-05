'use strict';

const path = require('path');
const express = require('express');
const cfg = require('./config');
const { loadGraph } = require('./graph/loader');
const { Simulation } = require('./sim/Simulation');
const { hospitalCoverage } = require('./algorithms/coverage');
const { basemap } = require('./basemap');

async function main() {
  const graph = await loadGraph(cfg.CITY, { dataDir: path.join(__dirname, '..', 'data'), offline: cfg.OFFLINE });
  const sim = new Simulation(graph, cfg);
  console.log(`Graph ready: ${graph.n.toLocaleString()} intersections, ${graph.m.toLocaleString()} road segments, ${graph.hospitals.length} hospitals (${graph.meta.source})`);

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/vendor/leaflet', express.static(path.dirname(require.resolve('leaflet/dist/leaflet.js'))));

  const num = (x) => typeof x === 'number' && Number.isFinite(x);
  const point = (p) => p && num(p.lat) && num(p.lng);

  const base = basemap(graph);
  app.get('/api/meta', (req, res) => {
    res.json({
      ...base,
      city: cfg.CITY.name, center: cfg.CITY.center, bbox: cfg.CITY.bbox, source: graph.meta.source,
      nodes: graph.n, edges: graph.m, simSpeed: cfg.SIM_SPEED,
      hospitals: graph.hospitals.map((h) => ({ id: h.id, name: h.name, lat: graph.lat[h.node], lng: graph.lng[h.node] })),
      cities: Object.values(cfg.CITIES).map((c) => c.name),
    });
  });

  app.get('/api/state', (req, res) => res.json(sim.snapshot()));

  app.post('/api/incidents', (req, res) => {
    const { lat, lng, severity, type } = req.body || {};
    if (!point({ lat, lng })) return res.status(400).json({ error: 'lat and lng are required numbers' });
    res.status(201).json(sim.reportIncident({ lat, lng, severity, type }));
  });

  app.post('/api/route', (req, res) => {
    const { from, to } = req.body || {};
    if (!point(from) || !point(to)) return res.status(400).json({ error: 'from and to must be {lat, lng}' });
    res.json(sim.compareRoutes(from, to));
  });

  app.post('/api/roads/toggle', (req, res) => {
    const { lat, lng } = req.body || {};
    if (!point({ lat, lng })) return res.status(400).json({ error: 'lat and lng are required numbers' });
    const r = sim.toggleRoad(lat, lng);
    if (!r) return res.status(404).json({ error: 'No road near that point' });
    res.json(r);
  });

  app.delete('/api/roads/blocks', (req, res) => { sim.clearBlocks(); res.json({ ok: true }); });

  app.post('/api/traffic', (req, res) => { sim.setRushHour(!!req.body?.rushHour); res.json({ rushHour: sim.rushHour }); });

  app.post('/api/auto', (req, res) => { sim.auto = !!req.body?.auto; res.json({ auto: sim.auto }); });

  app.get('/api/coverage', (req, res) => {
    const minutes = Number(req.query.threshold) || 8;
    res.json(hospitalCoverage(graph, minutes * 60));
  });

  // Live updates over Server-Sent Events.
  const clients = new Set();
  app.get('/api/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write(`event: log\ndata: ${JSON.stringify(sim.events)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });
  sim.on('event', (ev) => {
    const msg = `event: log\ndata: ${JSON.stringify([ev])}\n\n`;
    for (const c of clients) c.write(msg);
  });

  setInterval(() => {
    sim.tick((cfg.TICK_MS / 1000) * cfg.SIM_SPEED);
    if (!clients.size) return;
    const msg = `event: state\ndata: ${JSON.stringify(sim.snapshot())}\n\n`;
    for (const c of clients) c.write(msg);
  }, cfg.TICK_MS);

  app.listen(cfg.PORT, () => console.log(`RescueRoute running at http://localhost:${cfg.PORT}`));
}

main().catch((err) => { console.error(err); process.exit(1); });
