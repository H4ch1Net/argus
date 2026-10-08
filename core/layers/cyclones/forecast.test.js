import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCyclones } from './parse.js';
import {
  attachCycloneGeometry,
  withForecastGeometry,
  coherentCycloneGeometry,
  normalizeAdvisory,
  nhcGisParams,
  NHC_GIS_LAYERS,
} from './forecast.js';

// Fixtures follow gods-eye-view src/data/cyclonesProxy.test.mjs (MIT).
const status = (advNum = '010') => ({
  activeStorms: [
    {
      id: 'ep152026',
      name: 'Fifteen-E',
      classification: 'TS',
      intensity: '45',
      longitudeNumeric: -125.8,
      latitudeNumeric: 15.5,
      forecastAdvisory: { advNum, url: 'https://www.nhc.noaa.gov/text/MIATCMEP5.shtml' },
    },
  ],
});

function collections(adv = '10') {
  const shapes = [
    { type: 'Point', coordinates: [-125.8, 15.5] },
    {
      type: 'LineString',
      coordinates: [
        [-125.8, 15.5],
        [-128, 15],
      ],
    },
    {
      type: 'Polygon',
      coordinates: [
        [
          [-126, 15],
          [-128, 15],
          [-127, 17],
          [-126, 15],
        ],
      ],
    },
  ];
  return shapes.map((geometry, i) => ({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          idp_source: `ep152026-${adv.padStart(3, '0')}_5day_${['pts', 'lin', 'pgn'][i]}`,
          advisnum: adv,
          tau: 0,
          maxwind: 45,
          gust: 9999,
        },
        geometry,
      },
    ],
  }));
}

const storms = (adv) => parseCyclones(status(adv));

test('advisory numbers normalize and the GIS query is pinned', () => {
  assert.equal(normalizeAdvisory('010'), '10');
  assert.equal(normalizeAdvisory('7a'), '7A');
  assert.equal(normalizeAdvisory(21), '21');
  assert.throws(() => normalizeAdvisory('1234'));
  assert.throws(() => normalizeAdvisory('x'));
  const p = nhcGisParams(NHC_GIS_LAYERS[0]);
  assert.equal(p.f, 'geojson');
  assert.equal(p.outSR, '4326');
  assert.equal(p.where, '1=1');
  assert.equal(p.outFields, 'idp_source,advisnum,tau,maxwind,gust');
});

test('coherent geometry is attached, including holes and the dateline', () => {
  const parts = collections();
  parts[1].features[0].geometry.coordinates = [
    [179, 15],
    [-179, 16],
  ];
  parts[2].features[0].geometry.coordinates.push([
    [-126.5, 15.5],
    [-127, 15.5],
    [-126.8, 16],
    [-126.5, 15.5],
  ]);
  const [s] = attachCycloneGeometry(storms(), parts);
  assert.equal(s.meta.geometryStatus, 'current');
  assert.equal(s.meta.geometryAdvisoryNumber, '10');
  assert.deepEqual(s.meta.track, parts[1].features[0].geometry);
  assert.equal(s.meta.cone.coordinates.length, 2);
  assert.equal(s.meta.forecastPoints[0].gustKt, null); // 9999 is out of range
  assert.equal(s.meta.forecastPoints[0].tauHours, 0);
  assert.ok(coherentCycloneGeometry(s));
});

test('older or mixed advisory geometry is never relabelled', () => {
  const [old] = attachCycloneGeometry(storms(), collections('9'));
  assert.equal(old.meta.geometryStatus, 'pending');
  assert.equal(old.meta.cone, null);
  assert.deepEqual(old.meta.forecastPoints, []);
  assert.equal(coherentCycloneGeometry(old), false);
  const mixed = collections();
  mixed[2] = collections('9')[2];
  const [partial] = attachCycloneGeometry(storms(), mixed);
  assert.equal(partial.meta.geometryStatus, 'pending');
  // A status advisory that moved on also drops geometry from the earlier one.
  const [moved] = attachCycloneGeometry(storms('011'), collections());
  assert.equal(moved.meta.geometryStatus, 'pending');
});

test('malformed payloads reject the whole set; the safe wrapper marks it unavailable', () => {
  const bad = [
    (c) => (c[0].exceededTransferLimit = true),
    (c) => (c[1].features[0].properties.idp_source = 'ep152026-010_5day_pgn'),
    (c) => (c[2].features[0].properties.advisnum = '11'),
    (c) => (c[2].features[0].geometry.coordinates[0][3] = [0, 0]), // ring not closed
    (c) => (c[1].features[0].geometry = { type: 'Polygon', coordinates: [] }),
    (c) => (c[0].features[0].geometry.coordinates = [200, 0]),
    (c) => c[2].features.push(c[2].features[0]), // two cones for one storm
    (c) => c[0].features.push(c[0].features[0]), // duplicate tau
  ];
  for (const mutate of bad) {
    const c = collections();
    mutate(c);
    assert.throws(() => attachCycloneGeometry(storms(), c));
    const [s] = withForecastGeometry(storms(), c);
    assert.equal(s.meta.geometryStatus, 'unavailable');
    assert.equal(coherentCycloneGeometry(s), false);
  }
  const [none] = withForecastGeometry(storms(), null);
  assert.equal(none.meta.geometryStatus, 'unavailable');
  assert.deepEqual(withForecastGeometry([], null), []);
});

test('the vertex budget caps oversized geometry', () => {
  const c = collections();
  const ring = Array.from({ length: 9000 }, (_, i) => [
    -126 + Math.cos(i) * 0.5,
    15 + Math.sin(i) * 0.5,
  ]);
  ring.push(ring[0]);
  c[2].features[0].geometry = {
    type: 'MultiPolygon',
    coordinates: [[ring], [ring], [ring]],
  };
  assert.throws(() => attachCycloneGeometry(storms(), c));
});
