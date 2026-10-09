// Road network for the simulated traffic layer (simtraffic). Pure: no Cesium,
// no network, so the terminal shell and the tests share it.
//
// OSM ways come from Overpass, one query per map tile, with geometry: the road
// classes depend on how high the camera is (fewer, bigger roads higher up), and
// each tile is cached by the source (source.js). This module turns the ways of
// the tiles around the view into a small routable graph: ways are split at
// every vertex another way shares (a junction), each piece is an edge with its
// class, free-flow speed (maxspeed, else a class default), lanes and one-way
// rule, and edges meet at nodes so a simulated vehicle can turn onto the next.

/** Road classes the simulation drives on, with defaults for untagged ways. */
export const ROAD_CLASSES = {
  motorway: { rank: 0, kmh: 110, lanes: 2, oneway: true },
  motorway_link: { rank: 0, kmh: 60, lanes: 1, oneway: true },
  trunk: { rank: 1, kmh: 90, lanes: 2 },
  trunk_link: { rank: 1, kmh: 50, lanes: 1 },
  primary: { rank: 2, kmh: 60, lanes: 2 },
  primary_link: { rank: 2, kmh: 40, lanes: 1 },
  secondary: { rank: 3, kmh: 50, lanes: 1 },
  secondary_link: { rank: 3, kmh: 40, lanes: 1 },
  tertiary: { rank: 4, kmh: 45, lanes: 1 },
  tertiary_link: { rank: 4, kmh: 35, lanes: 1 },
  unclassified: { rank: 5, kmh: 40, lanes: 1 },
  residential: { rank: 6, kmh: 30, lanes: 1 },
};

/**
 * Detail bands by camera height: which classes load, and the tile size that
 * keeps one Overpass answer small. Above the last band the layer is idle (the
 * owner's rule: simulated traffic only below 8 km).
 */
export const BANDS = [
  { id: 'street', maxHeightM: 1500, maxRank: 6, tileDeg: 0.01 },
  { id: 'district', maxHeightM: 4000, maxRank: 4, tileDeg: 0.02 },
  { id: 'city', maxHeightM: 8000, maxRank: 3, tileDeg: 0.04 },
];
export const MAX_SIM_HEIGHT_M = BANDS[BANDS.length - 1].maxHeightM;

/** The detail band for a camera height (metres), or null above 8 km. */
export function bandFor(heightM) {
  if (!Number.isFinite(heightM) || heightM < 0) return BANDS[0];
  return BANDS.find((b) => heightM < b.maxHeightM) ?? null;
}

/** Highway values loaded for a band. */
export function classesFor(band) {
  return Object.keys(ROAD_CLASSES).filter((k) => ROAD_CLASSES[k].rank <= band.maxRank);
}

/** The radius (metres) of road around the view centre worth simulating. */
export const focusRadiusM = (heightM) =>
  Math.max(700, Math.min(6500, (Number(heightM) || 0) * 1.1));

// --- tiles ------------------------------------------------------------------

const round6 = (x) => Math.round(x * 1e6) / 1e6;

/** Tile key and box for a tile index in a band. */
export function tileBox(band, ix, iy) {
  const d = band.tileDeg;
  return {
    key: `${band.id}/${ix}/${iy}`,
    lamin: round6(iy * d),
    lomin: round6(ix * d),
    lamax: round6((iy + 1) * d),
    lomax: round6((ix + 1) * d),
  };
}

/**
 * The tiles covering a circle around the focus, nearest first, at most `max`.
 * @param {{ id: string, tileDeg: number }} band
 * @param {{ lat: number, lon: number }} focus
 */
export function tilesAround(band, focus, radiusM, max = 9) {
  const d = band.tileDeg;
  const dLat = radiusM / 110_540;
  const dLon =
    radiusM / (111_320 * Math.max(0.05, Math.cos((focus.lat * Math.PI) / 180)));
  const out = [];
  for (
    let iy = Math.floor((focus.lat - dLat) / d);
    iy <= Math.floor((focus.lat + dLat) / d);
    iy += 1
  ) {
    for (
      let ix = Math.floor((focus.lon - dLon) / d);
      ix <= Math.floor((focus.lon + dLon) / d);
      ix += 1
    ) {
      const t = tileBox(band, ix, iy);
      const cLat = (t.lamin + t.lamax) / 2;
      const cLon = (t.lomin + t.lomax) / 2;
      t.dist = Math.hypot(
        (cLat - focus.lat) * 110_540,
        (cLon - focus.lon) * 111_320 * Math.cos((focus.lat * Math.PI) / 180),
      );
      out.push(t);
    }
  }
  return out.sort((a, b) => a.dist - b.dist).slice(0, max);
}

/**
 * The Overpass QL for one tile: the band's road classes with tags and geometry.
 * Overpass bbox order is (south, west, north, east). Ways that leave the tile
 * come back whole, so tiles overlap at their edges; the merge dedupes by id.
 */
