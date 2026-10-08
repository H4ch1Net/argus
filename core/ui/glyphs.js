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
  // An ALPR reader: a square camera body with its lens, over the reader's
  // light bar. Mapped LOCATION only (the layer never reads what it sees).
  alpr: (g, px) => {
    const m = px / 2;
    g.fillStyle = KEYLINE;
    g.fillRect(1.5, 1, px - 3, px - 2);
    g.strokeStyle = INK;
    g.lineWidth = 1.5;
    g.strokeRect(3.25, 2.75, px - 6.5, 7);
    g.fillStyle = INK;
    g.fillRect(m - 1.5, 4.75, 3, 3);
    g.fillRect(2.5, 11.5, px - 5, 2.5);
  },
  // A cross mark: a collision.
  xmark: (g, px) => {
    for (const [stroke, width] of [
      [KEYLINE, 4.5],
      [INK, 2],
    ]) {
      g.strokeStyle = stroke;
      g.lineWidth = width;
      g.beginPath();
      g.moveTo(3, 3);
      g.lineTo(px - 3, px - 3);
      g.moveTo(px - 3, 3);
      g.lineTo(3, px - 3);
      g.stroke();
    }
  },
  // Stacked bars: a queue (traffic jam).
  queue: (g, px) => {
    g.fillStyle = KEYLINE;
    g.fillRect(2, 2, px - 4, px - 4);
    g.fillStyle = INK;
    for (const y of [3.5, 7, 10.5]) g.fillRect(3.5, y, px - 7, 2);
  },
  // A striped barrier board on two legs: roadworks and work zones.
  barrier: (g, px) => {
    g.fillStyle = KEYLINE;
    g.fillRect(1, 4, px - 2, 8);
    g.fillRect(2.8, 11, 2.8, 4.2);
    g.fillRect(px - 5.6, 11, 2.8, 4.2);
    g.fillStyle = INK;
    g.fillRect(2.2, 5.2, px - 4.4, 5.6);
    g.fillRect(3.6, 11, 1.2, 3.6);
    g.fillRect(px - 4.8, 11, 1.2, 3.6);
    g.save();
    g.beginPath();
    g.rect(2.2, 5.2, px - 4.4, 5.6);
    g.clip();
    g.strokeStyle = KEYLINE;
    g.lineWidth = 1.6;
    for (let x = -4; x < px + 4; x += 4) {
      g.beginPath();
      g.moveTo(x, 12);
      g.lineTo(x + 6, 4);
      g.stroke();
    }
    g.restore();
  },
  // A solid square with a bar across it: a road closed.
  noentry: (g, px) => {
    g.fillStyle = KEYLINE;
    g.fillRect(1.5, 1.5, px - 3, px - 3);
    g.fillStyle = INK;
    g.fillRect(2.8, 2.8, px - 5.6, px - 5.6);
    g.fillStyle = KEYLINE;
    g.fillRect(4.5, px / 2 - 1.4, px - 9, 2.8);
  },
  // Slanted strokes: weather on the road (rain, fog, ice, wind, flooding).
  rain: (g, px) => {
    for (const [stroke, width] of [
      [KEYLINE, 4],
      [INK, 1.8],
    ]) {
      g.strokeStyle = stroke;
      g.lineWidth = width;
      g.beginPath();
      for (const x of [4, 8, 12]) {
        g.moveTo(x + 1.5, 2.5);
        g.lineTo(x - 1.5, px - 2.5);
      }
      g.stroke();
    }
  },
  // A hollow square with an arrow leaving it: a Tor exit relay.
  exit: (g, px) => {
    g.strokeStyle = KEYLINE;
    g.lineWidth = 3.5;
    g.strokeRect(2.5, 4.5, px - 7, px - 7);
    g.strokeStyle = INK;
    g.lineWidth = 1.5;
    g.strokeRect(2.5, 4.5, px - 7, px - 7);
    for (const [stroke, width] of [
      [KEYLINE, 4],
      [INK, 1.6],
    ]) {
      g.strokeStyle = stroke;
      g.lineWidth = width;
      g.beginPath();
      g.moveTo(px / 2 - 1, px / 2 + 1);
      g.lineTo(px - 2.5, 2.5);
      g.moveTo(px - 7, 2.5);
      g.lineTo(px - 2.5, 2.5);
      g.lineTo(px - 2.5, 7);
      g.stroke();
    }
  },
  // A thick square ring: a Tor guard (entry) relay.
  guard: (g, px) => {
    g.fillStyle = KEYLINE;
    g.fillRect(1.5, 1.5, px - 3, px - 3);
    g.fillStyle = INK;
    g.fillRect(2.8, 2.8, px - 5.6, px - 5.6);
    g.fillStyle = KEYLINE;
    g.fillRect(6, 6, px - 12, px - 12);
  },
  // A page with text lines: a news report.
  news: (g, px) => {
    g.fillStyle = KEYLINE;
    g.fillRect(2, 1, px - 4, px - 2);
    g.strokeStyle = INK;
    g.lineWidth = 1.4;
    g.strokeRect(3.2, 2.2, px - 6.4, px - 4.4);
    g.fillStyle = INK;
    for (const [y, w] of [
      [5, 1],
      [8, 1],
      [11, 0.6],
    ])
      g.fillRect(5, y, (px - 10) * w, 1.5);
  },
  // A square half filled: day and night (the terminator).
  half: (g, px) => {
    g.fillStyle = KEYLINE;
    g.fillRect(1.5, 1.5, px - 3, px - 3);
    g.strokeStyle = INK;
    g.lineWidth = 1.5;
    g.strokeRect(2.75, 2.75, px - 5.5, px - 5.5);
    g.fillStyle = INK;
    g.fillRect(2.75, 2.75, (px - 5.5) / 2, px - 5.5);
  },
  // Two zigzag bands: an aurora curtain.
  wave: (g, px) => {
    for (const [stroke, width] of [
      [KEYLINE, 4],
      [INK, 1.6],
    ]) {
      g.strokeStyle = stroke;
      g.lineWidth = width;
      g.beginPath();
      for (const y of [5.5, 10.5]) {
        g.moveTo(2, y + 1.5);
        g.lineTo(5.5, y - 1.5);
        g.lineTo(9, y + 1.5);
        g.lineTo(12.5, y - 1.5);
        g.lineTo(14, y);
      }
      g.stroke();
    }
  },
  // Four field cells of differing strength: a sampled field (air quality).
  cells: (g, px) => {
    const s = (px - 7) / 2;
    g.fillStyle = KEYLINE;
    g.fillRect(1.5, 1.5, px - 3, px - 3);
    g.fillStyle = INK;
    g.fillRect(3, 3, s, s);
    g.fillRect(4 + s, 4 + s, s, s);
    g.globalAlpha = 0.5;
    g.fillRect(4 + s, 3, s, s);
    g.fillRect(3, 4 + s, s, s);
    g.globalAlpha = 1;
  },
};

