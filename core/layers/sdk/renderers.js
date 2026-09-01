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

// Shared soft-glow disc sprite for point markers: a white radial gradient (bright
// core -> soft halo -> transparent) that a billboard tints per entity. This gives
// points real depth and glow instead of flat dots, one coherent look across every
// point layer. The core is ~40% of the sprite, so scale = pixelSize / GLOW_CORE_PX
// keeps the crisp centre close to the definition's requested pixel size.
const GLOW_SPRITE_PX = 64;
const GLOW_CORE_PX = 22;
let glowSpriteCache = null;
function glowDotImage() {
  if (glowSpriteCache) return glowSpriteCache;
  const c = document.createElement('canvas');
  c.width = GLOW_SPRITE_PX;
  c.height = GLOW_SPRITE_PX;
  const ctx = c.getContext('2d');
  const r = GLOW_SPRITE_PX / 2;
  const g = ctx.createRadialGradient(r, r, 0, r, r, r);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.28, 'rgba(255,255,255,0.95)'); // crisp core
  g.addColorStop(0.5, 'rgba(255,255,255,0.35)'); // glow falloff
  g.addColorStop(1, 'rgba(255,255,255,0)'); // fade to nothing
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.fill();
  glowSpriteCache = c;
  return c;
}

const renderers = {
  // Glowing, distance-scaled marker. Billboard tinted by the definition's color,
  // sized from its pixelSize, shrinking and fading with distance for depth.
  point: {
    create(entity, normalized, render) {
      entity.billboard = new Cesium.BillboardGraphics({
        image: glowDotImage(),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance:
          render.scaleByDistance ?? new Cesium.NearFarScalar(1e6, 1.0, 2.4e7, 0.4),
        translucencyByDistance:
          render.translucencyByDistance ?? new Cesium.NearFarScalar(6e6, 1.0, 3e7, 0.5),
      });
    },
    update(entity, normalized, render) {
      const style = render.style ? render.style(normalized) : {};
      const b = entity.billboard;
      // The sprite is white, so the billboard colour is the marker colour; keep
      // it fully opaque (the sprite's own alpha ramp supplies the soft edge).
      const color = style.color ?? Cesium.Color.WHITE;
      b.color = color.alpha < 1 ? color.withAlpha(1) : color;
      const px = style.pixelSize ?? render.pixelSize ?? 8;
      b.scale = px / GLOW_CORE_PX;
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
        width: render.width ?? 2.5,
        arcType: Cesium.ArcType.NONE, // heights are already baked into the samples
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: render.glowPower ?? 0.3,
          taperPower: render.taperPower ?? 0.5,
          color: Cesium.Color.WHITE,
        }),
        // Where the arc passes behind terrain, still show it (dimmed) rather than
        // letting the mesh swallow it. Matters now that real 3D terrain is on.
        depthFailMaterial: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.4,
          color: Cesium.Color.WHITE.withAlpha(0.35),
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
  entity.polyline.depthFailMaterial.color = color.withAlpha(0.35);
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
