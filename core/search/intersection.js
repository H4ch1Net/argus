// Street intersections: "Highway 111 and Golf Center pkway", "Jackson St &
// Indio Blvd", "corner of Monroe and Avenue 44". Place search (Photon,
// Nominatim) has no crossings, so the two streets are found as lines and
// crossed here: the road lines near the user come from the basemap's own
// vector tiles (OpenFreeMap, OpenMapTiles `transportation_name`, through the
// proxy; ./roadTiles.js), each side is matched by name or route number
// (./roads.js: "Highway 111" is the line with ref "CA 111 Old"), and the
// matched lines are intersected (segments that cross, or an end within 35 m
// of the other road where two ways meet at a node). When the tiles have
// nothing, Overpass is asked for the nodes two such ways share.
//
// Pure apart from the injected loaders: `loadRoads(near, ring, signal)` gives
// road lines { names, ref, network, coords: [[lat, lon], ...] }, and the
// proxy client (Overpass) is only used for the fallback. No Cesium: the
// terminal geocoder runs it too.

import {
  routeMatch,
  roadQuery,
  roadMatch,
  lineRoutes,
  routeLabel,
  looksLikeRoad,
  foldStreet,
  SPELLED,
} from './roads.js';

/**
 * Where two roads meet: an end this close to the other road counts. The
 * tiles' lines are simplified and break where a name stops, so a side street
 * can end short of the road it joins (Avenue 44 stops 23 m before Monroe
 * Street in the Oct 2026 tiles).
 */
export const MEET_M = 35;
/** Crossings closer than this are one junction (a divided road crosses twice). */
export const JUNCTION_M = 90;
export const OVERPASS_RADIUS_M = 8000;

// "A and B", "A & B", "A at B", "A / B", "A @ B", "A x B", "A + B".
const SEPARATORS = /\s*(?:&|@|\/|\+)\s*|\s+(?:and|at|x)\s+/gi;
const CORNER =
  /^(?:the\s+)?(?:corner|intersection|junction|crossing|crossroads)\s+(?:of\s+)?(.+)$/i;

/**
 * An intersection query, or null. `strong`: both sides read as streets (a
 * street word, a route, "corner of"), so it is meant as a crossing; else
 * (e.g. "Lord and Taylor", "Monroe and Avenue 44") it is tried too but kept
 * behind place results that match well. `where`: text after a comma ("...,
 * Indio"). The first separator that leaves two usable sides wins ("Avenue X
 * & Main St").
 * @returns {{ a: string, b: string, where: string, strong: boolean }|null}
 */
export function parseIntersection(query) {
  let q = String(query ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (q.length < 5 || q.length > 160) return null;
  const corner = CORNER.exec(q);
  if (corner) q = corner[1];
  // Plain numbers are not streets ("5 & 6"), but "Avenue 44" is; a side
  // never starts or ends with another separator.
  const ok = (s) => s.length >= 2 && /[a-z]/i.test(s) && !/^[&@/+]|[&@/+]$/.test(s);
  let first = null;
  for (const m of q.matchAll(SEPARATORS)) {
    if (m.index === 0) continue;
    const a = q.slice(0, m.index).trim();
    let b = q.slice(m.index + m[0].length).trim();
    let where = '';
    const comma = b.indexOf(',');
    if (comma >= 0) {
      where = b.slice(comma + 1).trim();
      b = b.slice(0, comma).trim();
    }
    if (!ok(a) || !ok(b)) continue;
    const strong = Boolean(corner) || (looksLikeRoad(a) && looksLikeRoad(b));
    // Two streets win over the first split ("Avenue X & Main St").
    if (strong) return { a, b, where, strong };
    first ??= { a, b, where, strong };
  }
  return first;
}

// ------------------------------------------------------------ geometry
const M_PER_DEG = 111_320;

/** A local plane in metres around `o` (good to a few tens of km). */
function plane(o) {
  const k = Math.cos((o.lat * Math.PI) / 180);
  return {
    to: ([lat, lon]) => [(lon - o.lon) * k * M_PER_DEG, (lat - o.lat) * M_PER_DEG],
    from: ([x, y]) => ({ lat: o.lat + y / M_PER_DEG, lon: o.lon + x / (k * M_PER_DEG) }),
  };
}

/** Where segment p1-p2 crosses q1-q2, or null. */
export function segmentCross(p1, p2, q1, q2) {
  const rx = p2[0] - p1[0];
  const ry = p2[1] - p1[1];
  const sx = q2[0] - q1[0];
  const sy = q2[1] - q1[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const qx = q1[0] - p1[0];
  const qy = q1[1] - p1[1];
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [p1[0] + t * rx, p1[1] + t * ry];
}

/** The nearest point of segment a-b to p, and its distance. */
function nearestOnSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2
    ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2))
    : 0;
  const q = [a[0] + t * dx, a[1] + t * dy];
  return { q, d: Math.hypot(p[0] - q[0], p[1] - q[1]) };
}

