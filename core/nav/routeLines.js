import * as Cesium from 'cesium';
import { chunkLine, cumulative } from './geo.js';

// Route lines on the globe for navigation (browser only): every route of a
// plan cut into pieces of about 100 m, all in ONE GroundPolylinePrimitive
// (draped on terrain and photoreal tiles alike), each piece its own instance.
// The geometry is built only when the set of routes changes (a new plan, a
// reroute), in Cesium's workers, and swapped in when ready (no flicker).
// Everything after that is colour: the vehicle passing a piece greys it,
// picking an alternative brightens it, a route not taken goes transparent,
// a TomTom jam ahead is red. A colour change writes one instance attribute
// (into a scratch array), so progress costs no geometry and no allocation.
//
// Where ground polylines are unsupported, plain polylines 15 m up stand in.

const CHUNK_M = 100;
const MAX_CHUNKS = 300; // per route
const WIDTH = 6;

/**
 * @param {import('cesium').Scene} scene
 * @returns {{ build: (routes: object[]) => void, paint: (colorOf: (routeIndex: number,
 *   piece: object) => import('cesium').Color) => void, clear: () => void, destroy: () => void }}
 */
export function createRouteLines(scene) {
  let supported = false;
  try {
    supported = Cesium.GroundPolylinePrimitive?.isSupported?.(scene) === true;
  } catch {
    supported = false;
  }
  const canSetAttr =
    typeof Cesium.GroundPolylinePrimitive?.prototype?.getGeometryInstanceAttributes ===
    'function';
  const scratch = new Uint8Array(4);

  let prim = null; // the shown primitive (or PolylineCollection in the fallback)
  let pending = null; // { prim, poll, started }
  let pieces = []; // { route, piece, id, color (applied), want, instance? }
  let pendingPieces = null;

  const drop = (p) => {
    if (p && !p.isDestroyed?.() && scene.primitives.contains(p))
      scene.primitives.remove(p);
  };

  function apply(list, p, force = false) {
    for (const e of list) {
      if (!force && e.color === e.want) continue;
      e.color = e.want;
      if (!supported) {
        if (e.line) e.line.material.uniforms.color = e.want;
        continue;
      }
      const attrs = canSetAttr && p?.ready ? p.getGeometryInstanceAttributes(e.id) : null;
      if (attrs)
        attrs.color = Cesium.ColorGeometryInstanceAttribute.toValue(e.want, scratch);
      else if (e.instance)
        e.instance.attributes.color = Cesium.ColorGeometryInstanceAttribute.fromColor(
          e.want,
        );
    }
    scene.requestRender();
  }

  function discardPending() {
    if (!pending) return;
    clearInterval(pending.poll);
    drop(pending.prim);
    pending = null;
    pendingPieces = null;
  }

  function swapIn(p, list) {
    drop(prim);
    prim = p;
    pieces = list;
    apply(pieces, prim, true);
  }

  return {
    /** New routes (or none): cut and build once, swap in when ready. */
    build(routes) {
      discardPending();
      const list = [];
      (routes ?? []).forEach((r, ri) => {
        const line = r?.geometry;
        if (!Array.isArray(line) || line.length < 2) return;
        for (const piece of chunkLine(line, cumulative(line), CHUNK_M, MAX_CHUNKS)) {
          list.push({
            route: ri,
            piece,
            id: `nav-${ri}-${list.length}`,
            color: null,
            want: Cesium.Color.TRANSPARENT,
          });
        }
      });
      if (!list.length) {
        swapIn(null, []);
        return;
      }
      if (!supported) {
        const coll = prim ?? scene.primitives.add(new Cesium.PolylineCollection());
        coll.removeAll();
        for (const e of list) {
          e.line = coll.add({
            positions: Cesium.Cartesian3.fromDegreesArrayHeights(
              e.piece.path.flatMap(([lon, lat]) => [lon, lat, 15]),
            ),
            width: WIDTH - 1,
            material: Cesium.Material.fromType('Color', {
              color: Cesium.Color.TRANSPARENT,
            }),
          });
        }
        prim = coll;
        pieces = list;
        apply(pieces, prim, true);
        return;
      }
      const instances = list.map((e) => {
        const gi = new Cesium.GeometryInstance({
          id: e.id,
          geometry: new Cesium.GroundPolylineGeometry({
            positions: Cesium.Cartesian3.fromDegreesArray(e.piece.path.flat()),
            width: WIDTH,
          }),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              Cesium.Color.TRANSPARENT,
            ),
          },
        });
        // Without per-instance attribute updates (a test double), keep the
        // instance to recolour it directly.
        if (!canSetAttr) e.instance = gi;
        return gi;
      });
      const p = scene.primitives.add(
        new Cesium.GroundPolylinePrimitive({
          geometryInstances: instances,
          appearance: new Cesium.PolylineColorAppearance(),
          classificationType: Cesium.ClassificationType.BOTH,
          asynchronous: true,
          allowPicking: false,
          releaseGeometryInstances: canSetAttr,
        }),
      );
      pendingPieces = list;
      pending = { prim: p, started: performance.now(), poll: null };
      // Colours asked for while it builds apply as it lands.
      if (!canSetAttr) {
        swapIn(p, list);
        pending = null;
        return;
      }
      pending.poll = setInterval(() => {
        if (!pending) return;
        if (!pending.prim.ready && performance.now() - pending.started < 20_000) {
          scene.requestRender(); // workers only progress on rendered frames
          return;
        }
        clearInterval(pending.poll);
        const done = pending;
        const lst = pendingPieces;
        pending = null;
        pendingPieces = null;
        swapIn(done.prim, lst);
      }, 120);
      scene.requestRender();
    },
    /**
     * Set every piece's colour from `colorOf(routeIndex, piece)` (return one
     * of a few shared Color constants); only pieces whose colour changed are
     * written.
     */
    paint(colorOf) {
      for (const list of [pieces, pendingPieces]) {
        if (!list) continue;
        for (const e of list)
          e.want = colorOf(e.route, e.piece) ?? Cesium.Color.TRANSPARENT;
      }
      apply(pieces, prim);
    },
    clear() {
      this.build([]);
    },
    destroy() {
      discardPending();
      drop(prim);
      prim = null;
      pieces = [];
    },
  };
}
