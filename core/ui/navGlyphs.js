// Navigation glyphs in the ctOS idiom, drawn on canvas: the maneuver arrow for
// the turn banner (thick square-ended strokes, the road not taken in grey),
// the destination marker (corner brackets round a diamond, a locked core in
// success green, a stem to the point) and the vehicle puck (a chevron).
// Browser only; the terminal and car hosts never import it.

const INK = '#ffffff';
const GHOST = '#7a7a7a';
const KEYLINE = 'rgba(14,14,14,0.92)';
const LOCK = '#00fa9a';
const ALERT = '#fc3e38';

/** Turn angle in degrees (0 ahead, positive right) for a maneuver modifier. */
export function angleFor(modifier) {
  switch (modifier) {
    case 'uturn':
      return 180;
    case 'sharp right':
      return 135;
    case 'right':
      return 90;
    case 'slight right':
      return 45;
    case 'slight left':
      return -45;
    case 'left':
      return -90;
    case 'sharp left':
      return -135;
    default:
      return 0;
  }
}

function arrowHead(g, x, y, ang, size) {
  // ang: direction of travel, radians from up, clockwise.
  const dx = Math.sin(ang);
  const dy = -Math.cos(ang);
  const px = -dy;
  const py = dx;
  g.beginPath();
  g.moveTo(x + dx * size, y + dy * size);
  g.lineTo(x + px * size * 0.9, y + py * size * 0.9);
  g.lineTo(x - px * size * 0.9, y - py * size * 0.9);
  g.closePath();
  g.fill();
}

function stroke(g, pts, color, w) {
  g.strokeStyle = color;
  g.lineWidth = w;
  g.lineCap = 'butt';
  g.lineJoin = 'miter';
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (const p of pts.slice(1)) g.lineTo(p[0], p[1]);
  g.stroke();
}

/**
 * Draw a maneuver on a 2D context, in a size x size box (CSS pixels; the
 * caller scales for the device). The canvas is cleared first.
 * @param {CanvasRenderingContext2D} g
 * @param {{ type: string, modifier?: string, exit?: number }} m
 */
export function drawManeuver(g, size, m) {
  g.clearRect(0, 0, size, size);
  const s = size;
  const w = Math.max(3, s * 0.11);
  const c = s / 2;
  const bottom = s * 0.92;
  const mid = s * 0.56;
  const len = s * 0.3;
  const type = m?.type ?? 'continue';
  const ang = (angleFor(m?.modifier) * Math.PI) / 180;
  g.fillStyle = INK;

  if (type === 'reroute') {
    // Off the route: a broken ring with an arrowhead, in the alert colour.
    const r = s * 0.28;
    g.strokeStyle = ALERT;
    g.fillStyle = ALERT;
    g.lineWidth = w * 0.8;
    g.beginPath();
    g.arc(c, c, r, -Math.PI * 0.35, Math.PI * 1.25);
    g.stroke();
    // The head at the clockwise end, pointing along the ring.
    const e = Math.PI * 1.25;
    arrowHead(g, c + Math.cos(e) * r, c + Math.sin(e) * r, e + Math.PI, w * 1.3);
    return;
  }

  if (type === 'arrive') {
    // The destination: brackets round a diamond.
    const r = s * 0.3;
    const arm = s * 0.12;
    g.strokeStyle = INK;
    g.lineWidth = Math.max(2, s * 0.05);
    for (const [x, y, sx, sy] of [
      [c - r, c - r, 1, 1],
      [c + r, c - r, -1, 1],
      [c - r, c + r, 1, -1],
      [c + r, c + r, -1, -1],
    ]) {
      g.beginPath();
      g.moveTo(x, y + sy * arm);
      g.lineTo(x, y);
      g.lineTo(x + sx * arm, y);
      g.stroke();
    }
    const d = s * 0.14;
    g.fillStyle = LOCK;
    g.beginPath();
    g.moveTo(c, c - d);
    g.lineTo(c + d, c);
    g.lineTo(c, c + d);
    g.lineTo(c - d, c);
    g.closePath();
    g.fill();
    return;
  }

  if (type === 'roundabout' || type === 'rotary') {
    const r = s * 0.17;
    const cy = s * 0.42;
    g.strokeStyle = GHOST;
    g.lineWidth = Math.max(2, w * 0.55);
    g.beginPath();
    g.arc(c, cy, r, 0, Math.PI * 2);
    g.stroke();
    stroke(
      g,
      [
        [c, bottom],
        [c, cy + r],
      ],
      INK,
      w,
    );
    const out = Number.isFinite(ang) ? ang : 0;
    const ex = c + Math.sin(out) * r;
    const ey = cy - Math.cos(out) * r;
    const tx = c + Math.sin(out) * (r + len * 0.9);
    const ty = cy - Math.cos(out) * (r + len * 0.9);
    // Round the ring from the entry to the exit (anticlockwise driving shown
    // as the short way round, which reads well at banner size).
    g.strokeStyle = INK;
    g.lineWidth = w;
    g.beginPath();
    g.arc(c, cy, r, Math.PI / 2, out - Math.PI / 2, out > 0);
    g.stroke();
    stroke(
      g,
      [
        [ex, ey],
        [tx, ty],
      ],
      INK,
      w,
    );
    arrowHead(g, tx, ty, out, w * 1.5);
    if (Number.isInteger(m?.exit)) {
      g.fillStyle = INK;
      g.font = `700 ${Math.round(s * 0.2)}px 'JetBrains Mono', ui-monospace, monospace`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(m.exit), c, cy + 1);
    }
    return;
  }

  if (type === 'depart') {
    g.fillRect(c - w, bottom - w * 2, w * 2, w * 2);
    stroke(
      g,
      [
        [c, bottom - w * 2],
        [c, s * 0.22],
      ],
      INK,
      w,
    );
    arrowHead(g, c, s * 0.18, 0, w * 1.5);
    return;
  }

  // Fork, ramps and merges: the road not taken (or joined) in grey.
  if (type === 'fork' || type === 'off ramp' || type === 'on ramp' || type === 'merge') {
    const other = type === 'merge' ? -ang || -0.6 : ang ? 0 : 0.6;
    const ox = c + Math.sin(other) * len;
    const oy = mid - Math.cos(other) * len;
    stroke(
      g,
      [
        [c, mid],
        [ox, oy],
      ],
      GHOST,
      w * 0.8,
    );
  }

  if (m?.modifier === 'uturn') {
    const r = s * 0.16;
    const right = c + r;
    const left = c - r;
    stroke(
      g,
      [
        [left, bottom],
        [left, s * 0.4],
      ],
      INK,
      w,
    );
    g.strokeStyle = INK;
    g.lineWidth = w;
    g.beginPath();
    g.arc(c, s * 0.4, r, Math.PI, 0);
    g.stroke();
    stroke(
      g,
      [
        [right, s * 0.4],
        [right, s * 0.62],
      ],
      INK,
      w,
    );
    arrowHead(g, right, s * 0.66, Math.PI, w * 1.5);
    return;
  }

  const tx = c + Math.sin(ang) * len;
  const ty = mid - Math.cos(ang) * len;
  stroke(
    g,
    [
      [c, bottom],
      [c, mid],
      [tx, ty],
    ],
    INK,
    w,
  );
  arrowHead(g, tx + Math.sin(ang) * w * 0.4, ty - Math.cos(ang) * w * 0.4, ang, w * 1.5);
}