function bbox(pts, pad = 0) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}
const overlaps = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

/** Every point where polyline P meets polyline Q (crossing, or an end within MEET_M). */
export function polylineMeets(P, Q, meetM = MEET_M) {
  const out = [];
  if (P.length < 2 || Q.length < 2) return out;
  if (!overlaps(bbox(P, meetM), bbox(Q, meetM))) return out;
  for (let i = 1; i < P.length; i += 1)
    for (let j = 1; j < Q.length; j += 1) {
      const c = segmentCross(P[i - 1], P[i], Q[j - 1], Q[j]);
      if (c) out.push(c);
    }
  // Two ways that meet at a node end there: an end on (or by) the other road.
  for (const [end, other] of [
    [P[0], Q],
    [P[P.length - 1], Q],
    [Q[0], P],
    [Q[Q.length - 1], P],
  ]) {
    let best = null;
    for (let j = 1; j < other.length; j += 1) {
      const n = nearestOnSegment(end, other[j - 1], other[j]);
      if (n.d <= meetM && (!best || n.d < best.d)) best = n;
    }
    if (best) out.push([(end[0] + best.q[0]) / 2, (end[1] + best.q[1]) / 2]);
  }
  return out;
}

// ------------------------------------------------------------ matching

/** A road line from the tiles, readied: its routes and its names. */
function readyLine(l) {
  const names = [...new Set((l.names ?? []).filter((n) => typeof n === 'string' && n))];
  return { ...l, names, routes: lineRoutes({ ref: l.ref, network: l.network, names }) };
}

/** The name a side is shown by: the route as a sign says it, else the road's own name. */
function sideLabel(side, lines) {
  if (side.route) {
    // A variant that is another road (a business loop, an alternate) says
    // so; an old alignment keeps the name it is known by ("Highway 111").
    let best = 0;
    let qual = side.route.qual;
    for (const l of lines)
      for (const r of l.routes) {
        const m = routeMatch(side.route, r);
        if (m > best) [best, qual] = [m, r.qual];
      }
    const shown = qual && qual !== 'old' ? qual : side.route.qual;
    return routeLabel({ ...side.route, qual: shown }, side.text);
  }
  const counts = new Map();
  for (const l of lines)
    for (const n of l.names)
      if (roadMatchName(side, n)) counts.set(n, (counts.get(n) ?? 0) + 1);
  let best = '';
  let most = 0;
  for (const [n, c] of counts) if (c > most) [best, most] = [n, c];
  return best || titleCase(side.text);
}
const roadMatchName = (side, n) =>
  roadMatch({ ...side, route: null }, { names: [n] }) > 0;

function titleCase(s) {
  return foldStreet(s)
    .map((w) => {
      const full = SPELLED.get(w)?.[1] ?? w;
      return full.charAt(0).toUpperCase() + full.slice(1);
    })
    .join(' ');
}

/**
 * Where the roads named by `a` and `b` meet, nearest `near` first (the best
 * matches first when one is clearly better). Crossings within JUNCTION_M are
 * one junction (their middle).
 * @param {object[]} lines  road lines { names, ref, network, coords: [[lat, lon]...] }
 * @param {string} a
 * @param {string} b
 * @param {{ lat: number, lon: number }} near
 * @returns {Array<{ lat: number, lon: number, distM: number, score: number, a: string, b: string }>}
 */