// --- Public webcams (core/layers/webcams) and border waits ---------------------
// A webcam is the camera brackets (something that watches, as for traffic
// cameras) around a small pictogram of what the camera is FOR: a road, a
// skyline, a wave, a peak. One glyph per category; the layer tints them all
// with its own ink, so only the shape tells categories apart.

/** Corner brackets plus a keyline ground in the middle for a pictogram. */
function camBrackets(g, px) {
  const a = px * 0.28;
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
  g.fillStyle = KEYLINE;
  g.fillRect(4, 4, px - 8, px - 8);
  g.fillStyle = INK;
}
const rects = (g, list) => {
  for (const [x, y, w, h] of list) g.fillRect(x, y, w, h);
};
const poly = (g, pts) => {
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (const [x, y] of pts.slice(1)) g.lineTo(x, y);
  g.closePath();
  g.fill();
};
/** A webcam glyph: the brackets, then the pictogram drawn in ink. */
const cam = (draw) => (g, px) => {
  camBrackets(g, px);
  draw(g, px);
};

const CAMERA_SHAPES = {
  // Two lanes and a dashed centre line.
  'wc-traffic': cam((g) =>
    rects(g, [
      [5.5, 4.5, 1.4, 7],
      [9.1, 4.5, 1.4, 7],
      [7.6, 4.8, 0.8, 2],
      [7.6, 8.8, 0.8, 2],
    ]),
  ),
  // A skyline: three towers.
  'wc-city': cam((g) =>
    rects(g, [
      [5, 8, 1.8, 3.5],
      [7.1, 5, 1.8, 6.5],
      [9.2, 6.8, 1.8, 4.7],
    ]),
  ),
  // Two waves.
  'wc-beach': cam((g) => {
    g.strokeStyle = INK;
    g.lineWidth = 1.3;
    g.beginPath();
    for (const y of [6.6, 9.8]) {
      g.moveTo(4.8, y);
      g.lineTo(6.4, y - 1.4);
      g.lineTo(8, y);
      g.lineTo(9.6, y - 1.4);
      g.lineTo(11.2, y);
    }
    g.stroke();
  }),
  // An anchor: shank, stock, crown and flukes.
  'wc-harbor': cam((g) =>
    rects(g, [
      [7.4, 4.6, 1.2, 6.4],
      [5.6, 6, 4.8, 1.1],
      [5, 10.3, 6, 1.2],
      [5, 8.8, 1.2, 1.6],
      [9.8, 8.8, 1.2, 1.6],
    ]),
  ),
  // A peak.
  'wc-mountain': cam((g) =>
    poly(g, [
      [4.6, 11.5],
      [8, 4.6],
      [11.4, 11.5],
    ]),
  ),
  // Three bars of cloud or fog.
  'wc-weather': cam((g) =>
    rects(g, [
      [5.2, 5.4, 5.6, 1.2],
      [4.6, 7.9, 6.8, 1.2],
      [5.8, 10.4, 4.4, 1.2],
    ]),
  ),
  // An aircraft in plan: fuselage, wings, tailplane.
  'wc-airport': cam((g) =>
    rects(g, [
      [7.35, 4.5, 1.3, 7],
      [4.6, 7.2, 6.8, 1.3],
      [6, 10.3, 4, 1.1],
    ]),
  ),
  // A conifer.
  'wc-park': cam((g) => {
    poly(g, [
      [5.2, 9.2],
      [8, 4.5],
      [10.8, 9.2],
    ]);
    g.fillRect(7.4, 9.2, 1.2, 2.3);
  }),
  // A paw: a pad and three toes.
  'wc-wildlife': cam((g) =>
    rects(g, [
      [6.3, 8.4, 3.4, 3],
      [5, 5.6, 1.6, 1.8],
      [7.2, 4.7, 1.6, 1.8],
      [9.4, 5.6, 1.6, 1.8],
    ]),
  ),
  // Two rails on three sleepers.
  'wc-rail': cam((g) =>
    rects(g, [
      [5.6, 4.5, 1, 7],
      [9.4, 4.5, 1, 7],
      [4.8, 5.3, 6.4, 0.9],
      [4.8, 7.6, 6.4, 0.9],
      [4.8, 9.9, 6.4, 0.9],
    ]),
  ),
  // A pediment on three columns.
  'wc-campus': cam((g) => {
    poly(g, [
      [4.6, 7.2],
      [8, 4.6],
      [11.4, 7.2],
    ]);
    rects(g, [
      [5.4, 7.8, 1.1, 2.6],
      [7.45, 7.8, 1.1, 2.6],
      [9.5, 7.8, 1.1, 2.6],
      [4.8, 10.6, 6.4, 0.9],
    ]);
  }),
  // A tower crane: mast, jib, hook and load.
  'wc-construction': cam((g) =>
    rects(g, [
      [5.6, 4.6, 1.2, 6.9],
      [5.6, 4.6, 5.8, 1.1],
      [10, 5.7, 0.8, 3],
      [9.5, 8.6, 1.8, 1.4],
      [4.6, 10.6, 3.4, 0.9],
    ]),
  ),
  // An observatory dome with its slit open.
  'wc-observatory': cam((g) => {
    poly(g, [
      [4.8, 11.5],
      [4.8, 8.2],
      [6.2, 5.6],
      [9.8, 5.6],
      [11.2, 8.2],
      [11.2, 11.5],
    ]);
    g.fillStyle = KEYLINE;
    g.fillRect(7.5, 5.6, 1, 3.6);
  }),
  // The Earth as the ctOS hub: a solid diamond.
  'wc-space': cam((g) =>
    poly(g, [
      [8, 4.6],
      [11.4, 8],
      [8, 11.4],
      [4.6, 8],
    ]),
  ),
  // Anything else: the plain camera dot.
  'wc-other': cam((g) => g.fillRect(6, 6, 4, 4)),
  // A border crossing: a striped barrier between two posts.
  gate: (g, px) => {
    g.fillStyle = KEYLINE;
    g.fillRect(1.5, 2, 4, 13);
    g.fillRect(px - 5.5, 2, 4, 13);
    g.fillRect(1.5, 5.5, px - 3, 4.5);
    g.fillStyle = INK;
    g.fillRect(2.5, 3, 2, 11);
    g.fillRect(px - 4.5, 3, 2, 11);
    g.fillRect(2.5, 6.5, px - 5, 2.5);
    g.fillStyle = KEYLINE;
    g.fillRect(5.6, 6.5, 1.4, 2.5);
    g.fillRect(8.4, 6.5, 1.4, 2.5);
  },
};
for (const [name, draw] of Object.entries(CAMERA_SHAPES)) SHAPES[name] ??= draw;

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
