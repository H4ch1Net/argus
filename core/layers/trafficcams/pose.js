// Pose priors for public traffic cameras: a starting guess at where each camera
// looks, for projecting its published still into the 3D scene later (the cctv
// layer's frustum math takes this shape). A prior is only a guess; the
// calibration gizmo refines it. Pure: no Cesium, no DOM.
//
// Adapted from gods-eye-view src/data/directionText.js (the direction-text
// parser) and server/providers/cctv/normalize.js (the id-hash fallback heading
// and the two pose personalities) (MIT).
//
// GUARDRAIL: this places where a camera points. Nothing here, or anywhere in
// this layer, looks at what the camera sees.

/**
 * Direction text -> compass heading in degrees [0, 360), or null.
 *
 * Two modes, because the same words appear in two kinds of field:
 * - A dedicated direction field ("West", "Northbound") holds a real facing, so
 *   a bare cardinal IS the answer: pass allowBare = true.
 * - Free-form names ("N LAMAR BLVD", "5TH ST / WEST AVE") are full of street
 *   names that merely contain a cardinal word; only explicit travel tokens
 *   ("WESTBOUND", "WB") count there: leave allowBare = false (the default).
 * @param {unknown} value
 * @param {boolean} [allowBare=false]
 * @returns {number|null}
 */
export function directionToHeading(value, allowBare = false) {
  const t = String(value ?? '')
    .trim()
    .toUpperCase();
  if (!t) return null;
  // Explicit travel and intercardinal forms: safe on free-form text.
  if (/\bNORTHBOUND\b|\bNB\b/.test(t)) return 0;
  if (/\bSOUTHBOUND\b|\bSB\b/.test(t)) return 180;
  if (/\bEASTBOUND\b|\bEB\b/.test(t)) return 90;
  if (/\bWESTBOUND\b|\bWB\b/.test(t)) return 270;
  if (/\bNORTHEAST\b|\bNE\b/.test(t)) return 45;
  if (/\bNORTHWEST\b|\bNW\b/.test(t)) return 315;
  if (/\bSOUTHEAST\b|\bSE\b/.test(t)) return 135;
  if (/\bSOUTHWEST\b|\bSW\b/.test(t)) return 225;
  // Bare cardinals: dedicated direction fields only.
  if (allowBare) {
    if (/\bNORTH\b/.test(t)) return 0;
    if (/\bSOUTH\b/.test(t)) return 180;
    if (/\bEAST\b/.test(t)) return 90;
    if (/\bWEST\b/.test(t)) return 270;
  }
  return null;
}

/** FNV-1a 32-bit hash of a string (unsigned). */
export function hashSeed(text) {
  let h = 2166136261 >>> 0;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * A deterministic stand-in heading for a camera whose feed gives none: one of
 * 16 evenly spaced bearings picked by the id's hash, so cameras sharing a
 * position (several views of one station) fan apart instead of stacking.
 */
export const fallbackHeading = (id) => (hashSeed(String(id)) % 16) * 22.5;

/**
 * The two pose personalities. `pitch` is degrees BELOW horizontal (the cctv
 * layer's convention; the reference stores it negated), `heightM` the mount
 * height above the ground.
 * - known: the feed states a facing, so the camera is assumed to look down
 *   the road it names, wide and far.
 * - unknown: the heading is the hash stand-in, so the guess is kept modest.
 */
export const POSE_PERSONALITIES = Object.freeze({
  known: Object.freeze({ pitch: 24, fovDeg: 56, rangeM: 210, heightM: 10 }),
  unknown: Object.freeze({ pitch: 18, fovDeg: 44, rangeM: 145, heightM: 8 }),
});

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
// In range is left exact (the modulo round trip turns 60.1 into 60.10000000000002).
const wrap360 = (d) => (d >= 0 && d < 360 ? d : ((d % 360) + 360) % 360);

/**
 * A camera's pose prior.
 * @param {{ id: string, headingDeg?: number|null, confidence?: 'high'|'low',
 *   curated?: boolean, groundM?: number|null,
 *   mountM?: { known?: number, unknown?: number },
 *   overrides?: { pitch?: number, fovDeg?: number, rangeM?: number, heightM?: number } }} cam
 *   headingDeg: the feed's (or curated) facing, null when there is none;
 *   confidence: lowers a stated heading to the modest personality (curated
 *   catalogues mark rough bearings 'low'); mountM: a network's own mount
 *   heights (TxDOT runs tall); overrides: a curated camera's measured pose.
 * @returns {{ heading: number, headingConfidence: 'high'|'low',
 *   headingSource: 'feed'|'curated'|'hash', pitch: number, fovDeg: number,
 *   rangeM: number, heightM: number, groundM: number|null }}
 */
export function posePrior({
  id,
  headingDeg = null,
  confidence,
  curated = false,
  groundM = null,
  mountM,
  overrides,
}) {
  const has = finite(headingDeg);
  const high = has && confidence !== 'low';
  const base = high ? POSE_PERSONALITIES.known : POSE_PERSONALITIES.unknown;
  const mount = mountM?.[high ? 'known' : 'unknown'];
  const pose = {
    heading: has ? wrap360(headingDeg) : fallbackHeading(id),
    headingConfidence: high ? 'high' : 'low',
    headingSource: has ? (curated ? 'curated' : 'feed') : 'hash',
    pitch: base.pitch,
    fovDeg: base.fovDeg,
    rangeM: base.rangeM,
    heightM: finite(mount) ? mount : base.heightM,
    groundM: finite(groundM) ? groundM : null,
  };
  for (const k of ['pitch', 'fovDeg', 'rangeM', 'heightM'])
    if (finite(overrides?.[k])) pose[k] = overrides[k];
  return pose;
}

const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** Heading in degrees -> the nearest of the eight compass points. */
export const compassPoint = (deg) => POINTS[Math.round(wrap360(deg) / 45) % 8];
