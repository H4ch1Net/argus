import * as Cesium from 'cesium';
import { arcSamples } from './greatCircle.js';
import { glyph, imageGlyph } from '../../ui/glyphs.js';

// renderType dispatch. One interface renders every layer, so there is never a
// parallel subsystem per the contract.
//
// Primitive renderers (point, billboard) draw into the layer's
// BillboardCollection: create(collection, target, normalized, render) returns a
// Billboard, update(billboard, normalized, render) restyles it on each fix.
// Glyph canvases go into the collection's texture atlas once, under a stable id
// (core/ui/glyphs.js), however many billboards share them.
//
// Entity renderers (arc, polyline) draw line features through the Entity API,
// where Cesium batches static geometry: create(entity, normalized, render) and
// update(entity, normalized, render). Raster layers are imagery, handled by
// rasterLayer.js. Asking for any unknown type fails loudly.

export const RenderType = {
  POINT: 'point',
  BILLBOARD: 'billboard',
  TRAIL: 'trail',
  RASTER: 'raster',
  ARC: 'arc',
  POLYLINE: 'polyline',
  POLYGON: 'polygon',
};

const PRIMITIVE_TYPES = new Set([RenderType.POINT, RenderType.BILLBOARD]);
export const isPrimitiveRenderType = (t) => PRIMITIVE_TYPES.has(t);

// Glyphs stay full size up close and shrink toward the whole-Earth view, so a
// dense layer reads as texture from orbit and as individual contacts up close.
const POINT_SCALE = new Cesium.NearFarScalar(1.5e5, 1.0, 1.6e7, 0.5);
const BILLBOARD_SCALE = new Cesium.NearFarScalar(1.5e5, 1.0, 1.6e7, 0.55);

function setGlyph(b, g) {
  if (b._argusGlyph === g.id) return;
  b.setImage(g.id, g.image);
  b._argusGlyph = g.id;
}

function addBillboard(collection, target, render, defaults) {
  return collection.add({
    position: Cesium.Cartesian3.ZERO,
    show: false, // shown by the layer's frame loop once positioned and in view
    id: target,
    // Horizon culling is done by the layer, so glyphs never z-fight the ground.
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
    scaleByDistance: render.scaleByDistance ?? defaults.scale,
    translucencyByDistance: render.translucencyByDistance,
    alignedAxis: Cesium.Cartesian3.ZERO, // rotation is screen space
    verticalOrigin: Cesium.VerticalOrigin.CENTER,
    horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
  });
}

// Heading-up glyphs (aircraft, vessels) align their "up" to local north at the
// contact and rotate clockwise by the heading, so they point the right way in any
// camera orientation, not only under a north-up view.
const scratchNorth = new Cesium.Cartesian3();
function northAt(lonDeg, latDeg, result) {
  const lon = Cesium.Math.toRadians(lonDeg);
  const lat = Cesium.Math.toRadians(latDeg);
  result.x = -Math.sin(lat) * Math.cos(lon);
  result.y = -Math.sin(lat) * Math.sin(lon);
  result.z = Math.cos(lat);
  return result;
}

function orient(b, normalized, style) {
  const p = normalized.position;
  if (Number.isFinite(style.headingDeg) && p) {
    b.alignedAxis = northAt(p.longitude, p.latitude, scratchNorth);
    b.rotation = -Cesium.Math.toRadians(style.headingDeg);
  } else if (style.rotationRadians !== undefined) {
    b.alignedAxis = Cesium.Cartesian3.ZERO;
    b.rotation = style.rotationRadians;
  }
}

