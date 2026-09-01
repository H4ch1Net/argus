import * as Cesium from 'cesium';
import { arcSamples } from './greatCircle.js';

// renderType dispatch. One interface renders entity layers, and (later) raster
// fields and threat-map arcs, so there is never a parallel subsystem per the
// contract. Each renderer creates the entity's graphics once, then updates the
// dynamic bits from the definition's per-entity style(normalized) on each fix.
//
// Implemented now: point, billboard, arc (threat-map source->target). raster is
// declared as the extension point it will fill in its phase; asking for one
// before it exists fails loudly rather than silently rendering nothing.

export const RenderType = {
  POINT: 'point',
  BILLBOARD: 'billboard',
  TRAIL: 'trail',
  RASTER: 'raster',
  ARC: 'arc',
};

const renderers = {
  point: {
    create(entity) {
      entity.point = new Cesium.PointGraphics({
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    },
    update(entity, normalized, render) {
      const style = render.style ? render.style(normalized) : {};
      entity.point.pixelSize = style.pixelSize ?? render.pixelSize ?? 8;
      entity.point.color = style.color ?? Cesium.Color.WHITE;
      if (style.outlineColor) {
        entity.point.outlineColor = style.outlineColor;
        entity.point.outlineWidth = style.outlineWidth ?? 1;
      }
    },
  },

  billboard: {
    create(entity, normalized, render) {
      entity.billboard = new Cesium.BillboardGraphics({
        alignedAxis: Cesium.Cartesian3.ZERO,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance:
          render.scaleByDistance ?? new Cesium.NearFarScalar(1e6, 1.0, 2e7, 0.45),
      });
    },
    update(entity, normalized, render) {
      const style = render.style ? render.style(normalized) : {};
      const b = entity.billboard;
      if (style.image !== undefined) b.image = style.image;
      b.scale = style.scale ?? render.scale ?? 0.7;
      if (style.rotationRadians !== undefined) b.rotation = style.rotationRadians;
      if (style.color !== undefined) b.color = style.color;
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
        width: render.width ?? 2,
        arcType: Cesium.ArcType.NONE, // heights are already baked into the samples
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: render.glowPower ?? 0.25,
          taperPower: render.taperPower ?? 0.5,
          color: Cesium.Color.WHITE,
        }),
      });
      entity.point = new Cesium.PointGraphics({
        pixelSize: render.pulseSize ?? 6,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
      styleArc(entity, normalized, render);
    },
    update: styleArc,
  },
};

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
