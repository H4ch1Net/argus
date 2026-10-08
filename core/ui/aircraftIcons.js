// Aircraft silhouettes per class, drawn once onto canvases and handed to
// billboards under stable ids (one atlas copy per class however many aircraft
// use it). White with a dark keyline, so a billboard colour tints the body and
// the keyline keeps it legible over bright imagery. Nose up (north); the layer
// rotates each billboard to the aircraft's track.
//
// Shapes adapted from gods-eye-view src/data/aircraftIcons.js (MIT), whose
// glyph language comes from skylight (https://github.com/cpaczek/skylight, MIT).
// Browser only (canvas): definitions use it, the terminal shell never does.

const VIEW = 96; // the source viewBox; shapes are centred on (0, 0)
const RASTER = 64; // canvas pixels per glyph
const KEYLINE = 'rgba(14,14,14,0.9)';

// Each op: { p: svg path } | { rect: [x, y, w, h, r] } | { circle: [cx, cy, r] }
// | { ellipse: [cx, cy, rx, ry] }, with a = fill alpha (default 1), k = draw a
// keyline under it, rot = [deg, cx, cy] rotation for that op.
const BODIES = {
  airliner: [
    {
      k: true,
      p: 'M0,-42 C3.8,-40 4.6,-34 4.6,-26 L4.6,-14 L32,4 L34,6 L34,10 L31.4,9.2 L4.6,2.4 L4.2,20 L14,28 L14,32 L0,28.6 L-14,32 L-14,28 L-4.2,20 L-4.6,2.4 L-31.4,9.2 L-34,10 L-34,6 L-32,4 L-4.6,-14 L-4.6,-26 C-4.6,-34 -3.8,-40 0,-42 Z',
    },
    { p: 'M-15.5,-1.5 l3,7.6 4,-1.4 -1.5,-8.4 Z' },
    { p: 'M15.5,-1.5 l-3,7.6 -4,-1.4 1.5,-8.4 Z' },
  ],
  widebody: [
    {
      k: true,
      p: 'M0,-45 C5.6,-43 6.8,-36 6.8,-27 L6.8,-12 L38,9 L41.5,12.4 L41.5,16.6 L37.6,15 L6.8,6 L6.3,21 L17,30 L17,34.6 L0,30.4 L-17,34.6 L-17,30 L-6.3,21 L-6.8,6 L-37.6,15 L-41.5,16.6 L-41.5,12.4 L-38,9 L-6.8,-12 L-6.8,-27 C-6.8,-36 -5.6,-43 0,-45 Z',
    },
    { p: 'M-19,2 l3.6,9 4.8,-1.7 -1.8,-10 Z' },
    { p: 'M19,2 l-3.6,9 -4.8,-1.7 1.8,-10 Z' },
  ],
  quadjet: [
    {
      k: true,
      p: 'M0,-45 C7,-42 9,-34 9,-25 L9,-11 L46,12 L46,21 L9,11.5 L8.4,21 L20,31 L20,37.5 L0,32 L-20,37.5 L-20,31 L-8.4,21 L-9,11.5 L-46,21 L-46,12 L-9,-11 L-9,-25 C-9,-34 -7,-42 0,-45 Z',
    },
    { rect: [-31, 9, 7, 12, 2] },
    { rect: [-17, 4.5, 7, 12, 2] },
    { rect: [10, 4.5, 7, 12, 2] },
    { rect: [24, 9, 7, 12, 2] },
  ],
  turboprop: [
    {
      k: true,
      p: 'M0,-40 C3.4,-38.5 4.2,-33 4.2,-26 L4.2,-18 L36,-15.5 L36,-7.5 L4.2,-8 L3.8,22 L13,27.5 L13,31.5 L0,28.6 L-13,31.5 L-13,27.5 L-3.8,22 L-4.2,-8 L-36,-7.5 L-36,-15.5 L-4.2,-18 L-4.2,-26 C-4.2,-33 -3.4,-38.5 0,-40 Z',
    },
    { circle: [-17.5, -16.5, 7.5], a: 0.5 },
    { circle: [17.5, -16.5, 7.5], a: 0.5 },
    { p: 'M-19.5,-19 h4 v5 h-4 Z' },
    { p: 'M15.5,-19 h4 v5 h-4 Z' },
  ],
  bizjet: [
    {
      k: true,
      p: 'M0,-42 L2.6,-36 L3.4,-26 L3.4,-8 L27,8 L27,13 L3.6,6 L3.6,16 L8,18 L8,26 L3.8,25 L3.2,30 L15,34 L15,38 L2.4,36 L0,40 L-2.4,36 L-15,38 L-15,34 L-3.2,30 L-3.8,25 L-8,26 L-8,18 L-3.6,16 L-3.6,6 L-27,13 L-27,8 L-3.4,-8 L-3.4,-26 L-2.6,-36 Z',
    },
  ],
  light: [
    {
      k: true,
      p: 'M0,-27 C4,-25 5.2,-20 5.2,-13 L5.2,-9 L27,-9 L27,6 L5.2,6 L5.2,16 L11.5,23 L11.5,27 L0,23.5 L-11.5,27 L-11.5,23 L-5.2,16 L-5.2,6 L-27,6 L-27,-9 L-5.2,-9 L-5.2,-13 C-5.2,-20 -4,-25 0,-27 Z',
    },
    { ellipse: [0, -29, 12, 3.8], a: 0.5 },
  ],
  glider: [
    {
      k: true,
      p: 'M0,-35 C2.4,-33 3,-29 3,-25 L3,-14 L45,-10.5 L45,-3.5 L2.9,-6 L2.2,32 L-2.2,32 L-2.9,-6 L-45,-3.5 L-45,-10.5 L-3,-14 L-3,-25 C-3,-29 -2.4,-33 0,-35 Z',
    },
    { k: true, rect: [-10.5, 32.5, 21, 5, 1.5] },
  ],
  helicopter: [
    { circle: [0, -6, 31], a: 0.22 },
    { rect: [-30.5, -8.2, 61, 4.4, 2.2], a: 0.9, rot: [45, 0, -6] },
    { rect: [-30.5, -8.2, 61, 4.4, 2.2], a: 0.9, rot: [135, 0, -6] },
    {
      k: true,
      p: 'M0,-22 C8,-20 10.5,-13 10.5,-6 C10.5,2 7.5,7 0,8.5 C-7.5,7 -10.5,2 -10.5,-6 C-10.5,-13 -8,-20 0,-22 Z',
    },
    { k: true, p: 'M-2.6,8 L2.6,8 L1.8,32 L-1.8,32 Z' },
    { p: 'M-8,27 L8,27 L8,30.6 L-8,30.6 Z' },
    { circle: [5.6, 35, 6], a: 0.6 },
  ],
  fastjet: [
    {
      k: true,
      p: 'M0,-43 L3.5,-30 C4,-24 4.6,-16 5,-8 L27,20 L27,26 L6,16 L8,30 L8,34 L3,31 L3,38 L6.5,42 L6.5,44 L0,41.5 L-6.5,44 L-6.5,42 L-3,38 L-3,31 L-8,34 L-8,30 L-6,16 L-27,26 L-27,20 L-5,-8 C-4.6,-16 -4,-24 -3.5,-30 Z',
    },
  ],
  uav: [
    {
      k: true,
      p: 'M0,-40 C3.6,-40 4.6,-35 4.4,-30 L2.4,-12 L43,-7 L43,-2.5 L2.3,0 L2.1,24 L13,32 L13,36 L1.6,30 L0,38 L-1.6,30 L-13,36 L-13,32 L-2.1,24 L-2.3,0 L-43,-2.5 L-43,-7 L-2.4,-12 L-4.4,-30 C-4.6,-35 -3.6,-40 0,-40 Z',
    },
  ],
};

