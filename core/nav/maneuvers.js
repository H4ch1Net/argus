// Maneuvers in one vocabulary (OSRM's), whichever router planned the route,
// plus the short ctOS instruction for each. Pure: every shell shares it, the
// terminal and the car included.
//
// Types: depart, arrive, turn, continue, merge, on ramp, off ramp, fork,
// end of road, roundabout, rotary, new name. Modifiers: uturn, sharp right,
// right, slight right, straight, slight left, left, sharp left. Valhalla's
// numbered maneuver types and TomTom's maneuver codes are mapped into it here;
// OSRM's own extras (roundabout turn, exit roundabout, use lane, notification)
// are folded onto the nearest of these.

export const MANEUVER_TYPES = Object.freeze([
  'depart',
  'arrive',
  'turn',
  'continue',
  'merge',
  'on ramp',
  'off ramp',
  'fork',
  'end of road',
  'roundabout',
  'rotary',
  'new name',
]);
export const MODIFIERS = Object.freeze([
  'uturn',
  'sharp right',
  'right',
  'slight right',
  'straight',
  'slight left',
  'left',
  'sharp left',
]);

const clean = (v, max = 40) =>
  typeof v === 'string' ? v.trim().toLowerCase().slice(0, max) : '';

/**
 * A turn angle (degrees, positive to the right, -180..180) as a modifier:
 * under 20 straight, under 60 slight, under 140 plain, under 170 sharp, else
 * a U-turn.
 */
export function modifierForAngle(deg) {
  if (!Number.isFinite(deg)) return 'straight';
  const a = Math.abs(deg);
  const side = deg > 0 ? 'right' : 'left';
  if (a < 20) return 'straight';
  if (a < 60) return `slight ${side}`;
  if (a < 140) return side;
  if (a < 170) return `sharp ${side}`;
  return 'uturn';
}

/** An OSRM maneuver as given, kept to the vocabulary: { type, modifier?, exit? }. */
export function fromOsrm(m) {
  let type = clean(m?.type) || 'continue';
  let modifier = clean(m?.modifier) || undefined;
  if (type === 'roundabout turn') type = 'roundabout';
  else if (type === 'exit roundabout' || type === 'exit rotary') type = 'continue';
  else if (type === 'notification' || type === 'use lane') type = 'continue';
  else if (!MANEUVER_TYPES.includes(type)) type = 'turn';
  if (modifier && !MODIFIERS.includes(modifier)) modifier = undefined;
  const out = { type };
  if (modifier) out.modifier = modifier;
  if (Number.isInteger(m?.exit) && m.exit > 0 && m.exit < 20) out.exit = m.exit;
  return out;
}

// Valhalla maneuver types (valhalla/odin/maneuver.h, DirectionsLeg_Maneuver_Type).
const VALHALLA = {
  1: ['depart'],
  2: ['depart', 'right'],
  3: ['depart', 'left'],
  4: ['arrive'],
  5: ['arrive', 'right'],
  6: ['arrive', 'left'],
  7: ['new name', 'straight'],
  8: ['continue', 'straight'],
  9: ['turn', 'slight right'],
  10: ['turn', 'right'],
  11: ['turn', 'sharp right'],
  12: ['turn', 'uturn'],
  13: ['turn', 'uturn'],
  14: ['turn', 'sharp left'],
  15: ['turn', 'left'],
  16: ['turn', 'slight left'],
  17: ['on ramp', 'straight'],
  18: ['on ramp', 'right'],
  19: ['on ramp', 'left'],
  20: ['off ramp', 'slight right'],
  21: ['off ramp', 'slight left'],
  22: ['fork', 'straight'],
  23: ['fork', 'slight right'],
  24: ['fork', 'slight left'],
  25: ['merge', 'straight'],
  26: ['roundabout'],
  27: ['continue'], // roundabout exit: folded into the entry by the parser
  28: ['new name', 'straight'], // ferry on
  29: ['new name', 'straight'], // ferry off
  37: ['merge', 'slight right'],
  38: ['merge', 'slight left'],
};

/**
 * A Valhalla maneuver -> { type, modifier?, exit? }. A roundabout's modifier
 * is the turn between the bearing into it and the bearing out (`exitBearing`,
 * from the matching exit maneuver), as OSRM gives it.
 */
export function fromValhalla(m, { exitBearing } = {}) {
  const [type, modifier] = VALHALLA[Number(m?.type)] ?? ['continue', 'straight'];
  const out = { type };
  if (modifier) out.modifier = modifier;
  if (type === 'roundabout') {
    const n = Number(m?.roundabout_exit_count);
    if (Number.isInteger(n) && n > 0 && n < 20) out.exit = n;
    const before = Number(m?.bearing_before);
    if (Number.isFinite(before) && Number.isFinite(exitBearing)) {
      let d = (((exitBearing - before) % 360) + 360) % 360;
      if (d > 180) d -= 360;
      out.modifier = modifierForAngle(d);
    }
  }
  return out;
}

