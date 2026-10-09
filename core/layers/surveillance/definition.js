import {
  normalizeSurveillance,
  SURVEILLANCE_TILE_DEG,
  SURVEILLANCE_TTL_MS,
} from './parse.js';
import { describeSurveillance, surveillanceSearchText } from './format.js';
import { SURVEILLANCE_KINDS, ENFORCEMENT_KINDS } from './kinds.js';
import { selectScope, scopeNote, NEAREST_DEFAULT } from './select.js';
import { SURVEILLANCE_MAX_TILES } from './source.js';
import { tiledNote } from '../overpass/tiles.js';
import { ink } from '../sdk/colors.js';
import { groundDecorations } from './groundBatch.js';
import {
  cameraCones,
  sectorDegrees,
  circleDegrees,
  coneScale,
  CONE_CAP,
} from './cones.js';

// The "eyes": surveillance and enforcement devices mapped in OpenStreetMap
// (cameras by type, ALPR readers incl. DeFlock's mapping, acoustic gunshot
// sensors, guard posts, speed / average-speed / red-light cameras), as a
// static point layer fetched once per tile (./source.js) and kept for hours.
// GUARDRAIL: locations only, never a reading of what the equipment sees. Each
// kind has its own ctOS glyph (./kinds.js, core/ui/glyphs.js).
//
// What is drawn (select): by default the NEAREST n (60) to the middle of the
// view, or to your own position while the view follows you; or ALL IN VIEW
// (VIEW > SURVEILLANCE), capped nearest first. `scope` supplies the mode, the
// anchor and the view; select() runs on every ingest, so a pan, a refresh or a
// mode change re-picks from the tiles already held without a new request.
//
// View cones: each camera mapped with a direction gets a translucent sector on
// the ground showing which side it faces (core/layers/surveillance/cones.js);
// one without a direction gets a faint ring. All cones of the layer are ONE
// batched ground primitive plus one outline primitive (groundBatch.js), rebuilt
// when the record set changes, never per frame; at most CONE_CAP cones (the
// nearest to the camera), enlarged in coarse bands when zoomed out, hidden above
// 25 km. The minimal tier keeps the outlines and drops the fill.

const minimalTier = (scene) => (scene?.globe?.maximumScreenSpaceError ?? 2) >= 4;

const coneInk = (s) =>
  s.alpr ? 'white' : ENFORCEMENT_KINDS.has(s.kind) ? 'pale' : 'gray';

/**
 * @param {{ tier?: string, scope?: {
 *   mode?: () => 'nearest'|'all',
 *   anchor?: () => ({ lat: number, lon: number })|null,
 *   view?: () => ({ lamin: number, lomin: number, lamax: number, lomax: number })|null,
 *   nearest?: number } }} [opts]
 *   tier: the capability tier; without one, the minimal tier is recognised from
 *   the globe's screen-space error (4 there). scope: see above; without one
 *   the layer draws everything it holds (capped).
 */
export function createSurveillanceDefinition({ tier, scope } = {}) {
  let fillOn = null; // decided on the first build
  let lastSel = null;
  const maxEntities = tier === 'minimal' ? 2000 : 4000;
  // One shared style object per kind: style() allocates nothing per fix.
  const styles = Object.fromEntries(
    Object.entries(SURVEILLANCE_KINDS).map(([k, v]) => [
      k,
      { glyph: v.glyph, pixelSize: v.px, color: ink(v.ink, v.ink === 'gray' ? 0.9 : 1) },
    ]),
  );
  const cones = groundDecorations({
    scaleFor: coneScale,
    collect: (records, { scale, center }) => {
      const specs = [];
      for (const n of records.values()) {
        const s = cameraCones(n);
        if (s) specs.push(s);
      }
      if (specs.length * 1.2 > CONE_CAP) {
        const cosLat = Math.cos((center.lat * Math.PI) / 180);
        const d2 = (s) =>
          ((s.lon - center.lon) * cosLat) ** 2 + (s.lat - center.lat) ** 2;
        specs.sort((a, b) => d2(a) - d2(b));
      }
      const fills = [];
      const lines = [];
      let count = 0;
      for (const s of specs) {
        if (count >= CONE_CAP) break;
        const range = s.rangeM * scale;
        const c = coneInk(s);
        if (s.ring) {
          count += 1;
          lines.push({
            path: circleDegrees(s.lon, s.lat, range),
            color: ink(c, 0.22),
            width: 1,
            loop: true,
          });
          continue;
        }
        for (const cone of s.cones) {
          count += 1;
          const ring = sectorDegrees(s.lon, s.lat, cone.headingDeg, cone.fovDeg, range);
          if (fillOn) fills.push({ ring, color: ink(c, 0.13) });
          lines.push({
            path: ring,
            color: ink(c, c === 'gray' ? 0.5 : 0.75),
            width: c === 'gray' ? 1.2 : 1.6,
            loop: true,
          });
        }
      }
      return { fills, lines };
    },
  });

  return {
    id: 'surveillance',
    // Fetched once per tile and kept (the Layer SDK's tile cache when it has
    // one; ./source.js keeps its own tiles too, so the layer works either way).
    fetch: {
      mode: 'viewport',
      tileCache: {
        tileDeg: SURVEILLANCE_TILE_DEG,
        ttlMs: SURVEILLANCE_TTL_MS,
        maxTiles: SURVEILLANCE_MAX_TILES,
      },
    },
    // In NEAREST mode the source loads only the tiles around the anchor on
    // purpose, so "zoom in for all" would mislead there.
    statusNote: (_q, raw) =>
      [
        scopeNote(lastSel),
        tiledNote(lastSel?.mode === 'nearest' ? { ...raw, partial: false } : raw),
      ]
        .filter(Boolean)
        .join(' · '),
    interpolate: false,
    maxEntities,
    normalize: (raw) => normalizeSurveillance(raw),
    // Which held records to draw (the Layer SDK calls this on every ingest).
    select: (list) => {
      lastSel = selectScope(list, {
        mode: scope?.mode?.() ?? 'all',
        anchor: scope?.anchor?.() ?? null,
        view: scope?.view?.() ?? null,
        nearest: scope?.nearest ?? NEAREST_DEFAULT,
        max: maxEntities,
      });
      return lastSel.list;
    },
    render: {
      renderType: 'point',
      style: (n) => styles[n.meta.kind] ?? styles.fixed,
    },
    onEntityCreate: (target, n, ctx) => {
      fillOn ??= tier ? tier !== 'minimal' : !minimalTier(ctx.scene);
      return cones.onEntityCreate(target, n, ctx);
    },
    onShow: (on, ctx) => cones.onShow(on, ctx),
    describe: (n) => describeSurveillance(n),
    searchText: (n) => surveillanceSearchText(n),
  };
}

export const surveillanceDefinition = createSurveillanceDefinition();
