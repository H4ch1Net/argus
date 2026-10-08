import * as Cesium from 'cesium';
import { ink } from '../sdk/colors.js';
import { satPositionAt, orbitTrack } from './propagate.js';
import { tleToNormalized, describeSatellite, satelliteSearchText } from './format.js';

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

const ringCollections = new WeakMap(); // scene -> PolylineCollection
function ringCollection(scene) {
  let rings = ringCollections.get(scene);
  if (!rings || rings.isDestroyed()) {
    rings = scene.primitives.add(new Cesium.PolylineCollection());
    ringCollections.set(scene, rings);
  }
  return rings;
}
let ringMaterial = null;
const RING_MATERIAL = () =>
  (ringMaterial ??= Cesium.Material.fromType('Color', {
    color: ink('gray', 0.16),
  }));

export const satellitesDefinition = {
  id: 'satellites',
  // Fetch TLEs rarely: once on start, then every 6 hours (well within policy).
  fetch: { mode: 'poll', intervalMs: 6 * 60 * 60 * 1000, viewportBounded: false },
  positionAt: (n, timeMs) => satPositionAt(n.meta.satrec, new Date(timeMs)),
  maxEntities: 400,

  normalize: (tleText) => tleToNormalized(tleText),

  render: {
    renderType: 'point',
    style: () => ({ glyph: 'sat', pixelSize: 13, color: ink('dim') }),
  },

  // Orbit rings live in one PolylineCollection shared by the layer (a single
  // primitive), each ring re-propagated every 30 s (GMST realignment), instead
  // of an entity polyline per satellite rebuilt every frame.
  onEntityCreate: (target, n, { scene }) => {
    const rings = ringCollection(scene);
    const ring = rings.add({
      positions: trackToCartesians(n.meta.satrec),
      width: 1,
      material: RING_MATERIAL(),
    });
    const timer = setInterval(() => {
      ring.positions = trackToCartesians(n.meta.satrec);
      scene.requestRender();
    }, ORBIT_REALIGN_MS);
    return () => {
      clearInterval(timer);
      if (!rings.isDestroyed()) rings.remove(ring);
    };
  },

  onShow: (on, { scene }) => {
    ringCollection(scene).show = on;
  },

  describe: (n) => describeSatellite(n),
  searchText: satelliteSearchText,
};
