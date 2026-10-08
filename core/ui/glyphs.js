// Map glyphs in the ctOS idiom (design/ctos: square shapes, hairlines, the
// diamond hub and square satellite nodes of Bagley's tracking graph). Each glyph
// is drawn once, in white, onto a canvas at twice its nominal size, and handed
// to billboards under a stable id so the texture atlas holds one copy however
// many entities use it; billboards tint it per entity.
//
// Browser only (canvas). Layer definitions use it; the terminal shell never
// imports it.

const DENSITY = 2; // canvas pixels per CSS pixel, for crisp edges on hiDPI

const INK = '#ffffff';
const KEYLINE = 'rgba(14,14,14,0.92)'; // ctOS ground, so glyphs stay legible on bright imagery

function canvas(px) {
  const c = document.createElement('canvas');
  c.width = px * DENSITY;
  c.height = px * DENSITY;
  const g = c.getContext('2d');
  g.scale(DENSITY, DENSITY);
  g.lineJoin = 'miter';
  g.lineCap = 'butt';
  return { c, g };
}

// Each shape draws at nominal size px (16 unless noted), centred.
const SHAPES = {
  // Bagley's satellite node: a hairline square with a filled core.
  node: (g, px) => {
    const m = px / 2;
    g.fillStyle = KEYLINE;
    g.fillRect(1, 1, px - 2, px - 2);
    g.strokeStyle = INK;
    g.lineWidth = 1.5;
    g.strokeRect(2.25, 2.25, px - 4.5, px - 4.5);
    g.fillStyle = INK;
    g.fillRect(m - 2.5, m - 2.5, 5, 5);
  },
  // A solid square with a dark keyline.
  square: (g, px) => {
    g.fillStyle = KEYLINE;
    g.fillRect(2, 2, px - 4, px - 4);
    g.fillStyle = INK;
    g.fillRect(3.5, 3.5, px - 7, px - 7);
  },
  // The ctOS diamond: a rotated square outline with a filled inner diamond.
  diamond: (g, px) => {
    const m = px / 2;
    const r = m - 1.5;
    const path = (rad) => {
      g.beginPath();
      g.moveTo(m, m - rad);
      g.lineTo(m + rad, m);
      g.lineTo(m, m + rad);
      g.lineTo(m - rad, m);
      g.closePath();
    };
    path(r);
    g.fillStyle = KEYLINE;
    g.fill();
    g.strokeStyle = INK;
    g.lineWidth = 1.5;
    path(r - 1);
    g.stroke();
    path(r * 0.42);
    g.fillStyle = INK;
    g.fill();
  },
  // A hollow square: places and facilities (data centres, landmarks).
  frame: (g, px) => {
    g.strokeStyle = KEYLINE;
    g.lineWidth = 3.5;
    g.strokeRect(3, 3, px - 6, px - 6);
    g.strokeStyle = INK;
    g.lineWidth = 1.5;
    g.strokeRect(3, 3, px - 6, px - 6);
  },
  // Corner brackets around a dot: cameras and sensors (something that watches).
  bracket: (g, px) => {
    const a = px * 0.32;
    const corners = [
      [2, 2, 1, 1],
      [px - 2, 2, -1, 1],
      [2, px - 2, 1, -1],
      [px - 2, px - 2, -1, -1],
    ];
    for (const [stroke, width] of [
      [KEYLINE, 3.5],
      [INK, 1.5],
    ]) {
      g.strokeStyle = stroke;
      g.lineWidth = width;
      for (const [x, y, sx, sy] of corners) {
        g.beginPath();
        g.moveTo(x + sx * a, y);
        g.lineTo(x, y);
        g.lineTo(x, y + sy * a);
        g.stroke();
      }
    }
    g.fillStyle = INK;
    g.fillRect(px / 2 - 2, px / 2 - 2, 4, 4);
  },
  // A plus: transmitters, stations, pads.
  cross: (g, px) => {
    const m = px / 2;
    g.fillStyle = KEYLINE;
    g.fillRect(m - 3, 1, 6, px - 2);
    g.fillRect(1, m - 3, px - 2, 6);
    g.fillStyle = INK;
    g.fillRect(m - 1.25, 2.5, 2.5, px - 5);
    g.fillRect(2.5, m - 1.25, px - 5, 2.5);
  },
  // A triangle: hazards (fires, storms).
  triangle: (g, px) => {
    const tri = (inset) => {
      g.beginPath();
      g.moveTo(px / 2, inset);
      g.lineTo(px - inset, px - inset);
      g.lineTo(inset, px - inset);
      g.closePath();
    };
    tri(1);
    g.fillStyle = KEYLINE;
    g.fill();
    tri(3);
    g.fillStyle = INK;
    g.fill();
  },
  // The one round shape ctOS allows (a status dot): small fast movers in bulk.
  dot: (g, px) => {
    const m = px / 2;
    g.fillStyle = KEYLINE;
    g.beginPath();
    g.arc(m, m, m - 2, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = INK;
    g.beginPath();
    g.arc(m, m, m - 4, 0, Math.PI * 2);
    g.fill();
  },
  // Concentric squares: an event with a magnitude (earthquakes).
  pulse: (g, px) => {
    g.strokeStyle = KEYLINE;
    g.lineWidth = 3;
    g.strokeRect(1.5, 1.5, px - 3, px - 3);
    g.strokeStyle = INK;
    g.lineWidth = 1;
    g.strokeRect(1.5, 1.5, px - 3, px - 3);
    g.fillStyle = KEYLINE;
    g.fillRect(px * 0.28, px * 0.28, px * 0.44, px * 0.44);
    g.fillStyle = INK;
    g.fillRect(px * 0.33, px * 0.33, px * 0.34, px * 0.34);
  },
  // A vessel in plan view, bow up (the layer rotates it to the heading).
  hull: (g, px) => {
    const m = px / 2;
    const hull = (inset) => {
      g.beginPath();
      g.moveTo(m, 1 + inset);
      g.lineTo(m + 4.2 - inset, 5.5 + inset);
      g.lineTo(m + 4.2 - inset, px - 1.5 - inset);
      g.lineTo(m - 4.2 + inset, px - 1.5 - inset);
      g.lineTo(m - 4.2 + inset, 5.5 + inset);
      g.closePath();
    };
    hull(0);
    g.fillStyle = KEYLINE;
    g.fill();
    hull(1.4);
    g.fillStyle = INK;
    g.fill();
    g.fillStyle = KEYLINE;
    g.fillRect(m - 1.5, px * 0.55, 3, 2.5); // the bridge
  },
  // A road or rail vehicle in plan view, front up.
  vehicle: (g, px) => {
    const m = px / 2;
    g.fillStyle = KEYLINE;
    g.fillRect(m - 4.5, 1, 9, px - 2);
    g.fillStyle = INK;
    g.fillRect(m - 3.2, 2.3, 6.4, px - 4.6);
    g.fillStyle = KEYLINE;
    g.fillRect(m - 3.2, 4.5, 6.4, 1.6); // windscreen
  },
  // A satellite: a square bus between two solar panels.
  sat: (g, px) => {
    const m = px / 2;
    g.fillStyle = KEYLINE;
    g.fillRect(1, m - 3, px - 2, 6);
    g.fillRect(m - 3.5, m - 3.5, 7, 7);
    g.fillStyle = INK;
    g.fillRect(2.2, m - 1.8, m - 5.6, 3.6);
    g.fillRect(m + 3.4, m - 1.8, m - 5.6, 3.6);
    g.fillRect(m - 2.3, m - 2.3, 4.6, 4.6);
  },
};

export const GLYPH_NAMES = Object.keys(SHAPES);

const cache = new Map();

/**
 * A marker glyph by name: { id, image, px } where px is its nominal size (a
 * billboard scale of pixelSize / px draws it pixelSize across).
 */
export function glyph(name) {
  if (cache.has(name)) return cache.get(name);
  const draw = SHAPES[name] ?? SHAPES.node;
  const px = 16;
  const { c, g } = canvas(px);
  draw(g, px);
  const out = { id: `argus-glyph-${name}`, image: c, px: px * DENSITY };
  cache.set(name, out);
  return out;
}

let imageIds = new WeakMap();
let nextImageId = 0;

/**
 * A stable atlas id for any canvas or image (for definitions that draw their own
 * glyphs, such as aircraft silhouettes), or pass through a glyph() result.
 */
export function imageGlyph(image) {
  if (image && image.id && image.image) return image;
  let id = imageIds.get(image);
  if (!id) {
    id = `argus-image-${(nextImageId += 1)}`;
    imageIds.set(image, id);
  }
  return { id, image, px: image.width || 32 };
}

/** Testing aid: forget cached glyphs. */
export function _resetGlyphs() {
  cache.clear();
  imageIds = new WeakMap();
}
