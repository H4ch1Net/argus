import * as Cesium from 'cesium';
import { createRouteLines } from '../core/nav/routeLines.js';
import { shortPlaceName } from './model.js';

// The route on the car map, ctOS: the way ahead white, the way already driven
// dimmed to grey, alternatives grey while previewing, and the destination as a
// bracketed target with its name. The lines are the phone's ground lines
// (core/nav/routeLines.js): draped on the globe, so the globe's depth test
// never hides part of them, built once per set of routes; choosing a route,
// starting it and driving it only recolour their pieces (about 100 m each).
// One billboard and one label for the destination. Each change asks for one
// render, and nothing here runs per frame.

const LIFT_M = 4; // the destination mark, above the ellipsoid
const WIDTH = 8; // px: read at arm's length
const INK = Cesium.Color.WHITE;
const KEYLINE = Cesium.Color.fromCssColorString('#0e0e0e').withAlpha(0.85);
const DIM = Cesium.Color.fromCssColorString('#7a7a7a').withAlpha(0.75);
const ALT = Cesium.Color.fromCssColorString('#9a9a9a').withAlpha(0.8);

// The destination target: four corner brackets round a filled square, white
// on a dark keyline, drawn once at twice its size for crisp edges.
let targetCanvas = null;
function target() {
  if (targetCanvas) return targetCanvas;
  const px = 30;
  const c = document.createElement('canvas');
  c.width = c.height = px * 2;
  const g = c.getContext('2d');
  g.scale(2, 2);
  g.lineCap = 'square';
  g.lineJoin = 'miter';
  const arm = 7;
  const corners = (inset) => {
    const a = inset;
    const b = px - inset;
    g.beginPath();
    g.moveTo(a, a + arm);
    g.lineTo(a, a);
    g.lineTo(a + arm, a);
    g.moveTo(b - arm, a);
    g.lineTo(b, a);
    g.lineTo(b, a + arm);
    g.moveTo(b, b - arm);
    g.lineTo(b, b);
    g.lineTo(b - arm, b);
    g.moveTo(a + arm, b);
    g.lineTo(a, b);
    g.lineTo(a, b - arm);
    g.stroke();
  };
  g.strokeStyle = '#0e0e0eee';
  g.lineWidth = 5;
  corners(3.5);
  g.strokeStyle = '#ffffff';
  g.lineWidth = 2;
  corners(3.5);
  g.fillStyle = '#0e0e0eee';
  g.fillRect(9, 9, 12, 12);
  g.fillStyle = '#ffffff';
  g.fillRect(10.5, 10.5, 9, 9);
  targetCanvas = c;
  return c;
}

/** @param {import('cesium').Viewer} viewer */
export function createRouteView(viewer) {
  const { scene } = viewer;
  const lines = createRouteLines(scene, { width: WIDTH });
  const marks = scene.primitives.add(new Cesium.BillboardCollection({ scene }));
  const labels = scene.primitives.add(new Cesium.LabelCollection({ scene }));
  let shown = []; // the routes the lines were built from, in build order
  // What the lines show: { selectedId } while previewing, { activeIx, along }
  // on a route (its index in `shown`, metres driven).
  let mode = null;
  const render = () => scene.requestRender();

  // New geometry only for a different set of routes.
  function show(routes) {
    const list = (routes || []).filter((r) => r?.geometry?.length >= 2);
    const same = list.length === shown.length && list.every((r, i) => r === shown[i]);
    if (same) return;
    shown = list;
    lines.build(list);
  }

  function paint() {
    lines.paint((ri, piece) => {
      if (!mode) return null;
      if (mode.selectedId !== undefined)
        return shown[ri]?.id === mode.selectedId ? INK : ALT;
      // On a route: the others go, the driven part dims.
      if (ri !== mode.activeIx) return null;
      return piece.to <= mode.along ? DIM : INK;
    });
    render();
  }

  function setDestination(dest) {
    marks.removeAll();
    labels.removeAll();
    if (!dest || !Number.isFinite(dest.lat) || !Number.isFinite(dest.lon)) return;
    const at = Cesium.Cartesian3.fromDegrees(dest.lon, dest.lat, LIFT_M);
    marks.add({
      position: at,
      image: target(),
      width: 30,
      height: 30,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
    // Whole parts of the name only ("46211 JACKSON STREET, INDIO").
    const name = shortPlaceName(String(dest.name || '').toUpperCase());
    if (name) {
      labels.add({
        position: at,
        text: name,
        font: "600 15px 'JetBrains Mono', ui-monospace, monospace",
        fillColor: INK,
        outlineColor: KEYLINE,
        outlineWidth: 4,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(20, -16),
        horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    }
  }

  return {
    /** Candidate routes, the selected one in white, the rest grey. */
    showPreview(routes, selectedId, dest) {
      show(routes);
      mode = {
        selectedId: (shown.find((r) => r.id === selectedId) ?? shown[0])?.id ?? null,
      };
      paint();
      setDestination(dest);
      render();
    },

    /**
     * The route being driven: all of it ahead until the first progress. Started
     * from a preview, the lines already built stay (only the colours change).
     */
    showActive(route, dest) {
      let ix = shown.indexOf(route);
      if (ix < 0)
        ix = shown.findIndex((r) => r.id === route?.id && r.geometry === route?.geometry);
      if (ix < 0) {
        show(route ? [route] : []);
        ix = 0;
      }
      mode = { activeIx: ix, along: 0 };
      paint();
      setDestination(dest);
      render();
    },

    /** Where the vehicle is on the active route: `at.along` metres from its start (nav.js locateOnRoute). */
    setProgress(at) {
      if (!mode || mode.activeIx === undefined || !Number.isFinite(at?.along)) return;
      if (at.along === mode.along) return;
      mode.along = at.along;
      paint();
    },

    clear() {
      mode = null;
      shown = [];
      lines.clear();
      marks.removeAll();
      labels.removeAll();
      render();
    },

    /** [west, south, east, north] in degrees around routes and a destination. */
    bounds(routes, dest) {
      let w = Infinity;
      let s = Infinity;
      let e = -Infinity;
      let n = -Infinity;
      const add = (lon, lat) => {
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
        w = Math.min(w, lon);
        e = Math.max(e, lon);
        s = Math.min(s, lat);
        n = Math.max(n, lat);
      };
      for (const r of routes || []) for (const p of r.geometry ?? []) add(p[0], p[1]);
      if (dest) add(dest.lon, dest.lat);
      return Number.isFinite(w) ? [w, s, e, n] : null;
    },

    destroy() {
      lines.destroy();
      scene.primitives.remove(marks);
      scene.primitives.remove(labels);
    },
  };
}
