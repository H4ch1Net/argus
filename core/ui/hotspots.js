// Hotspots for the situation-room tour (master plan 8, "ambient mode"): the
// places most worth a look across the layers that are on, ranked by what
// makes each layer's records notable: magnitude for earthquakes, radiative
// power for fires, size for fire perimeters, every active storm, upcoming
// launches, and a few contacts from the busiest moving layers. Pure: the
// caller feeds { key, n } pairs (the layer key and a normalized record).

const PER_LAYER = 4;
const MAX = 12;
const MIN_APART_M = 50_000;

// Each layer's notion of "notable", and the viewing range that suits it.
const RULES = {
  quakes: { score: (n) => n.meta?.mag ?? 0, min: 4, range: 450_000 },
  fires: { score: (n) => n.meta?.frp ?? n.meta?.brightness ?? 0, min: 1, range: 60_000 },
  perimeters: { score: (n) => n.meta?.acres ?? 0, min: 1000, range: 90_000 },
  cyclones: {
    score: (n) => 10 + (n.meta?.windKt ?? n.meta?.intensity ?? 0),
    min: 0,
    range: 900_000,
  },
  cyclonecones: { score: () => 9, min: 0, range: 1_200_000 },
  launches: { score: () => 8, min: 0, range: 250_000 },
  military: { score: () => 5, min: 0, range: 120_000, sample: true },
  flights: { score: () => 3, min: 0, range: 80_000, sample: true },
  ships: { score: () => 3, min: 0, range: 40_000, sample: true },
};

const RAD = Math.PI / 180;
function distM(a, b) {
  const x = (b.lon - a.lon) * RAD * Math.cos(((a.lat + b.lat) / 2) * RAD);
  const y = (b.lat - a.lat) * RAD;
  return Math.hypot(x, y) * 6_371_000;
}

/**
 * @param {{ key: string, n: object }[]} entries
 * @param {{ random?: () => number }} [opts]
 * @returns {{ key: string, id: string, lat: number, lon: number, label: string,
 *   score: number, range: number }[]}
 */
export function rankHotspots(entries, { random = Math.random } = {}) {
  const byLayer = new Map();
  for (const { key, n } of entries) {
    const rule = RULES[key];
    const lat = n?.position?.latitude;
    const lon = n?.position?.longitude;
    if (!rule || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const s = rule.sample ? rule.score(n) + random() : rule.score(n);
    if (!(s >= rule.min)) continue;
    if (!byLayer.has(key)) byLayer.set(key, []);
    byLayer.get(key).push({
      key,
      id: String(n.id),
      lat,
      lon,
      label: String(
        n.meta?.title ?? n.meta?.name ?? n.meta?.callsign ?? n.meta?.place ?? n.id,
      ),
      score: s,
      range: rule.range,
    });
  }
  const picked = [];
  for (const list of byLayer.values()) {
    list.sort((a, b) => b.score - a.score);
    picked.push(...list.slice(0, PER_LAYER));
  }
  picked.sort((a, b) => b.score - a.score);
  const out = [];
  for (const p of picked) {
    if (out.some((o) => distM(o, p) < MIN_APART_M)) continue;
    out.push(p);
    if (out.length >= MAX) break;
  }
  return out;
}
