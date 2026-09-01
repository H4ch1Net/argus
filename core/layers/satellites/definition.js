import * as Cesium from 'cesium';
import { parseTle } from './tle.js';
import { toSatrec, satPositionAt, orbitTrack } from './propagate.js';

// Satellites as a Layer SDK definition. Unlike flights (fixes + interpolation),
// positions are COMPUTED from orbital elements via SGP4 each frame (def.positionAt),
// and each satellite gets an orbit ring drawn via def.onEntityCreate. TLEs are
// fetched sparingly (CelesTrak's ~2h update policy) and refreshed on a long timer.

const ORBIT_REALIGN_MS = 30_000; // recompute the ring so it tracks (GMST realignment)

function trackToCartesians(satrec) {
  return orbitTrack(satrec, new Date()).map((p) =>
    Cesium.Cartesian3.fromDegrees(p.longitude, p.latitude, Math.max(0, p.altitude)),
  );
}

export const satellitesDefinition = {
  id: 'satellites',
  // Fetch TLEs rarely: once on start, then every 6 hours (well within policy).
  fetch: { mode: 'poll', intervalMs: 6 * 60 * 60 * 1000, viewportBounded: false },
  positionAt: (n, timeMs) => satPositionAt(n.meta.satrec, new Date(timeMs)),
  maxEntities: 400,

  normalize: (tleText) =>
    parseTle(tleText).map((sat) => {
      const satrec = toSatrec(sat);
      const p = satPositionAt(satrec, new Date());
      return {
        id: String(satrec.satnum),
        type: 'satellite',
        position: p || { longitude: 0, latitude: 0, altitude: 0 },
        meta: { name: sat.name, satrec },
      };
    }),

  render: {
    renderType: 'point',
    style: () => ({
      pixelSize: 5,
      color: Cesium.Color.fromCssColorString('#ffd95f'),
      outlineColor: Cesium.Color.BLACK.withAlpha(0.5),
    }),
  },

  onEntityCreate: (entity, n, { scene }) => {
    let track = trackToCartesians(n.meta.satrec);
    entity.polyline = new Cesium.PolylineGraphics({
      positions: new Cesium.CallbackProperty(() => track, false),
      width: 1,
      // ArcType.NONE: straight segments in 3D, so the ring floats at orbital
      // altitude instead of being clamped to the ellipsoid surface.
      arcType: Cesium.ArcType.NONE,
      material: Cesium.Color.fromCssColorString('#6cc6ff').withAlpha(0.35),
    });
    const timer = setInterval(() => {
      track = trackToCartesians(n.meta.satrec);
      scene.requestRender();
    }, ORBIT_REALIGN_MS);
    return () => clearInterval(timer);
  },

  describe: (n) => {
    const p = satPositionAt(n.meta.satrec, new Date());
    return {
      id: n.id,
      title: n.meta.name || `SAT ${n.id}`,
      subtitle: `NORAD ${n.id}`,
      rows: [
        ['Altitude', p ? `${Math.round(p.altitude / 1000)} km` : '—'],
        ['Latitude', p ? p.latitude.toFixed(2) : '—'],
        ['Longitude', p ? p.longitude.toFixed(2) : '—'],
      ],
    };
  },
  searchText: (n) => `${n.meta.name} ${n.id}`,
};
