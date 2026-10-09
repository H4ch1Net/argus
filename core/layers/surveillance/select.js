// Which of the held records a static layer draws: the NEAREST n to an anchor
// (the middle of the view, or your own position while the view follows you),
// or ALL IN VIEW (capped, nearest first). Pure, so the choice is testable and
// the terminal can use it too. Records are normalized entities
// ({ position: { latitude, longitude } }).

export const NEAREST_DEFAULT = 60;

const D2R = Math.PI / 180;

/** Squared equirectangular distance in degrees from `at` (ordering only). */
function dist2(n, at, k) {
  const p = n.position;
  return ((p.longitude - at.lon) * k) ** 2 + (p.latitude - at.lat) ** 2;
}

/**
 * The k records nearest `at`, nearest first. One pass with a small sorted
 * window (O(N log k)), so tens of thousands of held records cost little.
 */
export function nearestK(list, at, k) {
  if (!at || k <= 0) return [];
  const cosK = Math.cos(at.lat * D2R);
  const best = []; // [{ d, n }] ascending
  for (const n of list) {
    if (!n?.position) continue;
    const d = dist2(n, at, cosK);
    if (best.length === k && d >= best[k - 1].d) continue;
    let lo = 0;
    let hi = best.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (best[mid].d <= d) lo = mid + 1;
      else hi = mid;
    }
    best.splice(lo, 0, { d, n });
    if (best.length > k) best.pop();
  }
  return best.map((b) => b.n);
}

export const inBBox = (n, b) => {
  const p = n.position;
  return (
    p.latitude >= b.lamin &&
    p.latitude <= b.lamax &&
    p.longitude >= b.lomin &&
    p.longitude <= b.lomax
  );
};

const centreOf = (b) =>
  b ? { lat: (b.lamin + b.lamax) / 2, lon: (b.lomin + b.lomax) / 2 } : null;

/**
 * @param {object[]} list  normalized records
 * @param {{ mode?: 'nearest'|'all', anchor?: { lat: number, lon: number }|null,
 *   view?: { lamin: number, lomin: number, lamax: number, lomax: number }|null,
 *   nearest?: number, max?: number }} scope
 * @returns {{ list: object[], mode: string, total: number, inView: number }}
 *   total: records held; inView: those inside the view (when one is given)
 */
export function selectScope(
  list,
  {
    mode = 'all',
    anchor = null,
    view = null,
    nearest = NEAREST_DEFAULT,
    max = 4000,
  } = {},
) {
  const at = anchor ?? centreOf(view);
  if (mode === 'nearest' && at) {
    return { list: nearestK(list, at, nearest), mode, total: list.length, inView: -1 };
  }
  const visible = view ? list.filter((n) => n?.position && inBBox(n, view)) : list;
  let out = visible;
  if (visible.length > max) out = at ? nearestK(visible, at, max) : visible.slice(0, max);
  return { list: out, mode: 'all', total: list.length, inView: visible.length };
}

/** The layer-menu note for a selection: "nearest 60 of 812", "812 in view". */
export function scopeNote(sel) {
  if (!sel || !sel.total) return '';
  if (sel.mode === 'nearest') return `nearest ${sel.list.length} of ${sel.total}`;
  if (sel.inView > sel.list.length)
    return `nearest ${sel.list.length} of ${sel.inView} in view`;
  return '';
}
