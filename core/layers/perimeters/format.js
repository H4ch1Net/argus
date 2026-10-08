// Fire perimeter cards, containment styling and search text. Pure: shared
// with the terminal shell. Card fields adapted from gods-eye-view
// src/layers/perimeters/cards.js (MIT).
//
// Colour is containment, from the ctOS palette (core/ui/palette.js): red is a
// hazard state, so only an uncontained fire is red; partly contained is white,
// fully contained recedes to muted gray.

/** 'uncontained' (none reported, or 0 %), 'partial' or 'contained'. */
export function containmentLevel(containedPct) {
  if (containedPct == null || !Number.isFinite(containedPct) || containedPct <= 0)
    return 'uncontained';
  return containedPct >= 100 ? 'contained' : 'partial';
}

const LEVEL_INK = { uncontained: 'error', partial: 'white', contained: 'muted' };

/** Palette ink name (INK key) for a perimeter's containment. */
export const perimeterInkName = (containedPct) =>
  LEVEL_INK[containmentLevel(containedPct)];

/** Compact USD: $85K, $4.2M, $1.3B; null under $1,000. */
export function formatCost(dollars) {
  if (!Number.isFinite(dollars) || dollars < 1000) return null;
  const units = [
    [1e3, 'K'],
    [1e6, 'M'],
    [1e9, 'B'],
  ];
  let i = units.length - 1;
  while (i > 0 && dollars < units[i][0]) i--;
  // 999,500 promotes to $1M, never $1000K.
  if (dollars >= units[i][0] * 999.5 && i < units.length - 1) i++;
  const v = dollars / units[i][0];
  return `$${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10}${units[i][1]}`;
}

/** "45m", "6h", "3d" ago; null for a time in the future or unknown. */
export function formatAge(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return null;
  const hours = Math.floor(deltaMs / 3_600_000);
  if (hours < 1) return `${Math.max(1, Math.floor(deltaMs / 60_000))}m`;
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const titleCase = (s) =>
  String(s)
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
const int = (n) => Math.round(n).toLocaleString('en-US');
const state = (s) => (s && /^US-[A-Z]{2}$/i.test(s) ? s.slice(3).toUpperCase() : s);

const CATEGORY = { WF: 'Wildfire', RX: 'Prescribed fire', CX: 'Complex' };

export function describePerimeter(n, now = Date.now()) {
  const m = n.meta;
  const level = containmentLevel(m.containedPct);
  const contained =
    m.containedPct == null ? 'not reported' : `${Math.round(m.containedPct)} %`;
  const ago = (t) => (t == null ? null : formatAge(now - t));
  const when = (t) => {
    const a = ago(t);
    return t == null
      ? '—'
      : `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC${a ? ` (${a} ago)` : ''}`;
  };
  const acres =
    m.acres != null
      ? `${int(m.acres)} acres (${(m.acres * 0.004047).toFixed(1)} km²)`
      : '—';
  return {
    id: n.id,
    title: m.name ? titleCase(m.name) : 'Unnamed incident',
    subtitle: `${CATEGORY[m.category] || 'Fire'}, ${level === 'partial' ? 'partly contained' : level}`,
    rows: [
      ['Size', acres],
      ['Contained', contained],
      ['State', state(m.state) || '—'],
      ['County', m.county || '—'],
      ['Cause', m.cause || '—'],
      ['Behaviour', m.behavior || '—'],
      ['Complexity', m.complexity || '—'],
      ['Personnel', m.personnel != null ? int(m.personnel) : '—'],
      ['Cost to date', formatCost(m.costUsd) || '—'],
      ...(m.complexName ? [['Part of', titleCase(m.complexName)]] : []),
      ['Discovered', when(m.discoveredMs)],
      ['Perimeter as of', when(m.updatedMs)],
      ...(m.parts > 1 ? [['Areas', `${m.parts} separate polygons`]] : []),
      [
        'Source',
        m.demo ? 'demo (simulated)' : 'NIFC WFIGS interagency perimeters (public domain)',
      ],
    ],
    links: [],
  };
}

/** Only an incident's largest polygon is searchable (one hit per fire). */
export const perimeterSearchText = (n) =>
  n.meta.part === 0
    ? `${n.meta.name || ''} ${n.meta.state || ''} fire perimeter wildfire`
    : '';
