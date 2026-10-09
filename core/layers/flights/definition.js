import { parseFlights } from './parse.js';
import { classifyAircraft, AIRCRAFT_CLASS_SCALE } from './aircraftClass.js';
import { aircraftGlyph } from '../../ui/aircraftIcons.js';
import { ink } from '../sdk/colors.js';
import { formatAircraft, aircraftToNormalized, aircraftSearchText } from './format.js';

// Flights as a Layer SDK definition: no bespoke engine code, just fetch cadence,
// how to normalize OpenSky vectors, how to draw them, and how to describe one for
// the metadata card. This is the payoff of Phase 5: a layer is config.

// One silhouette per aircraft class (airliner, widebody, helicopter, ...) from
// the ICAO type or emitter category, sized by class, in ctOS white; aircraft on
// the ground dim to textSecondary so the airborne picture reads first.
export function aircraftStyle(n, inkName = 'white') {
  const kind = classifyAircraft(n.meta);
  return {
    image: aircraftGlyph(kind),
    pixelSize: Math.round(24 * AIRCRAFT_CLASS_SCALE[kind]),
    headingDeg: Number.isFinite(n.meta.trueTrack) ? n.meta.trueTrack : 0,
    color: n.meta.onGround ? ink('muted') : ink(inkName),
  };
}

/** @type {import('../sdk/createLayer.js').LayerDefinition} */
export const flightsDefinition = {
  id: 'opensky-flights',
  fetch: { mode: 'poll', intervalMs: 15_000, viewportBounded: true },
  interpolate: true,
  // Fixes keep the time the position was reported (OpenSky time_position,
  // adsb.lol now - seen_pos), so a repeated report adds no stall; drawn one
  // interval plus a margin behind, dead-reckoned when a poll is late.
  fixTime: (n) => (n.meta.timePosition ? n.meta.timePosition * 1000 : null),
  interpolateLagMs: 18_000,
  // OpenSky states or the keyless adsb.lol fallback; both parse to one shape.
  normalize: (raw) => parseFlights(raw).aircraft.map(aircraftToNormalized),
  render: {
    renderType: 'billboard',
    style: (n) => aircraftStyle(n),
  },
  describe: (n) => formatAircraft(n.meta),
  searchText: aircraftSearchText,
};
