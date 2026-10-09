// Traffic signals along a route: OpenStreetMap highway=traffic_signals nodes
// within 15 m of the route line, counted per intersection, with an expected
// delay. Pure apart from the injected fetch: the terminal and the car share it.
//
// Fetching: the route corridor is cut into fixed 0.02 degree tiles (about 2 km)
// and the tiles no one has asked for yet are fetched through the proxy's
// 'overpass' feed, up to 12 tiles per query (one union of bboxes, `out skel`:
// ids and coordinates only). Each tile's nodes are kept for six hours, so a
// reroute, an alternative or the trip back reuses them without a request.
//
// Counting: OSM often maps one signal node per approach (two to four at one
// junction, 40 m apart across a wide boulevard), so nodes whose positions along
// the route are within 40 m of each other count as one signal.
//
// Delay assumption (documented, not measured): an urban signal runs a cycle of
// about 90 s with about half of it red for the road being driven. A vehicle
// arriving at a random moment meets red half the time and then waits on
// average half the red phase (about 22 s), plus a few seconds to stop and pull
// away: about 12 s per signal on average when driving. Bikes are similar (10 s);
// on foot only some of the signals passed are crossings (8 s). Routers'
// travel times already include a little of this (OSRM's car profile adds 2 s
// per signal), so the estimate leans long by about that much. TomTom's
// traffic-aware times come from measured speeds, which include signal waits,
// so a TomTom route with traffic gets no added signal delay (the count is
// still shown).

import { cumulative, haversineM } from './geo.js';

export const SIGNAL_TILE_DEG = 0.02;
export const SIGNAL_RADIUS_M = 15;
export const SIGNAL_MERGE_M = 40;
export const SIGNAL_TILES_PER_QUERY = 12;
/** Past this many tiles (a long trip), only the first and last stretches are counted. */
export const SIGNAL_MAX_TILES = 48;
export const SIGNAL_TTL_MS = 6 * 60 * 60 * 1000;
export const SIGNAL_DELAY_S = Object.freeze({ drive: 12, bike: 10, walk: 8 });

const RAD = Math.PI / 180;
const M_PER_DEG = 111_195;

/** Expected seconds lost per signal for a route (0 when its times already include them). */
export function perSignalDelayS(route) {
  if (route?.provider === 'tomtom' && Number.isFinite(route?.trafficDelayS)) return 0;
  return SIGNAL_DELAY_S[route?.mode] ?? SIGNAL_DELAY_S.drive;
}

const tileOf = (deg) => Math.floor(deg / SIGNAL_TILE_DEG);
export const tileKey = (ty, tx) => `${ty}:${tx}`;

/** [south, west, north, east] of a tile key. */
export function tileBounds(key) {
  const [ty, tx] = key.split(':').map(Number);
  const s = Number((ty * SIGNAL_TILE_DEG).toFixed(6));
  const w = Number((tx * SIGNAL_TILE_DEG).toFixed(6));
  return [
    s,
    w,
    Number((s + SIGNAL_TILE_DEG).toFixed(6)),
    Number((w + SIGNAL_TILE_DEG).toFixed(6)),
  ];
}

/**
 * The tiles a route's corridor (the line plus `padM` either side) touches, in
 * route order. Samples every 100 m along each segment.
 */
export function tilesForLine(line, padM = SIGNAL_RADIUS_M) {
  const keys = new Set();
  const add = (lat, lon) => {
    const dLat = padM / M_PER_DEG;
    const dLon = padM / (M_PER_DEG * Math.max(0.05, Math.cos(lat * RAD)));
    for (const la of [lat - dLat, lat + dLat])
      for (const lo of [lon - dLon, lon + dLon])
        keys.add(tileKey(tileOf(la), tileOf(lo)));
  };
  for (let i = 0; i < line.length; i += 1) {
    const [lon, lat] = line[i];
    add(lat, lon);
    if (i + 1 < line.length) {
      const [lon2, lat2] = line[i + 1];
      const n = Math.floor(haversineM(lat, lon, lat2, lon2) / 100);
      for (let k = 1; k <= n; k += 1) {
        const t = k / (n + 1);
        add(lat + (lat2 - lat) * t, lon + (lon2 - lon) * t);
      }
    }
  }
  return [...keys];
}

/** One Overpass QL query for the signal nodes in these tiles. */
export function signalsQuery(keys) {
  const parts = keys.map(
    (k) => `node["highway"="traffic_signals"](${tileBounds(k).join(',')});`,
  );
  return `[out:json][timeout:25];(${parts.join('')});out skel;`;
}

/** Overpass answer -> [[lat, lon], ...] signal nodes. */
export function parseSignalNodes(json) {
  const out = [];
  for (const e of Array.isArray(json?.elements) ? json.elements : []) {
    if (e?.type !== 'node') continue;
    const lat = Number(e.lat);
    const lon = Number(e.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) out.push([lat, lon]);
  }
  return out;
}

/**
 * Positions along the route (metres from its start) of the signals within
 * `radiusM` of the line, one per junction (nodes within `mergeM` along the
 * route merge). Nodes are bucketed in 0.002 degree cells so each segment only
 * looks at the nodes near it.
 * @param {Array<[number, number]>} line [lon, lat]
 * @param {Array<[number, number]>} nodes [lat, lon]
 * @returns {number[]} sorted along-route metres
 */