export function findCrossings(lines, a, b, near, { partial = true, max = 3 } = {}) {
  const A = roadQuery(a);
  const B = roadQuery(b, { partial });
  const ready = (lines ?? [])
    .filter((l) => Array.isArray(l?.coords) && l.coords.length >= 2)
    .map(readyLine);
  const ma = [];
  const mb = [];
  for (const l of ready) {
    const sa = roadMatch(A, l);
    const sb = roadMatch(B, l);
    if (sa) ma.push({ l, s: sa });
    if (sb) mb.push({ l, s: sb });
  }
  if (!ma.length || !mb.length) return [];
  const pl = plane(near);
  const xy = new Map();
  const pts = (l) => {
    if (!xy.has(l)) xy.set(l, l.coords.map(pl.to));
    return xy.get(l);
  };
  const hits = [];
  for (const x of ma)
    for (const y of mb) {
      if (x.l === y.l) continue;
      for (const p of polylineMeets(pts(x.l), pts(y.l)))
        hits.push({ p, score: x.s * y.s, la: x.l, lb: y.l });
    }
  if (!hits.length) return [];
  // One junction per cluster: the best score, the middle of its points.
  hits.sort((h, k) => Math.hypot(...h.p) - Math.hypot(...k.p));
  const groups = [];
  for (const h of hits) {
    const g = groups.find(
      (c) => Math.hypot(c.x / c.n - h.p[0], c.y / c.n - h.p[1]) <= JUNCTION_M,
    );
    if (g) {
      g.x += h.p[0];
      g.y += h.p[1];
      g.n += 1;
      g.score = Math.max(g.score, h.score);
      g.la.add(h.la);
      g.lb.add(h.lb);
    } else
      groups.push({
        x: h.p[0],
        y: h.p[1],
        n: 1,
        score: h.score,
        la: new Set([h.la]),
        lb: new Set([h.lb]),
      });
  }
  const out = groups.map((g) => {
    const p = [g.x / g.n, g.y / g.n];
    const ll = pl.from(p);
    const distM = Math.hypot(...p);
    return {
      lat: ll.lat,
      lon: ll.lon,
      distM,
      score: g.score,
      a: sideLabel(A, [...g.la]),
      b: sideLabel(B, [...g.lb]),
      // Rank: the match, less a little for distance (a far exact crossing
      // still loses to a near one that is the same road under another ref).
      rank: g.score - 0.3 * Math.min(1, distM / 10_000),
    };
  });
  out.sort((x, y) => y.rank - x.rank || x.distM - y.distM);
  // A crossing of the road itself hides the near misses (I-10 against its
  // business loop): only matches about as good as the best stay.
  const top = Math.max(...out.map((c) => c.score));
  return out
    .filter((c) => c.score >= top - 0.15)
    .slice(0, max)
    .map(({ rank: _r, ...c }) => c);
}

// ------------------------------------------------------------ Overpass

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A POSIX regex for a typed street name: every spelling of each street word. */
export function nameRegex(text) {
  const w = foldStreet(text);
  if (!w.length) return null;
  const parts = w.map((t) => {
    const all = SPELLED.get(t);
    return all ? `(${all.map(escapeRe).join('|')})` : escapeRe(t);
  });
  // An optional direction first, and a street word after when none was typed.
  const tail = STREET_TYPE_RE_SET.has(w[w.length - 1]) ? '' : '( [a-z]+)?';
  return `^((north|south|east|west|n|s|e|w) )?${parts.join(' ')}${tail}$`;
}
const STREET_TYPE_RE_SET = new Set([
  'st',
  'ave',
  'blvd',
  'rd',
  'dr',
  'ln',
  'ct',
  'pl',
  'pkwy',
  'hwy',
  'fwy',
  'expy',
  'tpke',
  'ter',
  'cir',
  'trl',
  'way',
]);

/** A POSIX regex for a route number in a ref ("CA 111", "I 10;US 99"). */
export function refRegex(route) {
  const n = escapeRe(route.num);
  const pre =
    { I: '(I|IH|Interstate)', US: 'US', SR: '[A-Z]{1,2}', CR: '(CR|County Road)' }[
      route.type
    ] ?? '[A-Z]*';
  return `(^|;) *${pre}[- ]*${n}([^0-9]|$)`;
}

function wayFilter(side, around) {
  const sel = [];
  const rq = roadQuery(side);
  if (rq.route) sel.push(`way${around}["highway"]["ref"~"${refRegex(rq.route)}",i];`);
  const nr = nameRegex(side);
  if (nr && !rq.route) sel.push(`way${around}["highway"]["name"~"${nr}",i];`);
  if (rq.route) sel.push(`way${around}["highway"]["name"~"${nameRegex(side)}",i];`);
  return `(${sel.join('')})`;
}

