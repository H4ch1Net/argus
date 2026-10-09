// Maneuver glyphs in the ctOS idiom: white arrows with square caps and mitred
// joins on a 48-unit box, the road not taken in a dim stroke, thin corner
// brackets. One source for both screens: the browser's own maneuver banner
// draws them as inline SVG (maneuverSvg), and the Android Auto routing card
// uses the same paths as vector drawables (android/app/src/main/res/drawable/
// ic_nav_<name>.xml, generated from this table: keep the two in step).
//
// Pure data and strings: no DOM, so the terminal and the tests can import it.

const BRACKETS = { d: 'M2,10V2H10M38,2H46V10M46,38V46H38M10,46H2V38', w: 1.5, a: 0.6 };
const HEAD_UP = 'M13,21L24,8L35,21Z';

/**
 * Each glyph: parts drawn in order. A part with `w` is a stroke of that width,
 * one without is a fill; `a` is its opacity (1 when absent).
 * @type {Record<string, { d: string, w?: number, a?: number }[]>}
 */
export const MANEUVER_ICONS = Object.freeze({
  straight: [{ d: 'M24,42V19', w: 5 }, { d: HEAD_UP }],
  turn_right: [{ d: 'M15,42V24H31', w: 5 }, { d: 'M29,13L40,24L29,35Z' }],
  turn_left: [{ d: 'M33,42V24H17', w: 5 }, { d: 'M19,13L8,24L19,35Z' }],
  slight_right: [
    { d: 'M17,42V30L27.5,19.5', w: 5 },
    { d: 'M36,10L34.2,26.6L19.4,11.8Z' },
  ],
  slight_left: [{ d: 'M31,42V30L20.5,19.5', w: 5 }, { d: 'M12,10L13.8,26.6L28.6,11.8Z' }],
  sharp_right: [{ d: 'M14,42V13L28.5,27.5', w: 5 }, { d: 'M37,35L35.2,18.4L20.4,33.2Z' }],
  sharp_left: [{ d: 'M34,42V13L19.5,27.5', w: 5 }, { d: 'M11,35L12.8,18.4L27.6,33.2Z' }],
  uturn_left: [{ d: 'M31,42V20A8,8 0 0 0 15,20V30', w: 5 }, { d: 'M4,28L15,40L26,28Z' }],
  uturn_right: [
    { d: 'M17,42V20A8,8 0 0 1 33,20V30', w: 5 },
    { d: 'M22,28L33,40L44,28Z' },
  ],
  fork_right: [
    { d: 'M24,30L12,18', w: 5, a: 0.4 },
    { d: 'M24,42V30L29.5,24.5', w: 5 },
    { d: 'M38,16L36.2,32.6L21.4,17.8Z' },
  ],
  fork_left: [
    { d: 'M24,30L36,18', w: 5, a: 0.4 },
    { d: 'M24,42V30L18.5,24.5', w: 5 },
    { d: 'M10,16L11.8,32.6L26.6,17.8Z' },
  ],
  merge_right: [
    { d: 'M28,44V26', w: 5, a: 0.4 },
    { d: 'M14,42V34L28,20V17', w: 5 },
    { d: 'M17,19L28,6L39,19Z' },
  ],
  merge_left: [
    { d: 'M20,44V26', w: 5, a: 0.4 },
    { d: 'M34,42V34L20,20V17', w: 5 },
    { d: 'M9,19L20,6L31,19Z' },
  ],
  merge: [{ d: 'M13,42L24,31M35,42L24,31V17', w: 5 }, { d: 'M13,19L24,6L35,19Z' }],
  ramp_right: [
    { d: 'M18,44V8', w: 5, a: 0.4 },
    { d: 'M18,42V30L28.5,19.5', w: 5 },
    { d: 'M37,11L35.2,27.6L20.4,12.8Z' },
  ],
  ramp_left: [
    { d: 'M30,44V8', w: 5, a: 0.4 },
    { d: 'M30,42V30L19.5,19.5', w: 5 },
    { d: 'M11,11L12.8,27.6L27.6,12.8Z' },
  ],
  // Right-hand traffic circulates anticlockwise (seen from above), left-hand
  // traffic clockwise: the bright arc goes round the side the driver takes.
  roundabout_ccw: [
    { d: 'M16,23A8,8 0 1 0 32,23A8,8 0 1 0 16,23', w: 3, a: 0.4 },
    { d: 'M24,44V31A8,8 0 0 0 24,15V11', w: 5 },
    { d: 'M15,13L24,2L33,13Z' },
  ],
  roundabout_cw: [
    { d: 'M16,23A8,8 0 1 0 32,23A8,8 0 1 0 16,23', w: 3, a: 0.4 },
    { d: 'M24,44V31A8,8 0 0 1 24,15V11', w: 5 },
    { d: 'M15,13L24,2L33,13Z' },
  ],
  depart: [
    { d: 'M20,39A4,4 0 1 0 28,39A4,4 0 1 0 20,39Z' },
    { d: 'M24,33V19', w: 5 },
    { d: HEAD_UP },
  ],
  arrive: [
    { d: 'M12,20V14H18M30,14H36V20M36,32V38H30M18,38H12V32', w: 3.5 },
    { d: 'M19,21H29V31H19Z' },
  ],
  arrive_left: [
    { d: 'M32,44V8', w: 5 },
    { d: 'M20,24H32', w: 3 },
    { d: 'M7,17H20V31H7Z' },
  ],
  arrive_right: [
    { d: 'M16,44V8', w: 5 },
    { d: 'M16,24H28', w: 3 },
    { d: 'M28,17H41V31H28Z' },
  ],
});

/** Every glyph's parts with the ctOS corner brackets first. */
export const iconParts = (name) => [
  BRACKETS,
  ...(MANEUVER_ICONS[name] ?? MANEUVER_ICONS.straight),
];

/** An inline SVG string for a maneuver glyph, in currentColor. */
export function maneuverSvg(name, size = 48) {
  const parts = iconParts(name)
    .map(({ d, w, a = 1 }) =>
      w
        ? `<path d="${d}" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="square" stroke-linejoin="miter" stroke-opacity="${a}"/>`
        : `<path d="${d}" fill="currentColor" fill-opacity="${a}"/>`,
    )
    .join('');
  return `<svg viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true">${parts}</svg>`;
}
