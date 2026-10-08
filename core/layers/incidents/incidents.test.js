import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bboxAreaKm2,
  incidentBox,
  incidentQuery,
  parseTomTomIncidents,
  tomtomSeverity,
  TOMTOM_INCIDENT_FIELDS,
  TOMTOM_MAX_BBOX_KM2,
} from './parse.js';
import {
  describeIncident,
  formatDelay,
  formatLength,
  incidentColorHex,
  incidentGlyph,
  incidentSearchText,
} from './format.js';
import { createIncidentSource, createIncidentMockSource } from './source.js';
import { INK } from '../../ui/palette.js';

const city = { lomin: -0.2, lamin: 51.45, lomax: 0.05, lamax: 51.56 };

test('a city view is asked as is, snapped outward to the grid', () => {
  const b = incidentBox(city);
  assert.equal(b.clipped, false);
  assert.ok(b.lomin <= city.lomin && b.lomax >= city.lomax);
  assert.ok(b.lamin <= city.lamin && b.lamax >= city.lamax);
  assert.deepEqual(incidentBox({ ...city, lomin: -0.199 }), b, 'nearby views share a box');
  const q = incidentQuery(city);
  assert.equal(q.bbox, `${b.lomin},${b.lamin},${b.lomax},${b.lamax}`);
  assert.equal(q.fields, TOMTOM_INCIDENT_FIELDS);
  assert.equal(q.language, 'en-GB');
  assert.equal(q.timeValidityFilter, 'present');
  assert.equal(Object.keys(q).includes('key'), false, 'the key is the proxy’s to add');
});

test('a wide view is clipped to a square under the area limit around its centre', () => {
  for (const view of [
    { lomin: -5, lamin: 48, lomax: 5, lamax: 54 },
    { lomin: -120, lamin: 30, lomax: -100, lamax: 31 }, // wide and flat
    { lomin: 10, lamin: 69, lomax: 30, lamax: 71 }, // high latitude
    { lomin: 170, lamin: -20, lomax: -170, lamax: 0 }, // across the antimeridian
  ]) {
    const b = incidentBox(view);
    assert.equal(b.clipped, true);
    assert.ok(bboxAreaKm2(b) < TOMTOM_MAX_BBOX_KM2, JSON.stringify(b));
    assert.ok(b.lomin >= -180 && b.lomax <= 180 && b.lomax > b.lomin);
  }
  // A long thin view whose snapped box would pass the limit is clipped too.
  const thin = incidentBox({ lomin: 0, lamin: 0, lomax: 3, lamax: 0.19 });
  assert.ok(bboxAreaKm2(thin) < TOMTOM_MAX_BBOX_KM2);
  assert.equal(incidentQuery(null), null);
});

const SAMPLE = {
  incidents: [
    {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [4.88, 52.36],
          [4.89, 52.37],
          [4.9, 52.38],
        ],
      },
      properties: {
        id: 'abc123',
        iconCategory: 6,
        magnitudeOfDelay: 3,
        events: [{ description: 'Stationary traffic', code: 101, iconCategory: 6 }],
        startTime: '2026-10-08T07:00:00Z',
        endTime: '2026-10-08T09:30:00Z',
        from: 'Junction A',
        to: 'Junction B',
        length: 2400,
        delay: 780,
        roadNumbers: ['A10'],
      },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [4.91, 52.35] },
      properties: { id: 'p1', iconCategory: 1, magnitudeOfDelay: 1, events: [] },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [4.92, 52.35] },
      properties: { id: 'p2', iconCategory: 9, magnitudeOfDelay: 0 },
    },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [999, 0] }, properties: {} },
    { type: 'Feature', geometry: null, properties: { id: 'nogeo' } },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [4.91, 52.35] },
      properties: { id: 'p1', iconCategory: 1 },
    },
  ],
};

test('TomTom incidents normalize to points with kinds, severity and the stretch', () => {
  const list = parseTomTomIncidents(SAMPLE);
  assert.equal(list.length, 3, 'bad geometry and duplicates dropped');
  const [jam, crash, works] = list;
  assert.equal(jam.id, 'tomtom/abc123');
  assert.equal(jam.meta.kind, 'jam');
  assert.equal(jam.meta.severity, 'critical');
  assert.deepEqual([jam.position.longitude, jam.position.latitude], [4.89, 52.37]);
  assert.equal(jam.meta.path.length, 3);
  assert.equal(jam.meta.delayS, 780);
  assert.deepEqual(jam.meta.roads, ['A10']);
  assert.equal(crash.meta.kind, 'accident');
  assert.equal(crash.meta.severity, 'notable');
  assert.equal(crash.meta.path, null);
  assert.equal(works.meta.kind, 'roadworks');
  assert.equal(works.meta.severity, 'minor');
  assert.deepEqual(parseTomTomIncidents(null), []);
  assert.deepEqual(parseTomTomIncidents({ incidents: 'x' }), []);
});

test('severity rules and the six kinds have glyphs and palette colours', () => {
  assert.equal(tomtomSeverity(8, 4), 'critical', 'road closed');
  assert.equal(tomtomSeverity(1, 2), 'critical', 'accident with a real delay');
  assert.equal(tomtomSeverity(7, 1), 'notable', 'lane closed');
  assert.equal(tomtomSeverity(4, 1), 'minor');
  for (const kind of ['accident', 'jam', 'roadworks', 'closure', 'hazard', 'weather'])
    assert.ok(incidentGlyph(kind));
  assert.equal(incidentColorHex('critical'), INK.error);
  assert.equal(incidentColorHex('notable'), INK.white);
  assert.equal(incidentColorHex('minor'), INK.dim);
});

test('the incident card and search text', () => {
  const [jam] = parseTomTomIncidents(SAMPLE);
  const card = describeIncident(jam);
  assert.equal(card.title, 'Stationary traffic');
  assert.match(card.subtitle, /A10: Junction A to Junction B/);
  const rows = Object.fromEntries(card.rows);
  assert.equal(rows.Delay, '13 min');
  assert.equal(rows.Length, '2.4 km');
  assert.equal(rows.Since, '2026-10-08 07:00 UTC');
  assert.equal(rows.Source, 'TomTom Traffic (your key)');
  assert.match(incidentSearchText(jam), /A10/);
  assert.equal(formatDelay(4000), '1 h 07 min');
  assert.equal(formatDelay(0), null);
  assert.equal(formatLength(850), '850 m');
});

test('the source asks the pinned feed with the clipped box; the mock is TomTom-shaped', async () => {
  const calls = [];
  const proxyClient = {
    getJson: async (id, path, opts) => {
      calls.push({ id, path, opts });
      return { incidents: [] };
    },
  };
  const src = createIncidentSource({ proxyClient });
  const out = await src({ bbox: { lomin: -5, lamin: 48, lomax: 5, lamax: 54 } });
  assert.equal(calls[0].id, 'tomtom-incidents');
  assert.equal(calls[0].path, '/incidentDetails');
  assert.equal(out.clipped, true);
  const none = await src({});
  assert.deepEqual(none.json.incidents, []);
  assert.equal(calls.length, 1, 'no view, no request');
  const mock = await createIncidentMockSource()({ bbox: city });
  const list = parseTomTomIncidents(mock.json);
  assert.ok(list.length >= 8);
  assert.ok(list.every((n) => n.meta.demo));
  assert.equal(describeIncident(list[0]).rows.at(-1)[1], 'demo (simulated)');
});
