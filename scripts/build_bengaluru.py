"""
Build a real Bengaluru road graph from public data:
  * BMTC bus route shapes (github.com/Vonter/bmtc-gtfs): they trace actual
    roads, so their union is the city's arterial and collector network.
  * BBMP ward boundaries (github.com/datameet/Municipal_Spatial_Data).
  * BMTC stops: named landmarks and the real hospital locations.

Points within ~SNAP metres are merged into one intersection; segments become
undirected edges weighted by length, classified by how many bus trips use them.
Output: data/bengaluru.json (consumed by server/graph/loader.js).
"""
import json, math, os, sys
from collections import defaultdict

RAW = os.path.join(os.path.dirname(__file__), '..', 'data', 'raw')
OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'bengaluru.json')
S, W, N, E = 12.885, 77.525, 13.045, 77.69   # central Bengaluru
SNAP = 22.0            # metres: merge points closer than this
MIN_SEG = 35.0         # metres: densify/simplify shape points to ~this spacing

lat0 = math.radians((S + N) / 2)
KX, KY = 111320 * math.cos(lat0), 110540
inside = lambda lat, lng: S <= lat <= N and W <= lng <= E

def dist(a, b):
    return math.hypot((a[1] - b[1]) * KX, (a[0] - b[0]) * KY)

# --- snap grid: a hash grid of cell -> node ids gives O(1) neighbour lookup
nodes, grid = [], defaultdict(list)
def node_for(lat, lng):
    cx, cy = int(lng * KX // SNAP), int(lat * KY // SNAP)
    best, bd = -1, SNAP
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for i in grid[(cx + dx, cy + dy)]:
                d = dist(nodes[i], (lat, lng))
                if d < bd: best, bd = i, d
    if best >= 0: return best
    nodes.append((lat, lng)); grid[(cx, cy)].append(len(nodes) - 1)
    return len(nodes) - 1

routes = json.load(open(os.path.join(RAW, 'routes.geojson')))['features']
edges = defaultdict(int)  # (a,b) -> bus trips
for f in routes:
    trips = f['properties'].get('trip_count') or 1
    geoms = f['geometry']['coordinates']
    if f['geometry']['type'] == 'LineString': geoms = [geoms]
    for line in geoms:
        prev, last_pt = None, None
        for lng, lat in line:
            if not inside(lat, lng): prev = None; last_pt = None; continue
            if last_pt and dist(last_pt, (lat, lng)) < MIN_SEG: continue
            v = node_for(lat, lng); last_pt = (lat, lng)
            if prev is not None and prev != v:
                if dist(nodes[prev], nodes[v]) < 600:   # skip GPS jumps
                    edges[(min(prev, v), max(prev, v))] += trips
            prev = v

# --- keep largest connected component (union-find)
parent = list(range(len(nodes)))
def find(x):
    while parent[x] != x: parent[x] = parent[parent[x]]; x = parent[x]
    return x
for a, b in edges: parent[find(a)] = find(b)
size = defaultdict(int)
for i in range(len(nodes)): size[find(i)] += 1
root = max(size, key=size.get)
keep = [i for i in range(len(nodes)) if find(i) == root and any(True for _ in [0])]
used = set()
for a, b in edges:
    if find(a) == root: used.add(a); used.add(b)
remap = {old: new for new, old in enumerate(sorted(used))}
lat = [round(nodes[i][0], 6) for i in sorted(used)]
lng = [round(nodes[i][1], 6) for i in sorted(used)]

# --- stops: names for nearby intersections, hospitals
stops = json.load(open(os.path.join(RAW, 'stops.geojson')))['features']
named = []
for s in stops:
    lng_, lat_ = s['geometry']['coordinates'][:2]
    if inside(lat_, lng_): named.append((s['properties']['name'], lat_, lng_, s['properties'].get('trip_count', 0)))
named.sort(key=lambda x: -x[3])

hosp_keys = ['hospital', 'nimhans', 'victoria']
bad_keys = ['veterinary', 'metro', 'isolation', 'commando']
hospitals, seen = [], []
for name, la, ln, t in named:
    low = name.lower()
    if any(k in low for k in hosp_keys) and not any(k in low for k in bad_keys) and 'road' not in low and 'cross' not in low:
        if all(dist((la, ln), (h['lat'], h['lng'])) > 1500 for h in hospitals):
            hospitals.append({'name': name.replace(' Bus Stop', ''), 'lat': la, 'lng': ln})
hospitals = hospitals[:14]

landmarks = []
for name, la, ln, t in named:
    if all(dist((la, ln), (l[1], l[2])) > 350 for l in landmarks):
        landmarks.append([name, round(la, 5), round(ln, 5)])
    if len(landmarks) >= 900: break

# --- edges with class by bus volume
out_edges = []
for (a, b), trips in edges.items():
    if a in remap and b in remap:
        cls = 'trunk' if trips > 2500 else 'primary' if trips > 900 else 'secondary' if trips > 250 else 'residential'
        out_edges.append([remap[a], remap[b], cls])

# --- wards (Douglas-Peucker simplification + clip to bbox)
def dp(pts, eps):
    if len(pts) < 3: return pts
    a, b = pts[0], pts[-1]
    def d(p):
        ax, ay, bx, by = a[0]*KX, a[1]*KY, b[0]*KX, b[1]*KY
        px, py = p[0]*KX, p[1]*KY
        L = math.hypot(bx-ax, by-ay) or 1
        return abs((bx-ax)*(ay-py) - (ax-px)*(by-ay)) / L
    i, m = max(((i, d(p)) for i, p in enumerate(pts[1:-1], 1)), key=lambda x: x[1])
    if m > eps: return dp(pts[:i+1], eps)[:-1] + dp(pts[i:], eps)
    return [a, b]
wards = []
for f in json.load(open(os.path.join(RAW, 'wards.geojson')))['features']:
    g = f['geometry']
    polys = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
    ring = max((p[0] for p in polys), key=len)
    cx = sum(p[0] for p in ring) / len(ring); cy = sum(p[1] for p in ring) / len(ring)
    if not inside(cy, cx): continue
    # A closed ring starts and ends on the same point, so split it at the
    # vertex farthest from the start and simplify each half.
    far = max(range(len(ring)), key=lambda i: dist((ring[0][1], ring[0][0]), (ring[i][1], ring[i][0])))
    simp = dp(ring[:far + 1], 25)[:-1] + dp(ring[far:], 25)
    wards.append({'name': f['properties']['KGISWardName'], 'ring': [[round(y, 5), round(x, 5)] for x, y in simp]})

data = {'lat': lat, 'lng': lng, 'edges': out_edges, 'hospitals': hospitals,
        'landmarks': landmarks, 'wards': wards, 'bbox': [S, W, N, E]}
json.dump(data, open(OUT, 'w'), separators=(',', ':'))
print(f"nodes={len(lat)} edges={len(out_edges)} hospitals={len(hospitals)} landmarks={len(landmarks)} wards={len(wards)} size={os.path.getsize(OUT)/1e6:.2f}MB")
print([h['name'] for h in hospitals])