export function signalsAlong(
  line,
  nodes,
  { radiusM = SIGNAL_RADIUS_M, mergeM = SIGNAL_MERGE_M, cum = cumulative(line) } = {},
) {
  if (line.length < 2 || !nodes.length) return [];
  const CELL = 0.002;
  const cells = new Map();
  for (let i = 0; i < nodes.length; i += 1) {
    const key = `${Math.floor(nodes[i][0] / CELL)}:${Math.floor(nodes[i][1] / CELL)}`;
    let list = cells.get(key);
    if (!list) cells.set(key, (list = []));
    list.push(i);
  }
  const best = new Float64Array(nodes.length).fill(Infinity);
  const along = new Float64Array(nodes.length);
  for (let s = 0; s + 1 < line.length; s += 1) {
    const [lon1, lat1] = line[s];
    const [lon2, lat2] = line[s + 1];
    const pad = radiusM / M_PER_DEG;
    const padLon = pad / Math.max(0.05, Math.cos(lat1 * RAD));
    const y0 = Math.floor((Math.min(lat1, lat2) - pad) / CELL);
    const y1 = Math.floor((Math.max(lat1, lat2) + pad) / CELL);
    const x0 = Math.floor((Math.min(lon1, lon2) - padLon) / CELL);
    const x1 = Math.floor((Math.max(lon1, lon2) + padLon) / CELL);
    if ((y1 - y0 + 1) * (x1 - x0 + 1) > 400) continue; // a degenerate, huge segment
    const k = Math.cos(lat1 * RAD) * M_PER_DEG;
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const list = cells.get(`${y}:${x}`);
        if (!list) continue;
        for (const i of list) {
          const [plat, plon] = nodes[i];
          const ax = (lon1 - plon) * k;
          const ay = (lat1 - plat) * M_PER_DEG;
          const dx = (lon2 - lon1) * k;
          const dy = (lat2 - lat1) * M_PER_DEG;
          const len2 = dx * dx + dy * dy;
          let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const d = Math.hypot(ax + dx * t, ay + dy * t);
          if (d <= radiusM && d < best[i]) {
            best[i] = d;
            along[i] = cum[s] + (cum[s + 1] - cum[s]) * t;
          }
        }
      }
    }
  }
  const hits = [];
  for (let i = 0; i < nodes.length; i += 1) if (best[i] <= radiusM) hits.push(along[i]);
  hits.sort((a, b) => a - b);
  const merged = [];
  for (const a of hits) {
    if (!merged.length || a - merged[merged.length - 1] > mergeM) merged.push(a);
  }
  return merged.map((a) => Math.round(a));
}

/**
 * A tile cache over the proxy: `nodesFor(keys)` returns the signal nodes in
 * those tiles, fetching the missing ones (12 tiles per query).
 * @param {{ fetchJson: (ql: string) => Promise<object>, now?: () => number,
 *   ttlMs?: number, maxTiles?: number }} opts
 */
export function createSignalCache({
  fetchJson,
  now = () => Date.now(),
  ttlMs = SIGNAL_TTL_MS,
  maxTiles = 800,
}) {
  const tiles = new Map(); // key -> { at, nodes }
  const inflight = new Map(); // key -> Promise
  const fresh = (k) => {
    const t = tiles.get(k);
    return t && now() - t.at < ttlMs ? t : null;
  };
  async function fetchChunk(keys) {
    const json = await fetchJson(signalsQuery(keys));
    // Overpass reports overload as 200 with a remark and no elements: a failure.
    if (json?.remark && !json.elements?.length)
      throw new Error(`Overpass: ${String(json.remark).slice(0, 120)}`);
    const byTile = new Map(keys.map((k) => [k, []]));
    for (const n of parseSignalNodes(json)) {
      const k = tileKey(tileOf(n[0]), tileOf(n[1]));
      byTile.get(k)?.push(n);
    }
    const at = now();
    for (const [k, nodes] of byTile) {
      tiles.delete(k);
      tiles.set(k, { at, nodes });
    }
    while (tiles.size > maxTiles) tiles.delete(tiles.keys().next().value);
  }
  return {
    /** @param {string[]} keys */
    async nodesFor(keys) {
      const missing = keys.filter((k) => !fresh(k) && !inflight.has(k));
      for (let i = 0; i < missing.length; i += SIGNAL_TILES_PER_QUERY) {
        const chunk = missing.slice(i, i + SIGNAL_TILES_PER_QUERY);
        const p = fetchChunk(chunk).finally(() =>
          chunk.forEach((k) => inflight.delete(k)),
        );
        chunk.forEach((k) => inflight.set(k, p));
      }
      await Promise.all(keys.map((k) => inflight.get(k)).filter(Boolean));
      const out = [];
      for (const k of keys) for (const n of fresh(k)?.nodes ?? []) out.push(n);
      return out;
    },
    size: () => tiles.size,
  };
}

/**
 * Count the signals on a route and fill in route.signals, route.signalDelayS
 * and route.signalsAlongM (sorted metres from the start, for signals ahead).
 * A trip touching more than SIGNAL_MAX_TILES tiles counts only its first and
 * last stretches (where towns are) and says so in route.warnings.
 */
export async function annotateSignals(route, cache) {
  const all = tilesForLine(route.geometry);
  let keys = all;
  let partial = false;
  if (all.length > SIGNAL_MAX_TILES) {
    const half = SIGNAL_MAX_TILES / 2;
    keys = [...all.slice(0, half), ...all.slice(-half)];
    partial = true;
  }
  const nodes = await cache.nodesFor(keys);
  const along = signalsAlong(route.geometry, nodes);
  route.signals = along.length;
  route.signalDelayS = Math.round(along.length * perSignalDelayS(route));
  route.signalsAlongM = along;
  if (partial)
    route.warnings = [
      ...(route.warnings ?? []),
      'SIGNALS COUNTED NEAR START AND END ONLY',
    ];
  return route;
}
