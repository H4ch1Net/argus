// Which of the things under a tap wins. Pure (no Cesium): picker.js classifies
// Cesium's drill-pick results into candidates and asks this module.
//
// A storm cone or a fire perimeter covers a big part of the screen, so a tap on
// a camera inside it used to select the storm. Contacts (points, billboards,
// models, cluster markers) now beat lines (cables, tracks, arcs), and lines
// beat areas (cones, perimeters, polygons); an area is selected only when
// nothing else is under the finger. Within a class the drill order decides
// (Cesium returns the objects nearest the tap first). A contact behind the
// planet (drawn without depth test, so it could still be hit) never counts.

export const PICK_POINT = 0;
export const PICK_LINE = 1;
export const PICK_AREA = 2;

/**
 * @param {Array<{ target: object, cls: number, occluded?: boolean,
 *   accepted?: boolean } | null>} candidates in drill order
 * @returns {object | null} the winning target
 */
export function choosePick(candidates) {
  let best = null;
  for (const c of candidates) {
    if (!c?.target || c.occluded || c.accepted === false) continue;
    if (!best || c.cls < best.cls) best = c;
    if (best.cls === PICK_POINT) break; // nothing outranks the nearest contact
  }
  return best ? best.target : null;
}

/**
 * The class of an Entity hit (line layers, query outputs, decorations), from
 * the graphics it carries. primitiveKind is what Cesium says was drawn at the
 * tap: 'point' for a billboard, point or label (an arc's travelling pulse is a
 * point on a polyline Entity), 'model', or anything else.
 */
export function entityPickClass(entity, primitiveKind) {
  if (primitiveKind === 'point' || primitiveKind === 'model') return PICK_POINT;
  if (!entity) return PICK_AREA;
  if (
    entity.polygon ||
    entity.ellipse ||
    entity.rectangle ||
    entity.corridor ||
    entity.wall ||
    entity.ellipsoid ||
    entity.box ||
    entity.cylinder
  )
    return PICK_AREA;
  if (entity.polyline || entity.polylineVolume || entity.path) return PICK_LINE;
  if (entity.billboard || entity.point || entity.label || entity.model) return PICK_POINT;
  return PICK_AREA;
}
