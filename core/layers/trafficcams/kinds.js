// Camera sub-kinds (ramp, bridge, tunnel, mountain pass, border crossing) read
// from a camera's own name, region and description with deliberately
// conservative rules, so the card can say what a camera covers and the map can
// show only, say, the border and pass cameras. Pure: shared with the terminal.
//
// The rules want an unambiguous word: "Bridge St" and "Pass Rd" are streets,
// not a bridge or a pass; "POE" counts only in capitals ("Poe Ave" is a street).
//
// GUARDRAIL: a kind describes the place a published camera is mounted at, from
// the operator's own label. Nothing here looks at what a camera shows.

import { createSetFilter } from '../webcams/categories.js';

/** @type {ReadonlyArray<{ id: string, label: string, short: string }>} */
export const CAMERA_KINDS = Object.freeze(
  [
    ['ramp', 'Ramp / interchange', 'RAMP'],
    ['bridge', 'Bridge', 'BRIDGE'],
    ['tunnel', 'Tunnel', 'TUNNEL'],
    ['pass', 'Mountain pass', 'PASS'],
    ['border', 'Border crossing', 'BORDER'],
    ['road', 'Other road cameras', 'ROAD'],
  ].map(([id, label, short]) => Object.freeze({ id, label, short })),
);
export const KIND_IDS = Object.freeze(CAMERA_KINDS.map((k) => k.id));
const LABEL = new Map(CAMERA_KINDS.map((k) => [k.id, k.label]));
export const kindLabel = (id) => LABEL.get(id) ?? id;

const STREET = String.raw`(?!\s+(?:st|street|rd|road|ave|avenue|blvd|dr|drive|ln|lane|way|pl|place)\b)`;
const RULES = [
  ['ramp', [/\b(?:on|off)[- ]?ramps?\b|\bramps?\b|\binterchange\b/i]],
  ['bridge', [new RegExp(String.raw`\bbridge\b${STREET}`, 'i')]],
  ['tunnel', [/\btunnel\b/i]],
  ['pass', [new RegExp(String.raw`\bpass\b${STREET}|\bsummit\b`, 'i')]],
  [
    'border',
    [
      /\bborder\b|\bports?\s+of\s+entry\b|\binternational\s+(?:bridge|crossing)\b|\bboundary\s+crossing\b|\bcustoms\b/i,
      /\bPOE\b/,
    ],
  ],
];

/**
 * The kinds a camera's labels state, e.g. cameraKinds('I-5 @ Peace Arch border')
 * -> ['border']. Several may apply ("Bay Bridge on-ramp").
 * @param {...(string|null|undefined)} texts name, region, description
 * @returns {string[]}
 */
export function cameraKinds(...texts) {
  const t = texts.filter((x) => typeof x === 'string' && x).join(' ');
  if (!t) return [];
  return RULES.filter(([, res]) => res.some((re) => re.test(t))).map(([id]) => id);
}

/** The kind filter the traffic camera layer reads (every kind shown at first). */
export const trafficCamKindFilter = createSetFilter(KIND_IDS);

/**
 * Whether a camera with these kinds passes the filter. A camera of no
 * particular kind counts as "road".
 */
export function kindsPass(kinds, filter = trafficCamKindFilter) {
  if (!filter || filter.isAll) return true;
  const ks = kinds?.length ? kinds : ['road'];
  return ks.some((k) => filter.has(k));
}
