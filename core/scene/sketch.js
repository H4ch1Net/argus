import * as Cesium from 'cesium';

// The sketch layer: what the tools draw on the globe (a planned route with its
// turn points, drawn areas, lines and pins, a pending A/B marker). One
// CustomDataSource, ctOS styled: white lines, a translucent fill, square
// markers. Nothing here fetches anything.

const WHITE = Cesium.Color.WHITE;
const FILL = Cesium.Color.WHITE.withAlpha(0.12);
const toCart = ([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat);

/** @param {import('cesium').Viewer} viewer */
export function createSketch(viewer) {
  const ds = new Cesium.CustomDataSource('argus-sketch');
  viewer.dataSources.add(ds);
  const groups = new Map(); // name -> Entity[]
  const render = () => viewer.scene.requestRender();

  function clear(name) {
    for (const e of groups.get(name) ?? []) ds.entities.remove(e);
    groups.delete(name);
    render();
  }

  function add(name, opts) {
    const e = ds.entities.add(opts);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(e);
    render();
    return e;
  }

  const marker = (name, [lon, lat], text) =>
    add(name, {
      position: Cesium.Cartesian3.fromDegrees(lon, lat),
      point: {
        pixelSize: 8,
        color: WHITE,
        outlineColor: Cesium.Color.fromCssColorString('#0e0e0e'),
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: text
        ? {
            text,
            font: "11px 'JetBrains Mono', ui-monospace, monospace",
            fillColor: WHITE,
            outlineColor: Cesium.Color.fromCssColorString('#0e0e0e'),
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(10, -10),
            horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          }
        : undefined,
    });

  return {
    clear,
    marker,
    /** A path [[lon, lat], ...] clamped to the ground. */
    line(name, coords, { dashed = false, width = 3 } = {}) {
      if (coords.length < 2) return null;
      return add(name, {
        polyline: {
          positions: coords.map(toCart),
          width,
          clampToGround: true,
          material: dashed
            ? new Cesium.PolylineDashMaterialProperty({ color: WHITE, dashLength: 14 })
            : new Cesium.PolylineOutlineMaterialProperty({
                color: WHITE,
                outlineColor: Cesium.Color.fromCssColorString('#0e0e0e'),
                outlineWidth: 1,
              }),
        },
      });
    },
    /** A closed area [[lon, lat], ...] (ring not repeated). */
    area(name, coords) {
      if (coords.length < 3) return null;
      add(name, {
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(coords.map(toCart)),
          material: FILL,
        },
      });
      return this.line(name, [...coords, coords[0]], { width: 2 });
    },
    destroy() {
      viewer.dataSources.remove(ds, true);
    },
  };
}

/** The ground point under a window position, or null (sky). */
export function windowToLatLon(viewer, { x, y }) {
  const p = viewer.camera.pickEllipsoid(
    new Cesium.Cartesian2(x, y),
    viewer.scene.globe.ellipsoid,
  );
  if (!p) return null;
  const c = Cesium.Cartographic.fromCartesian(p);
  return {
    lat: Cesium.Math.toDegrees(c.latitude),
    lon: Cesium.Math.toDegrees(c.longitude),
  };
}

/** A target's current ground point as { lat, lon }, or null. */
export function targetLatLon(viewer, target) {
  const p = target?.position?.getValue(viewer.clock.currentTime);
  if (!p) return null;
  const c = Cesium.Cartographic.fromCartesian(p);
  return {
    lat: Cesium.Math.toDegrees(c.latitude),
    lon: Cesium.Math.toDegrees(c.longitude),
  };
}

/**
 * Fly the camera along a route, low over the ground, looking ahead (no banking, so
 * it stays steady on a phone). Any pointer press or Escape stops it.
 * @param {{ at: (m: number) => { lon: number, lat: number, headingDeg: number }, totalM: number }} path
 */
export function flyAlongPath(viewer, path, { altitudeM = 450, onEnd } = {}) {
  if (!path?.totalM) return () => {};
  const durationMs = Math.min(150_000, Math.max(20_000, (path.totalM / 250) * 1000));
  const t0 = performance.now();
  let raf = 0;
  let headingRad = null;
  let groundM = null;
  const stop = () => {
    cancelAnimationFrame(raf);
    viewer.scene.canvas.removeEventListener('pointerdown', stop);
    document.removeEventListener('keydown', onKey);
    onEnd?.();
  };
  const onKey = (e) => e.key === 'Escape' && stop();
  const step = () => {
    const k = Math.min(1, (performance.now() - t0) / durationMs);
    const p = path.at(k * path.totalM);
    if (p) {
      const target = Cesium.Math.toRadians(p.headingDeg ?? 0);
      // Ease the heading so corners turn smoothly instead of snapping.
      headingRad =
        headingRad === null
          ? target
          : headingRad + Cesium.Math.negativePiToPi(target - headingRad) * 0.08;
      const back = 900; // metres behind the point, looking ahead
      const lat = p.lat - (Math.cos(headingRad) * back) / 111_320;
      const lon =
        p.lon -
        (Math.sin(headingRad) * back) /
          (111_320 * Math.cos(Cesium.Math.toRadians(p.lat)));
      // Above the ground under the camera, not the ellipsoid: with terrain on,
      // high ground would otherwise swallow the camera. Eased like the heading.
      const ground =
        viewer.scene.globe?.getHeight?.(Cesium.Cartographic.fromDegrees(lon, lat)) ?? 0;
      groundM = groundM === null ? ground : groundM + (ground - groundM) * 0.1;
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(lon, lat, groundM + altitudeM),
        orientation: { heading: headingRad, pitch: Cesium.Math.toRadians(-22), roll: 0 },
      });
      viewer.scene.requestRender();
    }
    if (k < 1) raf = requestAnimationFrame(step);
    else stop();
  };
  viewer.scene.canvas.addEventListener('pointerdown', stop);
  document.addEventListener('keydown', onKey);
  raf = requestAnimationFrame(step);
  return stop;
}
