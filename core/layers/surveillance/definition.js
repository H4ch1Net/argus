import { parseOverpass } from '../overpass/parse.js';
import { areaTooLarge } from '../overpass/client.js';
import { surveillanceKind, describeSurveillance } from './format.js';
import { ink } from '../sdk/colors.js';
import { groundDecorations } from './groundBatch.js';
import {
  cameraCones,
  sectorDegrees,
  circleDegrees,
  coneScale,
  CONE_CAP,
} from './cones.js';

// The "eyes": surveillance-infrastructure locations from OSM (man_made=surveillance),
// including ALPR/Flock readers. A viewport-fetched, static point layer. GUARDRAIL:
// locations only, never a reading of what the equipment sees. ALPR readers get
// their own glyph (a reader body with a lens bar, ctOS white); ordinary cameras
// keep the bracket.
//
// View cones: each camera mapped with a direction gets a translucent sector on
// the ground showing which side it faces (core/layers/surveillance/cones.js);
// one without a direction gets a faint ring. All cones of the layer are ONE
// batched ground primitive plus one outline primitive (groundBatch.js), rebuilt
// when the record set changes, never per frame; at most CONE_CAP cones (the
// nearest to the camera), enlarged in coarse bands when zoomed out, hidden above
// 25 km. The minimal tier keeps the outlines and drops the fill.

const minimalTier = (scene) => (scene?.globe?.maximumScreenSpaceError ?? 2) >= 4;

/**
 * @param {{ tier?: string }} [opts] the capability tier; without one, the
 *   minimal tier is recognised from the globe's screen-space error (4 there).
 */
export function createSurveillanceDefinition({ tier } = {}) {
  let fillOn = null; // decided on the first build
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
        if (s.ring) {
          count += 1;
          lines.push({
            path: circleDegrees(s.lon, s.lat, range),
            color: ink(s.alpr ? 'white' : 'gray', 0.22),
            width: 1,
            loop: true,
          });
          continue;
        }
        for (const c of s.cones) {
          count += 1;
          const ring = sectorDegrees(s.lon, s.lat, c.headingDeg, c.fovDeg, range);
          if (fillOn) fills.push({ ring, color: ink(s.alpr ? 'white' : 'gray', 0.13) });
          lines.push({
            path: ring,
            color: ink(s.alpr ? 'white' : 'gray', s.alpr ? 0.75 : 0.5),
            width: s.alpr ? 1.6 : 1.2,
            loop: true,
          });
        }
      }
      return { fills, lines };
    },
  });

  return {
    id: 'surveillance',
    // Fetched once per half-degree tile and kept 12 h (or until RELOAD):
    // mapped cameras and readers do not move (core/layers/sdk/tileCache.js).
    fetch: {
      mode: 'viewport',
      tileCache: { tileDeg: 0.5, ttlMs: 12 * 3_600_000, maxTiles: 32 },
    },
    // The Overpass client skips views wider than a few degrees; say so.
    statusNote: (q, raw) =>
      q.bbox && areaTooLarge(q.bbox, 3) && !raw?.elements?.length
        ? 'zoom in to load'
        : '',
    interpolate: false,
    maxEntities: 4000,
    normalize: (json) => parseOverpass(json),
    render: {
      renderType: 'point',
      style: (n) => {
        const alpr = surveillanceKind(n.meta.tags) === 'ALPR';
        return {
          glyph: alpr ? 'alpr' : 'bracket',
          pixelSize: alpr ? 15 : 11,
          color: alpr ? ink('white') : ink('gray', 0.9),
        };
      },
    },
    onEntityCreate: (target, n, ctx) => {
      fillOn ??= tier ? tier !== 'minimal' : !minimalTier(ctx.scene);
      return cones.onEntityCreate(target, n, ctx);
    },
    onShow: (on, ctx) => cones.onShow(on, ctx),
    describe: (n) => describeSurveillance(n),
    searchText: (n) =>
      `${n.meta.tags.operator || ''} ${n.meta.tags['surveillance:type'] || ''} ${n.meta.tags.man_made || ''}`,
  };
}

export const surveillanceDefinition = createSurveillanceDefinition();
