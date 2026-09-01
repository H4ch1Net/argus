import * as Cesium from 'cesium';
import { parseStates } from './parse.js';
import { formatAircraft } from './format.js';

// Flights as a Layer SDK definition: no bespoke engine code, just fetch cadence,
// how to normalize OpenSky vectors, how to draw them, and how to describe one for
// the metadata card. This is the payoff of Phase 5: a layer is config.

let planeImageCache = null;
function planeImage() {
  if (planeImageCache) return planeImageCache;
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 32;
  const g = c.getContext('2d');
  g.translate(16, 16);
  g.beginPath();
  g.moveTo(0, -13);
  g.lineTo(9, 11);
  g.lineTo(0, 6);
  g.lineTo(-9, 11);
  g.closePath();
  g.fillStyle = '#ffffff';
  g.fill();
  planeImageCache = c;
  return c;
}

function altitudeColor(metres) {
  const t = Math.max(0, Math.min(1, (metres || 0) / 12000));
  return Cesium.Color.fromHsl(0.34 - 0.17 * t, 0.85, 0.6);
}

/** OpenSky aircraft -> the SDK's normalized entity shape. */
function toNormalized(a) {
  return {
    id: a.id,
    type: 'aircraft',
    position: {
      longitude: a.longitude,
      latitude: a.latitude,
      altitude: a.geoAltitude ?? a.baroAltitude ?? 0,
    },
    velocity: { speed: a.velocity, heading: a.trueTrack, verticalRate: a.verticalRate },
    meta: a,
  };
}

/** @type {import('../sdk/createLayer.js').LayerDefinition} */
export const flightsDefinition = {
  id: 'opensky-flights',
  fetch: { mode: 'poll', intervalMs: 15_000, viewportBounded: true },
  interpolate: true,
  normalize: (raw) => parseStates(raw).aircraft.map(toNormalized),
  render: {
    renderType: 'billboard',
    style: (n) => ({
      image: planeImage(),
      // true_track is degrees clockwise from north; icon points north and
      // billboard rotation is counter-clockwise, so negate. Screen-space
      // (alignedAxis ZERO): exact under the default north-up view.
      rotationRadians: -Cesium.Math.toRadians(n.meta.trueTrack || 0),
      color: altitudeColor(n.position.altitude),
    }),
  },
  describe: (n) => formatAircraft(n.meta),
  searchText: (n) => `${n.meta.callsign} ${n.id} ${n.meta.originCountry || ''}`,
};
