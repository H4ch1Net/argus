// Live congestion for the simulated traffic: TomTom Traffic Flow Segment Data
// (Traffic API v4, flowSegmentData) through the proxy's pinned 'tomtom-flowseg'
// feed, which adds TOMTOM_API_KEY server side and budgets it. Pure: no Cesium,
// no network (the source does the fetching), shared with the terminal.
//
// One request returns the road segment nearest a point: its current and
// free-flow speed (km/h), travel times, a confidence and the segment's own
// geometry. The layer samples a budgeted handful of points per view (bigger
// roads first, spread out), matches each returned segment back onto the OSM
// edges it runs along, and lets roads of the same class nearby inherit the
// median measured ratio (marked as inferred). Response shape per TomTom's
// documentation (Traffic Flow Segment Data, version 4); not live-tested here
// (no key in the build environment).

import { toLocal } from './roads.js';

/** Zoom levels the proxy feed allows (TomTom's road-coverage detail). */
export const FLOW_ZOOMS = [10, 12, 14, 16];
/** Points sampled per view change, by capability tier. */
export const FLOW_BUDGET = { minimal: 3, balanced: 5, full: 8 };
export const FLOW_TTL_MS = 2 * 60_000;
export const TOMTOM_FLOW_CREDIT = 'Traffic flow © TomTom';

/** The flowSegmentData sub-path for a road rank (bigger roads at lower zoom). */
export function flowSegmentPath(rank = 3) {
  const zoom = rank <= 1 ? 12 : rank <= 3 ? 14 : 16;
  return `/flowSegmentData/absolute/${zoom}/json`;
}

/** Query params for a point: "lat,lon" at 5 decimals (about a metre). */
export function flowQuery(lat, lon) {
  return { point: `${lat.toFixed(5)},${lon.toFixed(5)}`, unit: 'KMPH' };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * TomTom flowSegmentData JSON -> { frc, currentKmh, freeKmh, ratio,
 * currentTravelTimeS, freeTravelTimeS, confidence, closed, coords:[[lon, lat]] },
 * or null when the answer has no usable segment.
 */
export function parseFlowSegment(json) {
  const d = json?.flowSegmentData;
  if (!d || typeof d !== 'object') return null;
  const current = num(d.currentSpeed);
  const free = num(d.freeFlowSpeed);
  const raw = d.coordinates?.coordinate;
  const coords = [];
  for (const c of Array.isArray(raw) ? raw : []) {
    if (num(c?.latitude) !== null && num(c?.longitude) !== null)
      coords.push([c.longitude, c.latitude]);
  }
  if (current === null || free === null || !(free > 0) || coords.length < 2) return null;
  const closed = d.roadClosure === true;
  return {
    frc: typeof d.frc === 'string' ? d.frc : null,
    currentKmh: current,
    freeKmh: free,
    ratio: closed ? 0 : Math.max(0, Math.min(1, current / free)),
    currentTravelTimeS: num(d.currentTravelTime),
    freeTravelTimeS: num(d.freeFlowTravelTime),
    confidence: num(d.confidence),
    closed,
    coords,
  };
}

/** Congestion level for a ratio: 'free' | 'slow' | 'jam' | 'closed'. */
export function congestionLevel(ratio) {
  if (!Number.isFinite(ratio)) return null;
  if (ratio <= 0.02) return 'closed';
  if (ratio < 0.45) return 'jam';
  if (ratio < 0.75) return 'slow';
  return 'free';
}

/**
 * Where to sample: up to `budget` points on the bigger roads near the focus
 * (tertiary and up), largest class first, then longer and nearer, at least
 * `spacingM` apart, skipping edges a recent segment already covers.
 * @param {object} net  roads.js buildNetwork result
 * @param {{ focus: {lat:number, lon:number}, radiusM: number, budget: number,
 *   covered?: (edge: object) => boolean, spacingM?: number }} opts
 * @returns {{ lat: number, lon: number, rank: number, edge: string }[]}
 */
export function planFlowSamples(
  net,
  { focus, radiusM, budget, covered, spacingM = 300 },
) {
  if (!net || !(budget > 0)) return [];
  const f = toLocal(net, focus.lon, focus.lat, { x: 0, y: 0 });
  const p = { x: 0, y: 0 };
  const cands = [];
  for (const e of net.edges) {
    if (e.rank > 4 || e.lengthM < 60) continue;
    toLocal(net, e.midLon, e.midLat, p);
    const dist = Math.hypot(p.x - f.x, p.y - f.y);
    if (dist > radiusM) continue;
    if (covered?.(e)) continue;
    cands.push({ e, x: p.x, y: p.y, dist });
  }
  cands.sort(
    (a, b) =>
      a.e.rank - b.e.rank ||
      Math.min(b.e.lengthM, 600) - Math.min(a.e.lengthM, 600) ||
      a.dist - b.dist,
  );
  const picked = [];
  for (const c of cands) {
    if (picked.length >= budget) break;
    if (picked.some((q) => Math.hypot(q.x - c.x, q.y - c.y) < spacingM)) continue;
    picked.push(c);
  }
  return picked.map((c) => ({
    lat: Math.round(c.e.midLat * 1e5) / 1e5,
    lon: Math.round(c.e.midLon * 1e5) / 1e5,
    rank: c.e.rank,
    edge: c.e.id,
  }));
}

/** Distance (m) from point p to segment ab, all in local metres. */
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t =
    len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return {
    d: Math.hypot(px - (ax + dx * t), py - (ay + dy * t)),
    dx,
    dy,
    len: Math.sqrt(len2),
  };
}

