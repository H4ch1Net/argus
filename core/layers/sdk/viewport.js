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
  return {
    lamin: clampLat(rect.south * R2D),
    lamax: clampLat(rect.north * R2D),
    lomin: crossesAntimeridian ? -180 : clampLon(rect.west * R2D),
    lomax: crossesAntimeridian ? 180 : clampLon(rect.east * R2D),
  };
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