/** Overpass QL: the nodes that ways named A and B share, around a point. */
export function overpassIntersectionQuery(a, b, near, radiusM = OVERPASS_RADIUS_M) {
  const around = `(around:${Math.round(radiusM)},${near.lat.toFixed(5)},${near.lon.toFixed(5)})`;
  return (
    `[out:json][timeout:20];${wayFilter(a, around)}->.a;${wayFilter(b, around)}->.b;` +
    `node(w.a)(w.b);out 20;`
  );
}

/** Overpass nodes -> crossings nearest `near` first (one per junction). */
export function parseOverpassNodes(json, near, a, b) {
  const pl = plane(near);
  const nodes = (Array.isArray(json?.elements) ? json.elements : [])
    .filter((e) => e?.type === 'node' && Number.isFinite(e.lat) && Number.isFinite(e.lon))
    .map((e) => ({ lat: e.lat, lon: e.lon, p: pl.to([e.lat, e.lon]) }))
    .sort((x, y) => Math.hypot(...x.p) - Math.hypot(...y.p));
  const out = [];
  for (const n of nodes) {
    const seen = out.some(
      (o) => Math.hypot(o.p[0] - n.p[0], o.p[1] - n.p[1]) <= JUNCTION_M,
    );
    if (!seen) out.push(n);
  }
  return out.slice(0, 3).map((n) => ({
    lat: n.lat,
    lon: n.lon,
    distM: Math.hypot(...n.p),
    score: 1,
    a: labelOf(a),
    b: labelOf(b),
  }));
}
const labelOf = (side) => {
  const q = roadQuery(side);
  return q.route ? routeLabel(q.route, side) : titleCase(side);
};

// ------------------------------------------------------------ the search

/**
 * Find where the two streets of a parsed intersection meet near `near`:
 * the tiles first, ring by ring around the point (3x3, 5x5, 7x7 tiles,
 * about 6, 10 and 14 km across at z14), stopping at the first ring with a
 * crossing; then Overpass when the tiles could not be read, or when the
 * query is a clear intersection (both sides streets) the tiles did not
 * resolve or could not be read.
 * @param {{ a: string, b: string, strong: boolean }} parsed  parseIntersection()
 * @param {{ near: {lat:number, lon:number}, loadRoads?: Function|null,
 *   proxyClient?: { getJson: Function }|null, signal?: AbortSignal,
 *   rings?: number[], overpass?: boolean }} opts
 */
export async function lookupIntersection(
  parsed,
  {
    near,
    loadRoads = null,
    proxyClient = null,
    signal,
    rings = [1, 2, 3],
    overpass = true,
  },
) {
  if (!parsed || !near || !Number.isFinite(near.lat) || !Number.isFinite(near.lon))
    return [];
  if (loadRoads) {
    for (const ring of rings) {
      let lines;
      try {
        lines = await loadRoads(near, ring, signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        break; // the tiles cannot be read: Overpass below
      }
      if (signal?.aborted) throw abortError();
      const found = findCrossings(lines, parsed.a, parsed.b, near);
      if (found.length) return found.map((c) => ({ ...c, source: 'tiles' }));
    }
  }
  // Overpass is slow and budgeted: only for a clear intersection (both sides
  // streets), never for a name with "and" in it.
  if (!overpass || !proxyClient || !parsed.strong) return [];
  const json = await proxyClient.getJson('overpass', '/interpreter', {
    params: { data: overpassIntersectionQuery(parsed.a, parsed.b, near) },
    signal,
  });
  return parseOverpassNodes(json, near, parsed.a, parsed.b).map((c) => ({
    ...c,
    source: 'overpass',
  }));
}

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

/**
 * A crossing as a Place for the search lists: "Highway 111 & Golf Center
 * Parkway", where it is (`where`: "Indio, California"), kind 'intersection'.
 */
export function crossingPlace(c, where = '') {
  return {
    id: `x:${c.lat.toFixed(5)},${c.lon.toFixed(5)}`,
    name: `${c.a} & ${c.b}`,
    detail: where,
    lat: Number(c.lat.toFixed(6)),
    lon: Number(c.lon.toFixed(6)),
    kind: 'intersection',
  };
}
