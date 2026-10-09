// What a mapped surveillance or enforcement object IS, from its OSM tags. Pure,
// shared by the globe (glyph, size, ink), the cards and the terminal.
//
// Tagging read (OSM wiki): man_made=surveillance with surveillance:type
// (camera, ALPR, guard, gunshot_detector), camera:type (fixed, dome, panning;
// panorama and panorama_with_ptz in use), camera:mount, surveillance (public,
// outdoor, indoor) and surveillance:zone; highway=speed_camera; and
// type=enforcement relations (enforcement=maxspeed, average_speed,
// traffic_signals, ...) whose "device" member is the camera, merged onto that
// node by ./parse.js as `enforcement`. DeFlock maps ALPR readers into OSM as
// surveillance:type=ALPR with manufacturer / operator tags, so the same query
// covers its mapping.
//
// GUARDRAIL: this classifies WHAT and WHERE a mapped device is. Nothing here
// reads, or could read, what any device sees or hears.

/**
 * glyph: core/ui/glyphs.js name; px: marker size; ink: core/ui/palette.js INK
 * name; cone: whether a facing cone (or a ring when none is mapped) is drawn.
 */
export const SURVEILLANCE_KINDS = Object.freeze({
  alpr: { label: 'ALPR reader', glyph: 'alpr', px: 15, ink: 'white', cone: true },
  acoustic: {
    label: 'Acoustic sensor',
    glyph: 'acoustic',
    px: 14,
    ink: 'white',
    cone: false,
  },
  redlight: {
    label: 'Red-light camera',
    glyph: 'redlight',
    px: 14,
    ink: 'pale',
    cone: true,
  },
  speed: { label: 'Speed camera', glyph: 'speedcam', px: 14, ink: 'pale', cone: true },
  average: {
    label: 'Average speed camera',
    glyph: 'speedcam',
    px: 14,
    ink: 'pale',
    cone: true,
  },
  toll: {
    label: 'Toll gantry camera',
    glyph: 'cam-fixed',
    px: 12,
    ink: 'dim',
    cone: true,
  },
  guard: { label: 'Guard post', glyph: 'guardpost', px: 13, ink: 'gray', cone: false },
  ptz: { label: 'PTZ camera', glyph: 'cam-ptz', px: 13, ink: 'gray', cone: true },
  dome: { label: 'Dome camera', glyph: 'cam-dome', px: 12, ink: 'gray', cone: true },
  fixed: { label: 'Fixed camera', glyph: 'cam-fixed', px: 12, ink: 'gray', cone: true },
});

/** Kinds that enforce traffic rules (cards show the limit and the relation). */
export const ENFORCEMENT_KINDS = new Set(['redlight', 'speed', 'average']);

const low = (v) =>
  String(v ?? '')
    .trim()
    .toLowerCase();

/** True for ALPR / ANPR readers. */
export function isAlprType(type) {
  return /alpr|anpr|\blpr\b|licen[cs]e[ _]?plate|number[ _]?plate/.test(low(type));
}

/**
 * The kind id (a key of SURVEILLANCE_KINDS) for a set of tags. `enforcement`
 * may come from the node or from its enforcement relation (./parse.js).
 */
export function surveillanceKindOf(tags = {}) {
  const type = low(tags['surveillance:type']);
  if (isAlprType(type)) return 'alpr';
  if (/gunshot|acoustic|audio|microphone|sound/.test(type)) return 'acoustic';
  if (type === 'guard') return 'guard';
  const enf = low(tags.enforcement);
  if (
    /traffic_signals|red_?light/.test(enf) ||
    low(tags.speed_camera) === 'traffic_signals' ||
    low(tags['camera:type']) === 'red_light'
  )
    return 'redlight';
  if (/average_speed|section/.test(enf)) return 'average';
  if (low(tags.highway) === 'speed_camera' || /maxspeed|speed/.test(enf)) return 'speed';
  if (low(tags.highway) === 'toll_gantry') return 'toll';
  const cam = low(tags['camera:type']);
  if (/ptz|panning/.test(cam) || /\bptz\b/.test(low(tags['camera:mount']))) return 'ptz';
  if (/dome|panorama/.test(cam)) return 'dome';
  return 'fixed';
}

/** The kind's record, falling back to a fixed camera. */
export const kindInfo = (kind) => SURVEILLANCE_KINDS[kind] ?? SURVEILLANCE_KINDS.fixed;
