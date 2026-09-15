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

// Shared "sensor contact" sprite for point markers: a tactical targeting reticle
// (bright core, thin ring, four cardinal ticks) over a restrained phosphor bloom.
// Drawn in white so a billboard tints it per entity, one coherent CRT/ops look
// across every point layer. The reticle ring is sized so scale = pixelSize /
// GLOW_CORE_PX puts the ring roughly at the definition's requested pixel size.
const GLOW_SPRITE_PX = 128; // hi-res so the thin ring stays crisp when scaled up
const GLOW_CORE_PX = 40; // ring diameter reference for pixelSize mapping
let glowSpriteCache = null;
function glowDotImage() {
  if (glowSpriteCache) return glowSpriteCache;
  const c = document.createElement('canvas');
  c.width = GLOW_SPRITE_PX;
  c.height = GLOW_SPRITE_PX;
  const ctx = c.getContext('2d');
  const cx = GLOW_SPRITE_PX / 2;
  const ring = 40; // ring radius (matches GLOW_CORE_PX diameter reference)

  const tIn = ring - 9;
  const tOut = ring + 9;
  const drawTicks = () => {
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(cx + dx * tIn, cx + dy * tIn);
      ctx.lineTo(cx + dx * tOut, cx + dy * tOut);
      ctx.stroke();
    }
  };

  // 1. Restrained phosphor bloom behind the glyph (not a giant gradient blob).
  const bloom = ctx.createRadialGradient(cx, cx, 0, cx, cx, ring * 1.5);
  bloom.addColorStop(0, 'rgba(255,255,255,0.30)');
  bloom.addColorStop(0.4, 'rgba(255,255,255,0.10)');
  bloom.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = bloom;
  ctx.fillRect(0, 0, GLOW_SPRITE_PX, GLOW_SPRITE_PX);

  // 2. Dark contrast pass, drawn thicker and underneath the bright glyph. The
  // billboard tint multiplies the sprite, and these near-black pixels stay dark
  // under any tint, so the reticle keeps a crisp edge on bright basemaps
  // (satellite, relief) while staying invisible against dark space.
  ctx.lineCap = 'butt';
  ctx.strokeStyle = 'rgba(3,6,9,0.8)';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(cx, cx, ring, 0, Math.PI * 2);
  ctx.stroke();
  drawTicks();
  ctx.fillStyle = 'rgba(3,6,9,0.85)';
  ctx.beginPath();
  ctx.arc(cx, cx, 11, 0, Math.PI * 2);
  ctx.fill();

  // 3. Bright outer ring.
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cx, ring, 0, Math.PI * 2);
  ctx.stroke();

  // 4. Bright cardinal targeting ticks.
  drawTicks();

  // 5. Faint inner reference ring (radar-scope feel).
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  ctx.arc(cx, cx, ring * 0.5, 0, Math.PI * 2);
  ctx.stroke();

  // 6. Solid bright core.
  ctx.fillStyle = 'rgba(255,255,255,1)';
  ctx.beginPath();
  ctx.arc(cx, cx, 7, 0, Math.PI * 2);
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