export function overpassRoadQuery(band, tile, maxWays = 1500) {
  const re = classesFor(band).join('|');
  const box = `${tile.lamin},${tile.lomin},${tile.lamax},${tile.lomax}`;
  return `[out:json][timeout:25];way["highway"~"^(${re})$"](${box});out tags geom qt ${maxWays};`;
}

// --- parsing ------------------------------------------------------------------

/** "50", "30 mph", "50 km/h", "walk", "none"... -> km/h, or null. */
export function parseMaxspeed(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  const m = /^(\d{1,3}(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!(n > 0) || n > 200) return null;
  return m[2] === 'mph' ? n * 1.609344 : n;
}

const lanesOf = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 && n <= 12 ? n : null;
};

/**
 * Overpass JSON -> plain ways: { id, cls, rank, name, ref, freeKmh, maxspeedTagged,
 * lanes, oneway: 1 | -1 | 0, coords: [[lon, lat], ...] }. Unknown classes,
 * area highways and ways with fewer than two points are skipped.
 */
export function parseRoadWays(json) {
  const elements = Array.isArray(json?.elements) ? json.elements : [];
  const out = [];
  for (const e of elements) {
    if (e?.type !== 'way' || !Array.isArray(e.geometry) || e.geometry.length < 2)
      continue;
    const tags = e.tags || {};
    const cls = tags.highway;
    const def = ROAD_CLASSES[cls];
    if (!def || tags.area === 'yes') continue;
    const coords = [];
    for (const p of e.geometry) {
      if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lon)) continue;
      coords.push([p.lon, p.lat]);
    }
    if (coords.length < 2) continue;
    const ow = String(tags.oneway ?? '').toLowerCase();
    const oneway =
      ow === '-1' || ow === 'reverse'
        ? -1
        : ow === 'yes' || ow === 'true' || ow === '1'
          ? 1
          : ow === 'no' || ow === 'false' || ow === '0'
            ? 0
            : def.oneway || tags.junction === 'roundabout' || tags.junction === 'circular'
              ? 1
              : 0;
    const tagged = parseMaxspeed(tags.maxspeed);
    out.push({
      id: e.id,
      cls,
      rank: def.rank,
      name: typeof tags.name === 'string' ? tags.name : '',
      ref: typeof tags.ref === 'string' ? tags.ref : '',
      freeKmh: tagged ?? def.kmh,
      maxspeedTagged: tagged != null,
      lanes: lanesOf(tags.lanes),
      oneway,
      coords,
    });
  }
  return out;
}

/** Merge way lists from several tiles, keeping one copy of each way. */
export function mergeWays(lists) {
  const seen = new Map();
  for (const list of lists)
    for (const w of list || []) if (!seen.has(w.id)) seen.set(w.id, w);
  return [...seen.values()];
}

// --- the graph ------------------------------------------------------------------

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON = 111_320;

const nodeKey = (lon, lat) => `${Math.round(lon * 1e6)},${Math.round(lat * 1e6)}`;

/**
 * Build the routable network from ways. Edges are way pieces between
 * junctions; each carries flat lon/lat coords, cumulative distances (metres),
 * per-segment unit vectors in local metres (east, north) and its two nodes.
 * Lanes per direction: a one-way road takes all its lanes, a two-way road
 * half (at least one each way).
 * @param {ReturnType<typeof parseRoadWays>} ways
 * @param {{ lat: number, lon: number }} origin  local metres are measured from here
 */
export function buildNetwork(ways, origin) {
  const kx = M_PER_DEG_LON * Math.cos((origin.lat * Math.PI) / 180);
  const ky = M_PER_DEG_LAT;
  // A vertex used by two ways, or twice by one, is a junction.
  const uses = new Map();
  for (const w of ways) {
    for (const [lon, lat] of w.coords) {
      const k = nodeKey(lon, lat);
      uses.set(k, (uses.get(k) ?? 0) + 1);
    }
  }
  const nodeIds = new Map();
  const nodeLon = [];
  const nodeLat = [];
  const nodeOf = (lon, lat) => {
    const k = nodeKey(lon, lat);
    let id = nodeIds.get(k);
    if (id === undefined) {
      id = nodeLon.length;
      nodeIds.set(k, id);
      nodeLon.push(lon);
      nodeLat.push(lat);
    }
    return id;
  };

  const edges = [];
  for (const w of ways) {
    const n = w.coords.length;
    let start = 0;
    let piece = 0;
    for (let i = 1; i < n; i += 1) {
      const [lon, lat] = w.coords[i];
      const junction = i === n - 1 || (uses.get(nodeKey(lon, lat)) ?? 0) > 1;
      if (!junction) continue;
      const pts = w.coords.slice(start, i + 1);
      const edge = makeEdge(w, pts, `${w.id}:${piece}`, kx, ky);
      if (edge) {
        edge.from = nodeOf(pts[0][0], pts[0][1]);
        edge.to = nodeOf(pts[pts.length - 1][0], pts[pts.length - 1][1]);
        edge.index = edges.length;
        edges.push(edge);
      }
      piece += 1;
      start = i;
    }
  }
  // Directed adjacency: for each node, the (edge, direction) pairs leaving it.
  const out = Array.from({ length: nodeLon.length }, () => []);
  for (const e of edges) {
    if (e.lanesFwd > 0) out[e.from].push({ edge: e.index, dir: 1 });
    if (e.lanesBack > 0) out[e.to].push({ edge: e.index, dir: -1 });
  }
  let laneKm = 0;
  for (const e of edges) laneKm += ((e.lanesFwd + e.lanesBack) * e.lengthM) / 1000;
  return {
    origin: { lat: origin.lat, lon: origin.lon },
    kx,
    ky,
    edges,
    nodeCount: nodeLon.length,
    out,
    laneKm,
  };
}

