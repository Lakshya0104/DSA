/* In-browser stand-in for server/index.js: same routes, same simulation. */
(function () {
  'use strict';
  var req = window.RR_REQUIRE;
  var cfg = req('server/config.js');
  var Graph = req('server/graph/Graph.js');
  var loader = req('server/graph/loader.js');
  var Simulation = req('server/sim/Simulation.js').Simulation;
  var hospitalCoverage = req('server/algorithms/coverage.js').hospitalCoverage;
  var basemap = req('server/basemap.js').basemap;

  var city = cfg.CITIES.bengaluru;
  var RAW = /*__BENGALURU__*/null;
  var graph = new Graph(RAW ? loader.buildFromBmtc(RAW, city) : loader.buildSynthetic(city));
  var sim = new Simulation(graph, cfg);

  function api(url, opts) {
    var body = (opts && opts.body) || {};
    var method = (opts && opts.method) || 'GET';
    var u = new URL(url, 'http://x');
    var r;
    switch (method + ' ' + u.pathname) {
      case 'GET /api/meta':
        r = Object.assign(basemap(graph), {
          city: city.name, center: city.center, bbox: city.bbox, source: graph.meta.source, standalone: true,
          nodes: graph.n, edges: graph.m, simSpeed: cfg.SIM_SPEED,
          hospitals: graph.hospitals.map(function (h) { return { id: h.id, name: h.name, lat: graph.lat[h.node], lng: graph.lng[h.node] }; }),
        });
        return Promise.resolve(r);
      case 'POST /api/incidents': r = sim.reportIncident(body); break;
      case 'POST /api/route': r = sim.compareRoutes(body.from, body.to); break;
      case 'POST /api/roads/toggle':
        r = sim.toggleRoad(body.lat, body.lng);
        if (!r) return Promise.reject(new Error('No road there. Click directly on a street.'));
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
    sim.on('event', function (ev) { h.log([ev]); });
    // Warm start so the dashboard opens mid-shift with live activity.
    for (var i = 0; i < 540; i++) sim.tick(4);
    h.log(sim.events);
    setInterval(function () {
      sim.tick((cfg.TICK_MS / 1000) * cfg.SIM_SPEED);
      h.state(sim.snapshot());
    }, cfg.TICK_MS);
    h.state(sim.snapshot());
  }

  window.RR_BACKEND = { api: api, subscribe: subscribe };
})();
