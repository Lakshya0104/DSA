# RescueRoute: City Traffic & Emergency Dispatch

**Live demo:** https://rescueroute-hazel.vercel.app · **Beginner guide (PDF):** [docs/RescueRoute-Beginner-Guide.pdf](docs/RescueRoute-Beginner-Guide.pdf)

A live emergency-dispatch dashboard running on a **real OpenStreetMap road network**. Incidents come in, ambulances get assigned by true road travel time, roads close, traffic builds up and ambulances re-plan. Every routing decision is made by data structures and graph algorithms implemented from scratch in this repo, with no routing libraries.

## Run it

```bash
npm install
npm start            # http://localhost:3000
```

For Bengaluru the app ships with a **real road network** in `data/bengaluru.json` (16,825 intersections, 14 hospitals, 171 BBMP wards). It was built by `scripts/build_bengaluru.py` from public BMTC bus-route geometry ([Vonter/bmtc-gtfs](https://github.com/Vonter/bmtc-gtfs)), and every BMTC route follows real roads. Ward boundaries come from [DataMeet](https://github.com/datameet/Municipal_Spatial_Data). For other cities, the server downloads the road network and hospitals for the city's bounding box from the Overpass API and caches them in `data/`. Later starts are instant. If the download fails, the server falls back to a synthetic street grid so the app still works offline.

| Env var      | Default     | Meaning                                    |
|--------------|-------------|--------------------------------------------|
| `CITY`       | `bengaluru` | `bengaluru`, `mumbai` or `delhi`           |
| `FLEET_SIZE` | `10`        | Number of ambulances                       |
| `SIM_SPEED`  | `6`         | Simulated seconds per real second          |
| `OFFLINE`    | –           | `1` = skip download, use the synthetic grid |
| `PORT`       | `3000`      |                                            |

`npm test` runs the test suite. Each data structure and algorithm is checked against a brute-force or reference implementation (Bellman-Ford, linear scan).

### Deploy to Vercel

The repo is set up for Vercel through `vercel.json`. Vercel runs `node scripts/build-standalone.js` and serves `dist/` as a static site, so there's no server to keep running.

1. Push this repo to GitHub.
2. On vercel.com, go to **Add New → Project**, import the repo, and click **Deploy**. The settings come from `vercel.json`, so leave them as they are.

You can deploy from the command line instead with `npx vercel --prod`.

### Shareable prototype

`node scripts/build-standalone.js` writes `dist/rescueroute.html`. This single file runs the same backend modules in the browser, so it can be hosted anywhere without a server.

## What you can do

The app has six views: **Command Center** (live map), **Route Lab**, **Coverage**, **Fleet**, **Analytics** and **Algorithms**. Incidents, routes and units link out to Google Maps, Street View and Google Maps directions.


- **Report incident:** click the map. The call enters the triage queue, and the fastest ambulance by road is dispatched.
- **Route planner:** click two points. Dijkstra and A* run side by side and their explored nodes are animated on the map.
- **Close road:** click a street. Ambulances whose route uses it re-plan instantly, and the network-health card shows any area that gets cut off.
- **Rush hour:** congestion builds around random hotspots. Moving units re-plan when a faster route appears.
- **Coverage map:** a heatmap of travel time from every intersection to its nearest hospital, plus the share of the city outside the 8-minute target.

## Where the DSA is used

| Problem in the product | Data structure / algorithm | File |
|---|---|---|
| City road network with one-way streets | Directed weighted graph, forward + reverse adjacency lists; edge weight = travel time | `server/graph/Graph.js` |
| Shortest route | **Dijkstra** with an **indexed binary min-heap** (true decrease-key, O((V+E) log V)) | `server/algorithms/search.js`, `server/ds/IndexedMinHeap.js` |
| Faster point-to-point routing and re-routing | **A\*** with an admissible haversine / max-speed heuristic, so routes stay optimal | `server/algorithms/search.js` |
| "Which ambulance is closest **by road**?" | **One reverse Dijkstra** from the incident with all idle units as targets and early exit, instead of k separate searches | `server/sim/Simulation.js` (`_dispatchPending`) |
| Nearest hospital for transport | Forward multi-target Dijkstra, stopping at the first hospital settled | `server/sim/Simulation.js` |
| Hospital coverage heatmap | **Multi-source Dijkstra** from all hospitals, O((V+E) log V) instead of Floyd–Warshall's O(V³) | `server/algorithms/coverage.js` |
| Incident triage (critical first, then oldest) | **Priority queue** (binary heap, custom comparator) | `server/ds/PriorityQueue.js` |
| Map click → nearest intersection / road; traffic hotspots | **2-d tree** built with quickselect medians: nearest-neighbour and radius queries | `server/ds/KDTree.js` |
| Dropping disconnected OSM fragments; detecting areas cut off by closures | **Union-find** with path halving and union by size | `server/ds/UnionFind.js`, `Graph.connectivity()` |
| Repeated route queries | **LRU cache** (hash map + doubly linked list), keyed by graph version so closures invalidate it | `server/ds/LRUCache.js` |
| Ambulance position along its route | **Binary search** over cumulative travel times | `Simulation._progress` |

## Architecture

```
server/
  index.js            Express REST API + Server-Sent Events stream (2 updates/s)
  config.js           Cities, fleet size, simulation speed
  ds/                 IndexedMinHeap, PriorityQueue, KDTree, UnionFind, LRUCache
  graph/              Graph model, OSM loader (Overpass), geo helpers
  algorithms/         Dijkstra / A* / multi-source search, hospital coverage
  sim/Simulation.js   Dispatch engine: triage, assignment, movement, rerouting, traffic
public/               Dashboard (Leaflet map, vanilla JS, no build step)
test/                 node:test suites
```

### API

| Method | Path | Body / query |
|---|---|---|
| GET | `/api/meta` | City, graph size, hospitals |
| GET | `/api/state` | Full snapshot (fleet, incidents, stats) |
| GET | `/api/stream` | SSE: `state` and `log` events |
| POST | `/api/incidents` | `{ lat, lng, severity: 1-3 }` |
| POST | `/api/route` | `{ from: {lat,lng}, to: {lat,lng} }` returns the Dijkstra vs A* comparison |
| POST | `/api/roads/toggle` | `{ lat, lng }` closes or reopens the nearest road |
| DELETE | `/api/roads/blocks` | Reopen all roads |
| POST | `/api/traffic` | `{ rushHour: boolean }` |
| POST | `/api/auto` | `{ auto: boolean }` toggles random incident generation |
| GET | `/api/coverage?threshold=8` | Coverage heatmap + stats |

Map data © OpenStreetMap contributors. Basemap tiles © CARTO.