function makeEdge(w, pts, id, kx, ky) {
  const n = pts.length;
  const coords = new Float64Array(n * 2);
  const cum = new Float64Array(n);
  const ux = new Float32Array(Math.max(1, n - 1));
  const uy = new Float32Array(Math.max(1, n - 1));
  for (let i = 0; i < n; i += 1) {
    coords[i * 2] = pts[i][0];
    coords[i * 2 + 1] = pts[i][1];
    if (i > 0) {
      const dx = (pts[i][0] - pts[i - 1][0]) * kx;
      const dy = (pts[i][1] - pts[i - 1][1]) * ky;
      const len = Math.hypot(dx, dy);
      cum[i] = cum[i - 1] + len;
      ux[i - 1] = len > 0 ? dx / len : 0;
      uy[i - 1] = len > 0 ? dy / len : 1;
    }
  }
  const lengthM = cum[n - 1];
  if (!(lengthM > 1)) return null;
  const def = ROAD_CLASSES[w.cls];
  const total = w.lanes ?? (w.oneway ? def.lanes : def.lanes * 2);
  const perDir = w.oneway
    ? Math.max(1, Math.min(6, total))
    : Math.max(1, Math.min(4, Math.floor(total / 2)));
  const edge = {
    id,
    wayId: w.id,
    cls: w.cls,
    rank: w.rank,
    name: w.name,
    ref: w.ref,
    freeKmh: w.freeKmh,
    lanesFwd: w.oneway === -1 ? 0 : perDir,
    lanesBack: w.oneway === 1 ? 0 : perDir,
    oneway: w.oneway,
    lengthM,
    coords,
    cum,
    ux,
    uy,
    midLon: 0,
    midLat: 0,
    from: -1,
    to: -1,
    index: -1,
  };
  const mid = pointAt(edge, lengthM / 2, 0, { lon: 0, lat: 0, seg: 0, f: 0 });
  edge.midLon = mid.lon;
  edge.midLat = mid.lat;
  return edge;
}

/**
 * The point `d` metres along an edge (from its first vertex), into `out`
 * ({ lon, lat, seg }). `hint` is a segment index to search from (the last
 * answer for the same vehicle), so walking along an edge is O(1) per step.
 */
export function pointAt(edge, d, hint, out) {
  const { cum, coords } = edge;
  const last = cum.length - 1;
  let k = Math.max(0, Math.min(last - 1, hint | 0));
  while (k < last - 1 && d > cum[k + 1]) k += 1;
  while (k > 0 && d < cum[k]) k -= 1;
  const span = cum[k + 1] - cum[k];
  const f = span > 0 ? Math.max(0, Math.min(1, (d - cum[k]) / span)) : 0;
  out.lon = coords[k * 2] + (coords[k * 2 + 2] - coords[k * 2]) * f;
  out.lat = coords[k * 2 + 1] + (coords[k * 2 + 3] - coords[k * 2 + 1]) * f;
  out.seg = k;
  out.f = f;
  return out;
}

/** Local metres (east, north) of a lon/lat from the network origin. */
export function toLocal(net, lon, lat, out = { x: 0, y: 0 }) {
  out.x = (lon - net.origin.lon) * net.kx;
  out.y = (lat - net.origin.lat) * net.ky;
  return out;
}

// --- driving side -------------------------------------------------------------

// Rough boxes of the larger left-hand-traffic regions (lomin, lamin, lomax,
// lamax): Britain and Ireland, Japan, Australia and New Zealand, the Indian
// subcontinent, southern Africa, and maritime South-East Asia. Close enough to
// put simulated cars on the right side of the road for a picture.
const LEFT_HAND = [
  [-10.7, 49.8, 1.9, 60.9],
  [129.5, 30.9, 146, 45.6],
  [112.5, -44, 154, -10],
  [166, -47.5, 178.8, -34],
  [68, 6, 92.5, 35.5],
  [11.5, -35, 41, -16],
  [95, -11, 120.5, 7.5],
  [113.8, 22.1, 114.5, 22.6],
];

/** True where traffic keeps left (a rough lookup, see LEFT_HAND). */
export function keepsLeft(lat, lon) {
  return LEFT_HAND.some(([w, s, e, n]) => lon >= w && lon <= e && lat >= s && lat <= n);
}

/** A small stable hash of a string (seeds the simulation per view). */
export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