/** A canvas with the maneuver drawn at `size` CSS pixels (device-scaled). */
export function maneuverCanvas(size = 56) {
  const c = document.createElement('canvas');
  const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
  c.width = Math.round(size * dpr);
  c.height = Math.round(size * dpr);
  c.style.width = `${size}px`;
  c.style.height = `${size}px`;
  const g = c.getContext('2d');
  return {
    el: c,
    draw(m) {
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawManeuver(g, size, m);
    },
  };
}

let destCache = null;
/** The destination marker image (40 x 52 CSS px at 2x): anchor at the bottom centre. */
export function destinationImage() {
  if (destCache) return destCache;
  const W = 40;
  const H = 52;
  const k = 2;
  const c = document.createElement('canvas');
  c.width = W * k;
  c.height = H * k;
  const g = c.getContext('2d');
  if (!g) return (destCache = c);
  g.scale(k, k);
  const cx = W / 2;
  const cy = 18;
  const r = 14;
  const arm = 6;
  // Stem to the point, keylined.
  g.fillStyle = KEYLINE;
  g.fillRect(cx - 2.5, cy + r - 2, 5, H - (cy + r) + 2);
  g.fillStyle = INK;
  g.fillRect(cx - 1, cy + r - 1, 2, H - (cy + r));
  // Brackets.
  for (const [x, y, sx, sy] of [
    [cx - r, cy - r, 1, 1],
    [cx + r, cy - r, -1, 1],
    [cx - r, cy + r, 1, -1],
    [cx + r, cy + r, -1, -1],
  ]) {
    for (const [col, lw] of [
      [KEYLINE, 4.5],
      [INK, 2],
    ]) {
      g.strokeStyle = col;
      g.lineWidth = lw;
      g.beginPath();
      g.moveTo(x, y + sy * arm);
      g.lineTo(x, y);
      g.lineTo(x + sx * arm, y);
      g.stroke();
    }
  }
  // The diamond with its locked core.
  const d = 8;
  g.fillStyle = KEYLINE;
  g.beginPath();
  g.moveTo(cx, cy - d - 1.5);
  g.lineTo(cx + d + 1.5, cy);
  g.lineTo(cx, cy + d + 1.5);
  g.lineTo(cx - d - 1.5, cy);
  g.closePath();
  g.fill();
  g.strokeStyle = INK;
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(cx, cy - d);
  g.lineTo(cx + d, cy);
  g.lineTo(cx, cy + d);
  g.lineTo(cx - d, cy);
  g.closePath();
  g.stroke();
  g.fillStyle = LOCK;
  g.beginPath();
  g.moveTo(cx, cy - 3.5);
  g.lineTo(cx + 3.5, cy);
  g.lineTo(cx, cy + 3.5);
  g.lineTo(cx - 3.5, cy);
  g.closePath();
  g.fill();
  destCache = c;
  return c;
}

let puckCache = null;
/** The vehicle chevron (32 CSS px at 2x), pointing up (north before rotation). */
export function puckImage() {
  if (puckCache) return puckCache;
  const S = 32;
  const k = 2;
  const c = document.createElement('canvas');
  c.width = S * k;
  c.height = S * k;
  const g = c.getContext('2d');
  if (!g) return (puckCache = c);
  g.scale(k, k);
  const path = () => {
    g.beginPath();
    g.moveTo(16, 3);
    g.lineTo(27, 28);
    g.lineTo(16, 21);
    g.lineTo(5, 28);
    g.closePath();
  };
  path();
  g.lineJoin = 'round';
  g.strokeStyle = KEYLINE;
  g.lineWidth = 4;
  g.stroke();
  g.fillStyle = INK;
  g.fill();
  puckCache = c;
  return c;
}