function shapePath(op) {
  const path = new Path2D();
  if (op.p) path.addPath(new Path2D(op.p));
  else if (op.rect) {
    const [x, y, w, h, r] = op.rect;
    if (path.roundRect) path.roundRect(x, y, w, h, r);
    else path.rect(x, y, w, h);
  } else if (op.circle) {
    const [cx, cy, r] = op.circle;
    path.arc(cx, cy, r, 0, Math.PI * 2);
  } else if (op.ellipse) {
    const [cx, cy, rx, ry] = op.ellipse;
    path.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  }
  return path;
}

function draw(kind) {
  const c = document.createElement('canvas');
  c.width = RASTER;
  c.height = RASTER;
  const g = c.getContext('2d');
  const s = RASTER / VIEW;
  g.setTransform(s, 0, 0, s, RASTER / 2, RASTER / 2);
  g.lineJoin = 'round';
  const ops = BODIES[kind] ?? BODIES.airliner;
  // Keylines first (one pass), so no body is drawn over another's outline.
  for (const op of ops) {
    if (!op.k) continue;
    g.save();
    if (op.rot) rotateAbout(g, op.rot);
    g.strokeStyle = KEYLINE;
    g.lineWidth = 5;
    g.stroke(shapePath(op));
    g.restore();
  }
  for (const op of ops) {
    g.save();
    if (op.rot) rotateAbout(g, op.rot);
    g.globalAlpha = op.a ?? 1;
    g.fillStyle = '#ffffff';
    g.fill(shapePath(op));
    g.restore();
  }
  return c;
}

function rotateAbout(g, [deg, cx, cy]) {
  g.translate(cx, cy);
  g.rotate((deg * Math.PI) / 180);
  g.translate(-cx, -cy);
}

const cache = new Map();

/**
 * The silhouette for an aircraft class: { id, image, px } in the same shape as
 * core/ui/glyphs.js, so the SDK's billboard renderer can place it.
 */
export function aircraftGlyph(kind) {
  const key = BODIES[kind] ? kind : 'airliner';
  let g = cache.get(key);
  if (!g) {
    g = { id: `argus-aircraft-${key}`, image: draw(key), px: RASTER };
    cache.set(key, g);
  }
  return g;
}
