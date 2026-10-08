// The terminal map's coastlines.
//
// Natural Earth land outlines (public domain, packaged as TopoJSON by the
// world-atlas project) are fetched once through the proxy's `basemap` feed and
// cached under ~/.cache/argus, so later launches work offline. Until that has
// happened (first launch, or no network) a coarse built-in outline is used. Two
// detail levels: 110m for wide views, 50m once zoomed in.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WORLD_OUTLINE } from './data/worldOutline.js';

export const WORLD_ATLAS = 'world-atlas@2.0.2';

function boundsOf(points) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [, lat] of points) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLat, maxLat };
}

function polyline(points) {
  return { points, ...boundsOf(points) };
}

/** The built-in outline as polylines of [lon, lat] points. */
export function builtinBasemap() {
  const lines = WORLD_OUTLINE.map((ring) => {
    const flat = Array.isArray(ring) ? ring : ring.points;
    const pts = [];
    for (let i = 0; i + 1 < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
    return polyline(pts);
  });
  return { source: 'built-in outline', detail: 'coarse', lines };
}

/**
 * Decode every arc of a TopoJSON topology into [lon, lat] polylines. Drawing arcs
 * (rather than rebuilding polygons) draws each shared edge once, which is all a
 * coastline map needs.
 */
export function decodeTopologyArcs(topo) {
  if (!topo || topo.type !== 'Topology' || !Array.isArray(topo.arcs)) {
    throw new Error('not a TopoJSON topology');
  }
  const t = topo.transform;
  const lines = [];
  for (const arc of topo.arcs) {
    const pts = [];
    let x = 0;
    let y = 0;
    for (const p of arc) {
      if (t) {
        x += p[0];
        y += p[1];
        pts.push([x * t.scale[0] + t.translate[0], y * t.scale[1] + t.translate[1]]);
      } else {
        pts.push([p[0], p[1]]);
      }
    }
    if (pts.length > 1) lines.push(polyline(pts));
  }
  return lines;
}

export function cacheDir(env = process.env) {
  const base = env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'argus');
}

/**
 * Load Natural Earth land at a detail level: from the cache, or through the proxy
 * (then cached). Returns null when neither works, so the caller keeps whatever
 * basemap it has.
 * @param {{ client?: object|null, detail?: '110m'|'50m', dir?: string, signal?: AbortSignal }} opts
 */
export async function loadNaturalEarth({
  client = null,
  detail = '110m',
  dir = cacheDir(),
  signal,
} = {}) {
  const file = path.join(dir, `land-${detail}.json`);
  let topo = null;
  try {
    topo = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // not cached yet
  }
  if (!topo && client) {
    try {
      topo = await client.getJson('basemap', `/npm/${WORLD_ATLAS}/land-${detail}.json`, {
        signal,
      });
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(topo));
      } catch {
        // read-only cache dir: use it this session only
      }
    } catch {
      return null;
    }
  }
  if (!topo) return null;
  try {
    return {
      source: `Natural Earth ${detail}`,
      detail,
      lines: decodeTopologyArcs(topo),
    };
  } catch {
    return null;
  }
}

/** Graticule spacing (degrees) giving a handful of lines across `spanDeg`. */
export function graticuleStep(spanDeg) {
  for (const step of [30, 15, 10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.02, 0.01]) {
    if (spanDeg / step >= 3) return step;
  }
  return 0.01;
}