// TomTom Routing API maneuver codes (guidance.instructions[].maneuver).
const TOMTOM = {
  DEPART: ['depart'],
  ARRIVE: ['arrive'],
  ARRIVE_LEFT: ['arrive', 'left'],
  ARRIVE_RIGHT: ['arrive', 'right'],
  WAYPOINT_REACHED: ['arrive'],
  WAYPOINT_LEFT: ['arrive', 'left'],
  WAYPOINT_RIGHT: ['arrive', 'right'],
  STRAIGHT: ['continue', 'straight'],
  FOLLOW: ['continue', 'straight'],
  KEEP_RIGHT: ['fork', 'slight right'],
  KEEP_LEFT: ['fork', 'slight left'],
  BEAR_RIGHT: ['turn', 'slight right'],
  BEAR_LEFT: ['turn', 'slight left'],
  TURN_RIGHT: ['turn', 'right'],
  TURN_LEFT: ['turn', 'left'],
  SHARP_RIGHT: ['turn', 'sharp right'],
  SHARP_LEFT: ['turn', 'sharp left'],
  MAKE_UTURN: ['turn', 'uturn'],
  TRY_MAKE_UTURN: ['turn', 'uturn'],
  ENTER_MOTORWAY: ['on ramp'],
  ENTER_FREEWAY: ['on ramp'],
  ENTER_HIGHWAY: ['on ramp'],
  ENTRANCE_RAMP: ['on ramp'],
  TAKE_EXIT: ['off ramp', 'slight right'],
  MOTORWAY_EXIT_RIGHT: ['off ramp', 'slight right'],
  MOTORWAY_EXIT_LEFT: ['off ramp', 'slight left'],
  ROUNDABOUT_CROSS: ['roundabout', 'straight'],
  ROUNDABOUT_RIGHT: ['roundabout', 'right'],
  ROUNDABOUT_LEFT: ['roundabout', 'left'],
  ROUNDABOUT_BACK: ['roundabout', 'uturn'],
  TAKE_FERRY: ['new name', 'straight'],
  SWITCH_PARALLEL_ROAD: ['fork', 'straight'],
  SWITCH_MAIN_ROAD: ['fork', 'straight'],
};

/** A TomTom guidance instruction -> { type, modifier?, exit? }. */
export function fromTomTom(ins) {
  const code = String(ins?.maneuver ?? '').toUpperCase();
  let [type, modifier] = TOMTOM[code] ?? [];
  if (!type) {
    type = 'turn';
    modifier = undefined;
  }
  // Ramps carry their side in the turn angle (positive to the right).
  if (!modifier && Number.isFinite(ins?.turnAngleInDecimalDegrees))
    modifier = modifierForAngle(ins.turnAngleInDecimalDegrees);
  const out = { type };
  if (modifier) out.modifier = modifier;
  const n = Number(ins?.roundaboutExitNumber);
  if (type === 'roundabout' && Number.isInteger(n) && n > 0 && n < 20) out.exit = n;
  return out;
}

const SIDE = { left: 'LEFT', right: 'RIGHT' };
const DIR = {
  left: 'LEFT',
  right: 'RIGHT',
  'slight left': 'LEFT',
  'slight right': 'RIGHT',
  'sharp left': 'LEFT',
  'sharp right': 'RIGHT',
};

/**
 * The action alone, ctOS style: "TURN RIGHT", "BEAR LEFT", "KEEP RIGHT",
 * "ROUNDABOUT EXIT 2", "U-TURN", "ARRIVE". The banner prints it large with the
 * street name under it.
 */
export function maneuverLabel(m) {
  const type = m?.type ?? 'continue';
  const mod = m?.modifier ?? '';
  const dir = DIR[mod] ?? '';
  switch (type) {
    case 'depart':
      return 'HEAD OUT';
    case 'arrive':
      return SIDE[mod] ? `ARRIVE ${SIDE[mod]}` : 'ARRIVE';
    case 'turn':
    case 'end of road':
      if (mod === 'uturn') return 'U-TURN';
      if (mod === 'straight' || !dir) return 'STRAIGHT';
      if (mod.startsWith('slight')) return `BEAR ${dir}`;
      if (mod.startsWith('sharp')) return `SHARP ${dir}`;
      return `TURN ${dir}`;
    case 'new name':
    case 'continue':
      if (mod === 'uturn') return 'U-TURN';
      return dir ? `KEEP ${dir}` : 'CONTINUE';
    case 'fork':
      return dir ? `KEEP ${dir}` : 'KEEP STRAIGHT';
    case 'merge':
      return dir ? `MERGE ${dir}` : 'MERGE';
    case 'on ramp':
      return dir ? `RAMP ${dir}` : 'TAKE RAMP';
    case 'off ramp':
      return dir ? `EXIT ${dir}` : 'TAKE EXIT';
    case 'roundabout':
    case 'rotary':
      return Number.isInteger(m?.exit) ? `ROUNDABOUT EXIT ${m.exit}` : 'ROUNDABOUT';
    default:
      return 'CONTINUE';
  }
}

/**
 * One short ctOS instruction: the action, then the road. "TURN RIGHT ONTO
 * FOLSOM STREET", "HEAD OUT ON MARKET STREET", "ARRIVE RIGHT".
 * @param {{ type: string, modifier?: string, exit?: number }} m
 * @param {string} [road]
 */
export function instructionText(m, road = '') {
  const label = maneuverLabel(m);
  const name = String(road ?? '')
    .trim()
    .toUpperCase()
    .slice(0, 80);
  if (!name || m?.type === 'arrive') return label;
  if (m?.type === 'depart') return `${label} ON ${name}`;
  return `${label} ONTO ${name}`;
}
