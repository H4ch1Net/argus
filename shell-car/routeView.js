import * as Cesium from 'cesium';

// The route on the car map, ctOS: the way ahead a white line on a dark
// keyline, the way already driven dimmed to grey, alternatives grey while
// previewing, and the destination as a bracketed target with its name. One
// PolylineCollection, one billboard and one label. Positions change only on a
// new route or a nav update (about once a second); each change asks for one
// render, and nothing here runs per frame.

const LIFT_M = 4; // above the ellipsoid, clear of the globe's depth test
const INK = Cesium.Color.WHITE;
const KEYLINE = Cesium.Color.fromCssColorString('#0e0e0e').withAlpha(0.85);
const DIM = Cesium.Color.fromCssColorString('#7a7a7a').withAlpha(0.75);
const ALT = Cesium.Color.fromCssColorString('#9a9a9a').withAlpha(0.8);

const colour = (c) => Cesium.Material.fromType('Color', { color: c });

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
  const lines = scene.primitives.add(new Cesium.PolylineCollection());
  const marks = scene.primitives.add(new Cesium.BillboardCollection({ scene }));
  const labels = scene.primitives.add(new Cesium.LabelCollection({ scene }));
  const carts = new Map(); // route id -> Cartesian3[] (converted once per route)
  let active = null; // { carts, travelled, ahead, keyline }
  const render = () => scene.requestRender();

  function cartsOf(route) {
    const key = route?.id ?? '';
    if (carts.has(key)) return carts.get(key);
    const pts = [];
    for (const p of route?.geometry ?? []) {
      if (Number.isFinite(p?.[0]) && Number.isFinite(p?.[1]))
        pts.push(Cesium.Cartesian3.fromDegrees(p[0], p[1], LIFT_M));
    }
    // Only the routes on screen are kept.
    if (carts.size > 8) carts.clear();
    carts.set(key, pts);
    return pts;
  }

  const line = (positions, width, color) =>
    positions.length >= 2
      ? lines.add({
          positions,
          width,
          material: colour(color),
          arcType: Cesium.ArcType.NONE,
        })
      : null;

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
    const name = String(dest.name || '')
      .toUpperCase()
      .slice(0, 28);
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

  function clearLines() {
    lines.removeAll();
    active = null;
  }

  return {
    /** Candidate routes, the selected one on top in white, the rest grey. */
    showPreview(routes, selectedId, dest) {
      clearLines();
      const list = routes || [];
      for (const r of list) if (r.id !== selectedId) line(cartsOf(r), 5, ALT);
      const sel = list.find((r) => r.id === selectedId) ?? list[0];
      if (sel) {
        const pts = cartsOf(sel);
        line(pts, 11, KEYLINE);
        line(pts, 6, INK);
      }
      setDestination(dest);
      render();
    },

    /** The route being driven: all of it ahead until the first progress. */
    showActive(route, dest) {
      clearLines();
      const pts = cartsOf(route);
      active = {
        carts: pts,
        keyline: line(pts, 11, KEYLINE),
        travelled: lines.add({
          positions: [],
          width: 6,
          material: colour(DIM),
          show: false,
        }),
        ahead: line(pts, 6, INK),
        index: -1,
      };
      setDestination(dest);
      render();
    },

    /**
     * Split the active route where the vehicle is: `at` = { index, lat, lon }
     * (the segment it is on and the snapped point, nav.js locateOnRoute).
     */
    setProgress(at) {
      if (!active?.ahead || !at || !Number.isInteger(at.index)) return;
      const { carts: pts } = active;
      const i = Math.min(Math.max(at.index, 0), pts.length - 2);
      const here = Cesium.Cartesian3.fromDegrees(at.lon, at.lat, LIFT_M);
      const done = pts.slice(0, i + 1);
      done.push(here);
      const ahead = pts.slice(i + 1);
      ahead.unshift(here);
      active.travelled.positions = done;
      active.travelled.show = done.length >= 2;
      active.ahead.positions = ahead;
      active.keyline.positions = ahead;
      active.index = i;
      render();
    },

    clear() {
      clearLines();
      marks.removeAll();
      labels.removeAll();
      carts.clear();
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
      scene.primitives.remove(lines);
      scene.primitives.remove(marks);
      scene.primitives.remove(labels);
    },
  };
}
