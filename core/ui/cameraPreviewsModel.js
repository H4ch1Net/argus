// The pure part of the camera previews (core/ui/cameraPreviews.js): which
// cameras get a thumbnail, where each thumbnail sits beside its icon, and when
// a still is due again. No DOM, no Cesium: unit-tested.
//
// GUARDRAIL: this chooses and places published stills for display. Nothing
// here (or in the module that draws them) reads their pixels.

/** Thumbnails show only in views narrower than this (km across). */
export const PREVIEW_MAX_VIEW_KM = 15;
/** A still is fetched again at most this often. */
export const PREVIEW_REFRESH_MS = 60_000;
export const PREVIEW_DEFAULT = 4;
export const PREVIEW_MAX = 8;
/** A camera already shown keeps its thumbnail unless another is this much nearer. */
const STICKY = 0.8;

/**
 * The k candidates nearest the middle of the view (screen space), preferring
 * those already shown so thumbnails do not swap at every nudge.
 * @param {{ id: string, x: number, y: number }[]} cands  on-screen candidates
 * @param {{ cx: number, cy: number, k: number, current?: Set<string> }} opts
 * @returns the chosen candidates, nearest first
 */
export function pickPreviews(cands, { cx, cy, k, current = new Set() }) {
  if (!k || !cands.length) return [];
  return cands
    .map((c) => {
      const d = Math.hypot(c.x - cx, c.y - cy);
      return { c, s: current.has(c.id) ? d * STICKY : d };
    })
    .sort((a, b) => a.s - b.s)
    .slice(0, Math.min(k, PREVIEW_MAX))
    .map((e) => e.c);
}

// Where a card may sit relative to its icon: up-right first, then up-left,
// down-right, down-left. dx, dy place the card's top-left from the icon.
const SLOTS = ['ne', 'nw', 'se', 'sw'];
function slotRect(slot, p, w, h, off) {
  const left = slot === 'ne' || slot === 'se' ? p.x + off : p.x - off - w;
  const top = slot === 'ne' || slot === 'nw' ? p.y - off - h : p.y + off;
  return { x: left, y: top, w, h };
}
const overlap = (a, b) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const outside = (r, area) =>
  r.w * r.h -
  overlap(r, {
    x: area.left,
    y: area.top,
    w: area.right - area.left,
    h: area.bottom - area.top,
  });

/**
 * Lay the cards out beside their icons without covering each other or the
 * icons: each keeps its previous slot while that still fits, else takes the
 * first free slot, else the least-bad one (then clamped into the area).
 * @param {{ id: string, x: number, y: number }[]} points  icons on screen
 * @param {{ w: number, h: number, area: { left: number, top: number, right: number,
 *   bottom: number }, off?: number, prev?: Map<string, string>,
 *   avoid?: { x: number, y: number, w: number, h: number }[] }} opts
 *   avoid: more screen rects to keep clear (the selected target's label)
 * @returns {{ id: string, x: number, y: number, slot: string, lx: number, ly: number }[]}
 *   x, y: the card's top-left; lx, ly: the card corner the leader line leaves from
 */
export function placeCards(
  points,
  { w, h, area, off = 16, prev = new Map(), avoid = [] },
) {
  const placed = [];
  const icons = points.map((p) => ({ x: p.x - 8, y: p.y - 8, w: 16, h: 16 }));
  icons.push(...avoid);
  for (const p of points) {
    const cost = (slot) => {
      const r = slotRect(slot, p, w, h, off);
      let c = outside(r, area) * 4;
      for (const q of placed) c += overlap(r, q.rect) * 2;
      for (const ic of icons) c += overlap(r, ic);
      return c;
    };
    const keep = prev.get(p.id);
    let slot = keep && cost(keep) === 0 ? keep : null;
    if (!slot) {
      let best = Infinity;
      for (const s of SLOTS) {
        const c = cost(s);
        if (c < best) {
          best = c;
          slot = s;
        }
        if (c === 0) break;
      }
    }
    const r = slotRect(slot, p, w, h, off);
    // Never off screen: clamp into the free area (the leader still reaches the icon).
    r.x = Math.max(area.left, Math.min(area.right - w, r.x));
    r.y = Math.max(area.top, Math.min(area.bottom - h, r.y));
    const lx = slot === 'ne' || slot === 'se' ? r.x : r.x + w;
    const ly = slot === 'ne' || slot === 'nw' ? r.y + h : r.y;
    placed.push({ id: p.id, x: r.x, y: r.y, slot, lx, ly, rect: r });
  }
  for (const c of placed) delete c.rect;
  return placed;
}

/** True when a still should be (re)fetched now. */
export function stillDue(entry, now, { refreshMs = PREVIEW_REFRESH_MS } = {}) {
  if (!entry || entry.loading) return false;
  const last = Math.max(entry.loadedAt ?? -Infinity, entry.failedAt ?? -Infinity);
  return now - last >= refreshMs;
}

/** "12S", "3M": how long ago a still was fetched. */
export function ageLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--';
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s}S` : `${Math.round(s / 60)}M`;
}

/** A short label for a camera name: upper case, at most n characters. */
export function shortName(name, n = 18) {
  const s = String(name || 'CAMERA')
    .replace(/\s*[:|]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
