/* In-browser stand-in for server/index.js: same routes, same simulation. */
(function () {
  'use strict';
  var req = window.RR_REQUIRE;
  var cfg = req('server/config.js');
  var Graph = req('server/graph/Graph.js');
  var buildSynthetic = req('server/graph/loader.js').buildSynthetic;
  var Simulation = req('server/sim/Simulation.js').Simulation;
  var hospitalCoverage = req('server/algorithms/coverage.js').hospitalCoverage;

  var city = cfg.CITIES.bengaluru;
  var graph = new Graph(buildSynthetic(city));
  var sim = new Simulation(graph, cfg);
  var classes = ['trunk', 'primary', 'secondary', 'residential'];

  function roads() {
    var out = { trunk: [], primary: [], secondary: [], residential: [] };
    for (var e = 0; e < graph.m; e++) {
      var t = graph.twin(e);
      if (t >= 0 && t < e) continue;
      var c = classes.indexOf(graph.roadClass[e]) >= 0 ? graph.roadClass[e] : 'residential';
      out[c].push(graph.edgeCoords(e));
    }
    return out;
  }

  function api(url, opts) {
    var body = (opts && opts.body) || {};
    var method = (opts && opts.method) || 'GET';
    var u = new URL(url, 'http://x');
    var r;
    switch (method + ' ' + u.pathname) {
      case 'GET /api/meta':
        r = {
          city: city.name, center: city.center, bbox: city.bbox, source: graph.meta.source, standalone: true,
          nodes: graph.n, edges: graph.m, simSpeed: cfg.SIM_SPEED, roads: roads(),
          hospitals: graph.hospitals.map(function (h) { return { id: h.id, name: h.name, lat: graph.lat[h.node], lng: graph.lng[h.node] }; }),
        };
        break;
      case 'POST /api/incidents': r = sim.reportIncident(body); break;
      case 'POST /api/route': r = sim.compareRoutes(body.from, body.to); break;
      case 'POST /api/roads/toggle':
        r = sim.toggleRoad(body.lat, body.lng);
        if (!r) return Promise.reject(new Error('No road near that point. Click closer to a street.'));
        break;
      case 'DELETE /api/roads/blocks': sim.clearBlocks(); r = { ok: true }; break;
      case 'POST /api/traffic': sim.setRushHour(!!body.rushHour); r = { rushHour: sim.rushHour }; break;
      case 'POST /api/auto': sim.auto = !!body.auto; r = { auto: sim.auto }; break;
      case 'GET /api/coverage': r = hospitalCoverage(graph, (Number(u.searchParams.get('threshold')) || 8) * 60); break;
      default: return Promise.reject(new Error('Unknown route ' + u.pathname));
    }
    return Promise.resolve(JSON.parse(JSON.stringify(r)));
  }

  function subscribe(h) {
    h.log(sim.events);
    sim.on('event', function (ev) { h.log([ev]); });
    // Warm start so the dashboard opens in a working state.
    for (var i = 0; i < 300; i++) sim.tick(3);
    setInterval(function () {
      sim.tick((cfg.TICK_MS / 1000) * cfg.SIM_SPEED);
      h.state(sim.snapshot());
    }, cfg.TICK_MS);
    h.state(sim.snapshot());
  }

  window.RR_BACKEND = { api: api, subscribe: subscribe };
})();
