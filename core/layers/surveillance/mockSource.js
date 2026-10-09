// Dev-only mock surveillance source: Overpass-shaped elements within the current
// view, one of every kind the layer draws (ALPR readers, dome / PTZ / fixed
// cameras, acoustic sensors, guard posts, speed and red-light cameras, one of
// them mapped only through an enforcement relation), most with a mapped
// facing, some without, so the glyphs, cards and view cones are demonstrable
// without a proxy. Dev-gated + dynamic-imported.

import { computeViewportQuery } from '../sdk/viewport.js';

const rand = (a, b) => a + Math.random() * (b - a);
// Facings in every form the cone parser reads, plus none (a ring).
const FACINGS = ['90', 'NE', '200;20', '45-120', 'SSW', null, '310', 'E'];
const KINDS = [
  {
    'surveillance:type': 'ALPR',
    surveillance: 'public',
    'surveillance:zone': 'traffic',
    'camera:type': 'fixed',
    'camera:mount': 'pole',
    manufacturer: 'Flock Safety',
    operator: 'City Police Department',
  },
  {
    'surveillance:type': 'camera',
    surveillance: 'public',
    'camera:type': 'dome',
    'camera:mount': 'street_lamp',
    operator: 'City DOT',
  },
  {
    'surveillance:type': 'camera',
    surveillance: 'outdoor',
    'camera:type': 'fixed',
    'camera:mount': 'wall',
    'surveillance:zone': 'entrance',
  },
  {
    'surveillance:type': 'camera',
    surveillance: 'public',
    'camera:type': 'panning',
    'camera:mount': 'pole',
    operator: 'Transit Authority',
  },
  {
    'surveillance:type': 'gunshot_detector',
    surveillance: 'public',
    brand: 'Flock Safety',
    name: 'Raven',
  },
  { 'surveillance:type': 'guard', surveillance: 'outdoor', operator: 'Port Security' },
  { highway: 'speed_camera', maxspeed: '50' },
  { highway: 'speed_camera', enforcement: 'traffic_signals', maxspeed: '50' },
];

export function createSurveillanceMockSource({ viewer, count = 32 }) {
  return async () => {
    const b = computeViewportQuery(viewer).bbox;
    const elements = Array.from({ length: count }, (_, i) => {
      const k = KINDS[i % KINDS.length];
      const facing = FACINGS[i % FACINGS.length];
      const directional =
        k['surveillance:type'] !== 'gunshot_detector' &&
        k['surveillance:type'] !== 'guard';
      return {
        type: 'node',
        id: 1_000_000 + i,
        lat: rand(b.lamin, b.lamax),
        lon: rand(b.lomin, b.lomax),
        tags: {
          ...(k.highway ? {} : { man_made: 'surveillance' }),
          ...k,
          ...(directional && facing
            ? { [k.highway ? 'direction' : 'camera:direction']: facing }
            : {}),
        },
      };
    });
    // An average-speed camera mapped only through its enforcement relation.
    elements.push(
      {
        type: 'node',
        id: 1_000_900,
        lat: rand(b.lamin, b.lamax),
        lon: rand(b.lomin, b.lomax),
        tags: {},
      },
      {
        type: 'relation',
        id: 1_000_901,
        members: [{ type: 'node', ref: 1_000_900, role: 'device' }],
        tags: {
          type: 'enforcement',
          enforcement: 'average_speed',
          maxspeed: '90',
          name: 'Ring road section',
        },
      },
    );
    return { elements };
  };
}
