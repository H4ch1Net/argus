import { h } from './dom.js';

// The user's own map marker: a small set of ctOS icons to choose from
// (SETTINGS > INTERFACE, the selfIcon setting). Each is drawn once in white
// with the dark keyline the map glyphs use (core/ui/glyphs.js), pointing up
// (north) so the marker rotates it to the heading, and centred on its middle
// so it turns about the fix. Every shell draws the same chosen icon: the globe
// marker (core/geo/selfMarker.js) and the car shell's own chevron.
//
// Browser only for the drawing (canvas); the list itself is plain data, so the
// settings schema and the tests can read it anywhere.

const DENSITY = 2; // canvas pixels per CSS pixel, as the map glyphs
const SIZE = 32; // nominal box, CSS pixels
const INK = '#ffffff';
const KEYLINE = 'rgba(14,14,14,0.92)';

/**
 * The icons, in picker order. directional: the shape itself shows the
 * heading; cue: it draws a separate heading mark only when a heading is known.
 */
export const SELF_ICONS = Object.freeze([
  { id: 'chevron', label: 'CHEVRON', directional: true },
  { id: 'triangle', label: 'CTOS TRI', directional: true },
  { id: 'diamond', label: 'DIAMOND', cue: true },
  { id: 'car', label: 'CAR', directional: true },
  { id: 'crosshair', label: 'CROSSHAIR' },
  { id: 'dot', label: 'DOT', cue: true },
  { id: 'beam', label: 'BEAM', cue: true },
]);

export const SELF_ICON_IDS = Object.freeze(SELF_ICONS.map((i) => i.id));
export const DEFAULT_SELF_ICON = 'chevron';

export const isSelfIcon = (id) => SELF_ICON_IDS.includes(id);

/** True when the icon should turn with the heading (shape or cue). */
export function turnsWithHeading(id) {
  const icon = SELF_ICONS.find((i) => i.id === id);
  return Boolean(icon && (icon.directional || icon.cue));
}

// ------------------------------------------------------------- drawing
// Every shape draws into a SIZE x SIZE box, nose up. `solid` lays the keyline
// as a wide dark stroke, then fills white over its inner half.

function poly(g, pts) {
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i += 1) g.lineTo(pts[i][0], pts[i][1]);
  g.closePath();
}

function solid(g, pts, key = 3) {
  poly(g, pts);
  g.strokeStyle = KEYLINE;
  g.lineWidth = key;
  g.stroke();
  g.fillStyle = INK;
  g.fill();
}

function hollow(g, pts, width = 1.8) {
  poly(g, pts);
  g.strokeStyle = KEYLINE;
  g.lineWidth = width + 2.4;
  g.stroke();
  poly(g, pts);
  g.strokeStyle = INK;
  g.lineWidth = width;
  g.stroke();
}

function strokes(g, segments, width = 1.6) {
  for (const [stroke, w] of [
    [KEYLINE, width + 2.2],
    [INK, width],
  ]) {
    g.strokeStyle = stroke;
    g.lineWidth = w;
    for (const seg of segments) {
      g.beginPath();
      g.moveTo(seg[0][0], seg[0][1]);
      for (let i = 1; i < seg.length; i += 1) g.lineTo(seg[i][0], seg[i][1]);
      g.stroke();
    }
  }
}

function disc(g, x, y, r, fill) {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fillStyle = fill;
  g.fill();
}

// The heading cue: a small solid caret above the icon.
const caret = (g) =>
  solid(
    g,
    [
      [16, 0.9],
      [19.6, 5.4],
      [12.4, 5.4],
    ],
    2.4,
  );

