import * as Cesium from 'cesium';
import { DEFAULT_POSE, frustumCornersEnu } from './pose.js';
import { ink } from '../sdk/colors.js';

// CCTV projection: display already-public camera snapshots projected into 3D.
// Each camera is a marker, a view frustum (where it looks), and its image at the
// frustum's far plane. The pose (heading/pitch/fov/range) is user-calibrated via
// a gizmo, so this is a 'once'-fetch layer (poses persist, never re-ingested).
//
// GUARDRAIL: this shows the public stream/snapshot only. It performs no computer
// vision on the footage (no plate reading, no tracking).

// Frustum and image entities per viewer, so hiding the layer hides them too.
const extras = new WeakMap(); // viewer -> Set<Entity>
const extrasFor = (viewer) => {
  let set = extras.get(viewer);
  if (!set) extras.set(viewer, (set = new Set()));
  return set;
};

function toNormalized(cam) {
  return {
    id: cam.id,
    type: 'cctv',
    position: {
      longitude: cam.lon,
      latitude: cam.lat,
      altitude: cam.pose?.heightM ?? DEFAULT_POSE.heightM,
    },
    meta: {
      name: cam.name,
      image: cam.image,
      pose: { ...DEFAULT_POSE, ...(cam.pose || {}) },
    },
  };
}

export const cctvDefinition = {
  id: 'cctv',
  fetch: { mode: 'once' },
  interpolate: false,
  maxEntities: 500,
  searchText: (n) => n.meta.name || '',
  normalize: (cams) => (Array.isArray(cams) ? cams.map(toNormalized) : []),
  render: {
    renderType: 'point',
    style: () => ({ glyph: 'bracket', pixelSize: 15, color: ink('white') }),
  },
  describe: (n) => ({
    id: n.id,
    title: n.meta.name || 'CCTV camera',
    subtitle: 'public camera',
    rows: [
      ['Heading', `${Math.round(n.meta.pose.heading)}°`],
      ['Pitch', `${Math.round(n.meta.pose.pitch)}°`],
      ['FOV', `${Math.round(n.meta.pose.fovDeg)}°`],
      ['Range', `${Math.round(n.meta.pose.rangeM)} m`],
      [
        'Coordinates',
        `${n.position.latitude.toFixed(4)}, ${n.position.longitude.toFixed(4)}`,
      ],
    ],
  }),

  // Frustum + image screen, both recomputed from the (editable) pose each frame.
  onEntityCreate: (target, n, { viewer }) => {
    const cornersEcef = () => {
      const origin = target.position.getValue(viewer.clock.currentTime);
      if (!origin) return null;
      const enuToFixed = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
      const { center, corners } = frustumCornersEnu(n.meta.pose);
      const toEcef = (v) =>
        Cesium.Matrix4.multiplyByPoint(
          enuToFixed,
          new Cesium.Cartesian3(v.e, v.n, v.u),
          new Cesium.Cartesian3(),
        );
      return { origin, center: toEcef(center), corners: corners.map(toEcef) };
    };

    const frustum = viewer.entities.add({
      polyline: {
        positions: new Cesium.CallbackProperty(() => {
          const g = cornersEcef();
          if (!g) return [];
          const [tl, tr, br, bl] = g.corners;
          // One path covering the four side edges and the far rectangle.
          return [g.origin, tl, tr, g.origin, br, bl, g.origin, tl, tr, br, bl, tl];
        }, false),
        width: 1.4,
        arcType: Cesium.ArcType.NONE,
        material: ink('gray', 0.45),
      },
    });

    const screen = viewer.entities.add({
      position: new Cesium.CallbackProperty(() => cornersEcef()?.center, false),
      billboard: {
        image: n.meta.image,
        width: 112,
        height: 63,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(1e3, 1.2, 6e5, 0.35),
      },
    });

    const mine = extrasFor(viewer);
    mine.add(frustum);
    mine.add(screen);
    return () => {
      mine.delete(frustum);
      mine.delete(screen);
      viewer.entities.remove(frustum);
      viewer.entities.remove(screen);
    };
  },

  // The horizon culler (core/scene/occlusion.js) owns entity.show for point
  // features, so the image screen hides through its billboard instead.
  onShow: (on, { viewer }) => {
    for (const e of extrasFor(viewer)) {
      if (e.billboard) e.billboard.show = on;
      else e.show = on;
    }
  },
};