const renderers = {
  // A ctOS marker glyph (node, square, diamond, ...) tinted per entity, sized
  // from pixelSize. style(n) -> { glyph?, color, pixelSize?, headingDeg? }.
  point: {
    create: (collection, target, normalized, render) =>
      addBillboard(collection, target, render, { scale: POINT_SCALE }),
    update(b, normalized, render) {
      const style = render.style ? render.style(normalized) : {};
      const g = glyph(style.glyph ?? render.glyph ?? 'node');
      setGlyph(b, g);
      b.color = style.color ?? Cesium.Color.WHITE;
      b.scale = (style.pixelSize ?? render.pixelSize ?? 8) / g.px;
      orient(b, normalized, style);
    },
  },

  // An image glyph (aircraft silhouettes, vessel hulls). style(n) -> { image
  // (a glyph object or a canvas), color?, pixelSize? or scale?, headingDeg? }.
  billboard: {
    create: (collection, target, normalized, render) =>
      addBillboard(collection, target, render, { scale: BILLBOARD_SCALE }),
    update(b, normalized, render) {
      const style = render.style ? render.style(normalized) : {};
      const g = style.image !== undefined ? imageGlyph(style.image) : null;
      if (g) setGlyph(b, g);
      const px = style.pixelSize ?? render.pixelSize;
      b.scale = px && g ? px / g.px : (style.scale ?? render.scale ?? 0.7);
      if (style.color !== undefined) b.color = style.color;
      orient(b, normalized, style);
    },
  },

  // Threat-map arc: a bowed great-circle polyline source->target plus a bright
  // point that the definition's positionAt rides along it as a travelling pulse
  // (so the layer is a mover and animates). meta.arc = { from, to } in degrees.
  arc: {
    create(entity, normalized, render) {
      const { from, to } = normalized.meta.arc;
      const { points } = arcSamples(from, to, render.samples ?? 64);
      entity.polyline = new Cesium.PolylineGraphics({
        positions: points.map((p) =>
          Cesium.Cartesian3.fromDegrees(p.longitude, p.latitude, p.altitude),
        ),
        width: render.width ?? 2.5,
        arcType: Cesium.ArcType.NONE, // heights are already baked into the samples
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: render.glowPower ?? 0.3,
          taperPower: render.taperPower ?? 0.5,
          color: Cesium.Color.WHITE,
        }),
        // No depthFailMaterial: the segment behind the horizon must be hidden by
        // the globe (depthTestAgainstTerrain), not drawn dimmed through it. The
        // arc bows above the surface, so the visible portion clears the terrain.
      });
      entity.point = new Cesium.PointGraphics({
        pixelSize: render.pulseSize ?? 6,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
      styleArc(entity, normalized, render);
    },
    update: styleArc,
  },

  // A fixed path along the surface: meta.path = [[lon, lat], ...]. The entity's
  // own position (a point on the path) is what tracking and fly-to use. Clamped
  // to the ground by default so terrain never hides it; render.height instead
  // floats it at a fixed height (cheaper, e.g. for long sea-floor cables).
  polyline: {
    create(entity, normalized, render) {
      const path = normalized.meta.path;
      const positions =
        render.height != null
          ? Cesium.Cartesian3.fromDegreesArrayHeights(
              path.flatMap(([lon, lat]) => [lon, lat, render.height]),
            )
          : Cesium.Cartesian3.fromDegreesArray(path.flat());
      entity.polyline = new Cesium.PolylineGraphics({
        positions,
        width: render.width ?? 2,
        clampToGround: render.height == null && (render.clampToGround ?? true),
        arcType: Cesium.ArcType.GEODESIC,
        material: Cesium.Color.WHITE,
      });
      stylePolyline(entity, normalized, render);
    },
    update: stylePolyline,
  },
  // An area on the ground (a storm cone, a fire perimeter, a drawn region):
  // meta.polygon = [[lon, lat], ...] is the outer ring, meta.holes an optional
  // list of inner rings. A translucent fill plus a crisp outline, both clamped
  // to the ground. A new ring array on update rebuilds the geometry.
  polygon: {
    create(entity, normalized, render) {
      entity.polygon = new Cesium.PolygonGraphics({
        material: Cesium.Color.WHITE.withAlpha(0.15),
        outline: false,
      });
      entity.polyline = new Cesium.PolylineGraphics({
        width: render.width ?? 1.5,
        clampToGround: true,
        arcType: Cesium.ArcType.GEODESIC,
        material: Cesium.Color.WHITE,
      });
      stylePolygon(entity, normalized, render);
    },
    update: stylePolygon,
  },
};

const ringPositions = (ring) => Cesium.Cartesian3.fromDegreesArray(ring.flat());

function stylePolygon(entity, normalized, render) {
  const { polygon: outer, holes = [] } = normalized.meta;
  if (entity._argusRing !== outer && Array.isArray(outer) && outer.length >= 3) {
    entity._argusRing = outer;
    entity.polygon.hierarchy = new Cesium.PolygonHierarchy(
      ringPositions(outer),
      holes.map((h) => new Cesium.PolygonHierarchy(ringPositions(h))),
    );
    entity.polyline.positions = ringPositions([...outer, outer[0]]);
  }
  const style = render.style ? render.style(normalized) : {};
  const color = style.color ?? Cesium.Color.WHITE;
  entity.polygon.material = color.withAlpha(style.fillAlpha ?? render.fillAlpha ?? 0.15);
  entity.polyline.material = style.outlineColor ?? color.withAlpha(0.85);
  if (style.width != null) entity.polyline.width = style.width;
}

function stylePolyline(entity, normalized, render) {
  const style = render.style ? render.style(normalized) : {};
  if (style.color) entity.polyline.material = style.color;
  if (style.width != null) entity.polyline.width = style.width;
}

function styleArc(entity, normalized, render) {
  const style = render.style ? render.style(normalized) : {};
  const color = style.color ?? Cesium.Color.CYAN;
  entity.polyline.material.color = color;
  if (style.width != null) entity.polyline.width = style.width;
  entity.point.color = style.pulseColor ?? color.withAlpha(1);
  entity.point.pixelSize = style.pulseSize ?? render.pulseSize ?? 6;
}

export function getRenderer(renderType) {
  const renderer = renderers[renderType];
  if (!renderer) {
    throw new Error(`renderType "${renderType}" is not implemented yet`);
  }
  return renderer;
}