/**
 * The OSM edges a TomTom segment runs along: an edge matches when its
 * midpoint lies within `maxDistM` of the segment's polyline and it runs
 * parallel to it there (either direction), so cross streets never inherit it.
 * @returns {number[]} edge indices
 */
export function matchSegment(net, seg, { maxDistM = 18, minCos = 0.8 } = {}) {
  if (!net || !seg?.coords?.length) return [];
  const pts = seg.coords.map(([lon, lat]) => toLocal(net, lon, lat, { x: 0, y: 0 }));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const q of pts) {
    minX = Math.min(minX, q.x);
    minY = Math.min(minY, q.y);
    maxX = Math.max(maxX, q.x);
    maxY = Math.max(maxY, q.y);
  }
  const out = [];
  const m = { x: 0, y: 0 };
  for (const e of net.edges) {
    toLocal(net, e.midLon, e.midLat, m);
    if (m.x < minX - maxDistM || m.x > maxX + maxDistM) continue;
    if (m.y < minY - maxDistM || m.y > maxY + maxDistM) continue;
    let best = null;
    for (let i = 1; i < pts.length; i += 1) {
      const r = distToSeg(m.x, m.y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y);
      if (!best || r.d < best.d) best = r;
    }
    if (!best || best.d > maxDistM || !(best.len > 0)) continue;
    // The edge's own direction at its midpoint (its middle segment).
    const k = Math.min(e.ux.length - 1, Math.max(0, Math.floor((e.ux.length - 1) / 2)));
    const cos = Math.abs((e.ux[k] * best.dx + e.uy[k] * best.dy) / best.len);
    if (cos >= minCos) out.push(e.index);
  }
  return out;
}

const RANK_GROUP = (rank) => (rank <= 1 ? 0 : rank <= 2 ? 1 : rank <= 3 ? 2 : 3);

/**
 * Per-edge flow for a network from measured segments: each matched edge gets
 * the segment's ratio and free-flow speed (measured), and every other edge of
 * a measured class group gets that group's median ratio (inferred).
 * @param {object} net
 * @param {{ seg: object, edges: number[] }[]} matches
 * @returns {{ byEdge: Map<string, { ratio: number, freeKmh?: number, currentKmh?: number,
 *   measured: boolean, closed?: boolean }>, measured: number, inferred: number }}
 */
export function flowForNetwork(net, matches) {
  const byEdge = new Map();
  const groups = [[], [], [], []];
  for (const { seg, edges } of matches) {
    for (const idx of edges) {
      const e = net.edges[idx];
      if (!e || byEdge.has(e.id)) continue;
      byEdge.set(e.id, {
        ratio: seg.ratio,
        freeKmh: seg.freeKmh,
        currentKmh: seg.currentKmh,
        measured: true,
        closed: seg.closed,
      });
      groups[RANK_GROUP(e.rank)].push(seg.ratio);
    }
  }
  const median = groups.map((g) => {
    if (!g.length) return null;
    const s = [...g].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  });
  const measured = byEdge.size;
  let inferred = 0;
  for (const e of net.edges) {
    if (byEdge.has(e.id)) continue;
    const r = median[RANK_GROUP(e.rank)];
    if (r == null) continue;
    byEdge.set(e.id, { ratio: r, measured: false });
    inferred += 1;
  }
  return { byEdge, measured, inferred };
}

/** A one-line readout for a flow segment: "34 / 52 KM/H (65%)". */
export function formatFlowReadout(seg, units = 'metric') {
  if (!seg) return 'NO FLOW DATA';
  if (seg.closed) return 'ROAD CLOSED';
  const k = units === 'imperial' ? 1 / 1.609344 : 1;
  const u = units === 'imperial' ? 'MPH' : 'KM/H';
  return `${Math.round(seg.currentKmh * k)} / ${Math.round(seg.freeKmh * k)} ${u} (${Math.round(seg.ratio * 100)}%)`;
}