const SHAPES = {
  // A navigation arrowhead with a keyline ridge down its spine.
  chevron(g) {
    solid(g, [
      [16, 3],
      [27, 28],
      [16, 21.5],
      [5, 28],
    ]);
    g.strokeStyle = KEYLINE;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(16, 7.5);
    g.lineTo(16, 20);
    g.stroke();
  },
  // The ctOS triangle: a hairline outline round a solid core, apex ahead.
  triangle(g) {
    hollow(g, [
      [16, 3.2],
      [28.6, 27],
      [3.4, 27],
    ]);
    solid(
      g,
      [
        [16, 12],
        [21.6, 22.6],
        [10.4, 22.6],
      ],
      2.4,
    );
  },
  // The ctOS hub diamond, with a caret ahead when the heading is known.
  diamond(g, cue) {
    hollow(g, [
      [16, 6],
      [27, 17],
      [16, 28],
      [5, 17],
    ]);
    solid(
      g,
      [
        [16, 12.4],
        [20.6, 17],
        [16, 21.6],
        [11.4, 17],
      ],
      2.4,
    );
    if (cue) caret(g);
  },
  // A car in plan view, bonnet up: square-cut corners, dark glass.
  car(g) {
    solid(g, [
      [12.6, 3],
      [19.4, 3],
      [22.4, 6],
      [22.4, 26],
      [19.4, 29],
      [12.6, 29],
      [9.6, 26],
      [9.6, 6],
    ]);
    g.fillStyle = KEYLINE;
    poly(g, [
      [11.4, 10.2],
      [20.6, 10.2],
      [19.4, 14],
      [12.6, 14],
    ]);
    g.fill();
    poly(g, [
      [12.6, 22.4],
      [19.4, 22.4],
      [20.6, 25.2],
      [11.4, 25.2],
    ]);
    g.fill();
    g.fillRect(9.6, 15.2, 0.9, 6);
    g.fillRect(21.5, 15.2, 0.9, 6);
    for (const x of [6.6, 22.6]) {
      g.fillStyle = KEYLINE;
      g.fillRect(x, 10.6, 3, 2.6);
      g.fillStyle = INK;
      g.fillRect(x + 0.6, 11.2, 1.8, 1.4);
    }
  },
  // A ctOS reticle: corner brackets, four ticks and a centre point.
  crosshair(g) {
    const a = 6.5;
    strokes(
      g,
      [
        [
          [4, 4 + a],
          [4, 4],
          [4 + a, 4],
        ],
        [
          [28 - a, 4],
          [28, 4],
          [28, 4 + a],
        ],
        [
          [28, 28 - a],
          [28, 28],
          [28 - a, 28],
        ],
        [
          [4 + a, 28],
          [4, 28],
          [4, 28 - a],
        ],
      ],
      1.8,
    );
    strokes(g, [
      [
        [16, 7.5],
        [16, 12.5],
      ],
      [
        [16, 19.5],
        [16, 24.5],
      ],
      [
        [7.5, 16],
        [12.5, 16],
      ],
      [
        [19.5, 16],
        [24.5, 16],
      ],
    ]);
    g.fillStyle = KEYLINE;
    g.fillRect(13.6, 13.6, 4.8, 4.8);
    g.fillStyle = INK;
    g.fillRect(14.6, 14.6, 2.8, 2.8);
  },
  // The one round shape ctOS allows: a status dot in a hairline halo.
  dot(g, cue) {
    g.beginPath();
    g.arc(16, 16, 11.2, 0, Math.PI * 2);
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.lineWidth = 1.2;
    g.stroke();
    disc(g, 16, 16, 8.2, KEYLINE);
    disc(g, 16, 16, 6.4, INK);
    if (cue) caret(g);
  },
  // A view beam: where the device faces, fading out from a small diamond.
  beam(g, cue) {
    if (cue) {
      const grad = g.createLinearGradient(16, 16, 16, 0);
      grad.addColorStop(0, 'rgba(255,255,255,0.6)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.beginPath();
      g.moveTo(16, 16);
      g.lineTo(16 + 16 * Math.sin(0.5), 16 - 16 * Math.cos(0.5));
      g.arc(16, 16, 16, -Math.PI / 2 + 0.5, -Math.PI / 2 - 0.5, true);
      g.closePath();
      g.fillStyle = grad;
      g.fill();
    } else {
      g.beginPath();
      g.arc(16, 16, 9.5, 0, Math.PI * 2);
      g.strokeStyle = 'rgba(255,255,255,0.5)';
      g.lineWidth = 1.2;
      g.stroke();
    }
    solid(
      g,
      [
        [16, 10.4],
        [21.6, 16],
        [16, 21.6],
        [10.4, 16],
      ],
      2.6,
    );
  },
};

/**
 * Draw an icon into a 2D context, filling a size x size box at the origin,
 * nose up. cue: draw the heading mark (icons that have one).
 */
export function drawSelfIcon(g, id, size = SIZE, { cue = true } = {}) {
  const draw = SHAPES[id] ?? SHAPES[DEFAULT_SELF_ICON];
  g.save();
  g.scale(size / SIZE, size / SIZE);
  g.lineJoin = 'miter';
  g.lineCap = 'butt';
  draw(g, cue);
  g.restore();
}

function newCanvas(px) {
  const c = document.createElement('canvas');
  c.width = px * DENSITY;
  c.height = px * DENSITY;
  return c;
}

const cache = new Map();

/**
 * An icon as a billboard image: { id, image, px } like glyph(), where px is
 * the canvas width (a billboard scale of pixelSize / px draws it pixelSize
 * across). Cached per icon and cue.
 */
export function selfIconImage(id, { cue = true } = {}) {
  const icon = SELF_ICONS.find((i) => i.id === id) ?? SELF_ICONS[0];
  // Only icons with a separate heading mark have a second drawing.
  const key = `${icon.id}${cue || !icon.cue ? '' : '-nc'}`;
  let out = cache.get(key);
  if (!out) {
    const c = newCanvas(SIZE);
    drawSelfIcon(c.getContext('2d'), key.replace(/-nc$/, ''), SIZE * DENSITY, { cue });
    out = { id: `argus-self-${key}`, image: c, px: SIZE * DENSITY };
    cache.set(key, out);
  }
  return out;
}

/** The locating pulse: four bracket corners, the ctOS tracking frame. */
export function selfPulseImage() {
  let out = cache.get('pulse');
  if (!out) {
    const px = 48;
    const c = newCanvas(px);
    const g = c.getContext('2d');
    g.scale(DENSITY, DENSITY);
    const a = 11;
    const lo = 3;
    const hi = px - 3;
    strokes(
      g,
      [
        [
          [lo, lo + a],
          [lo, lo],
          [lo + a, lo],
        ],
        [
          [hi - a, lo],
          [hi, lo],
          [hi, lo + a],
        ],
        [
          [hi, hi - a],
          [hi, hi],
          [hi - a, hi],
        ],
        [
          [lo + a, hi],
          [lo, hi],
          [lo, hi - a],
        ],
      ],
      1.6,
    );
    out = { id: 'argus-self-pulse', image: c, px: px * DENSITY };
    cache.set('pulse', out);
  }
  return out;
}

/** A fresh preview canvas (a DOM node of its own) for menus and pickers. */
export function selfIconPreview(id, px = 28) {
  const c = newCanvas(px);
  c.style.width = `${px}px`;
  c.style.height = `${px}px`;
  drawSelfIcon(c.getContext('2d'), id, px * DENSITY);
  return c;
}

/**
 * The picker: one ctOS tile per icon with its preview and name. Returns
 * { el, paint(id), set(id) } like the other settings controls.
 * @param {{ current?: string, onSelect: (id: string) => void, caption?: string }} opts
 */
export function createSelfIconPicker({
  current,
  onSelect,
  caption = 'My position icon',
}) {
  const grid = h('div.ct-selficons', { role: 'radiogroup', 'aria-label': caption });
  const tiles = new Map();
  for (const icon of SELF_ICONS) {
    const tile = h(
      'button.ct-selficon',
      {
        type: 'button',
        role: 'radio',
        title: `${icon.label} marker`,
        dataset: { icon: icon.id },
        onclick: () => choose(icon.id),
      },
      h('span.ct-selficon__art', {}, selfIconPreview(icon.id)),
      h('span.ct-selficon__label', {}, icon.label),
    );
    tiles.set(icon.id, tile);
    grid.appendChild(tile);
  }
  const paint = (id) => {
    const on = isSelfIcon(id) ? id : DEFAULT_SELF_ICON;
    for (const [k, t] of tiles) t.setAttribute('aria-checked', String(k === on));
  };
  function choose(id) {
    paint(id);
    onSelect?.(id);
  }
  paint(current);
  const el = h('div.ct-field', {}, h('div.ct-field__label', {}, caption), grid);
  return { el, paint, set: choose };
}

/** Testing aid: forget the drawn icons. */
export function _resetSelfIcons() {
  cache.clear();
}
