'use strict';

/** Vector basemap payload for the client: roads by class, wards, landmarks. */
function basemap(graph) {
  const roads = { trunk: [], primary: [], secondary: [], residential: [] };
  const r5 = (x) => Math.round(x * 1e5) / 1e5;
  for (let e = 0; e < graph.m; e++) {
    const t = graph.twin(e);
    if (t >= 0 && t < e) continue;
    const c = roads[graph.roadClass[e]] ? graph.roadClass[e] : 'residential';
    const a = graph.from[e], b = graph.to[e];
    roads[c].push([[r5(graph.lat[a]), r5(graph.lng[a])], [r5(graph.lat[b]), r5(graph.lng[b])]]);
  }
  return {
    roads,
    wards: graph.wards.map((w) => ({ name: w.name, ring: w.ring, center: w.center })),
    landmarks: graph.landmarks.slice(0, 400),
  };
}

module.exports = { basemap };
