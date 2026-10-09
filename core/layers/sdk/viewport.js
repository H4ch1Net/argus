// Viewport-bounded fetch support for the Layer SDK.
//
// Fetch is viewport/radius-bounded from the start (CLAUDE.md): metered feeds
// charge by area, so a layer only ever asks for the visible region. The
// rectangle->bbox conversion is pure; computeViewportQuery is the one part that
// touches the Cesium camera.

const R2D = 180 / Math.PI;
const clampLat = (x) => Math.max(-90, Math.min(90, x));
const clampLon = (x) => Math.max(-180, Math.min(180, x));

const GLOBAL_BBOX = { lamin: -90, lamax: 90, lomin: -180, lomax: 180 };

/**
 * Convert a Cesium-style rectangle (radians, fields west/south/east/north) into
 * bbox params (degrees). A rectangle that crosses the antimeridian (west > east)
 * cannot be expressed as one lomin<lomax box, so we widen longitude to the full
 * range for that frame rather than fetch the wrong strip.
 * @param {{ west: number, south: number, east: number, north: number }} rect
 * @returns {{ lamin: number, lomin: number, lamax: number, lomax: number }}
 */
export function rectangleRadiansToBBox(rect) {
  const crossesAntimeridian = rect.west > rect.east;
  const bbox = {
    lamin: clampLat(rect.south * R2D),
    lamax: clampLat(rect.north * R2D),
    lomin: crossesAntimeridian ? -180 : clampLon(rect.west * R2D),
    lomax: crossesAntimeridian ? 180 : clampLon(rect.east * R2D),
  };
  // Point-and-radius queries (adsb.lol) still need the true centre of the view.
  if (crossesAntimeridian) bbox.wrap = { west: rect.west * R2D, east: rect.east * R2D };
  return bbox;
}

/**
 * How far view `b` has moved from view `a`, in views: the larger of the
 * centre's shift (as a fraction of a's width and height) and the change in
 * size (log of the linear size ratio). 0 is the same view; 1 is a whole view
 * away (or a zoom by a factor of e). Layers use it to skip a refetch when
 * the view barely moved (GPS jitter under a following camera) and to refetch
 * when a camera that never settles has drifted off the fetched area.
 * @param {{ lamin: number, lomin: number, lamax: number, lomax: number, wrap?: object }} a
 * @param {{ lamin: number, lomin: number, lamax: number, lomax: number, wrap?: object }} b
 * @returns {number}
 */
export function viewportShift(a, b) {
  if (!a || !b) return Infinity;
  // A view across the antimeridian is widened to all longitudes: no shift can
  // be read from it, so treat any such pair as moved.
  if (a.wrap || b.wrap) return Infinity;
  const aw = Math.max(1e-9, a.lomax - a.lomin);
  const ah = Math.max(1e-9, a.lamax - a.lamin);
  const bw = Math.max(1e-9, b.lomax - b.lomin);
  const bh = Math.max(1e-9, b.lamax - b.lamin);
  const dx = Math.abs((b.lomin - a.lomin + (b.lomax - a.lomax)) / 2) / aw;
  const dy = Math.abs((b.lamin - a.lamin + (b.lamax - a.lamax)) / 2) / ah;
  const dz = Math.abs(Math.log((bw * bh) / (aw * ah))) / 2;
  return Math.max(dx, dy, dz);
}

/**
 * The fetch query for the current view: a bbox for the visible region, or the
 * whole globe when zoomed out so far that the view includes space (no finite
 * rectangle). Heavier, but better than fetching nothing.
 * @param {import('cesium').Viewer} viewer
 * @returns {{ bbox: { lamin: number, lomin: number, lamax: number, lomax: number } }}
 */
export function computeViewportQuery(viewer) {
  const rect = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);
  return { bbox: rect ? rectangleRadiansToBBox(rect) : { ...GLOBAL_BBOX } };
}
