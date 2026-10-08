import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCables, parseLandingPoints } from './parse.js';
import { describeCable, describeLanding } from './format.js';

test('one entity per cable segment, positioned on the path', () => {
  const out = parseCables({
    features: [
      {
        properties: { id: 'example-1', name: 'Example-1', color: '#3a9bd9' },
        geometry: {
          type: 'MultiLineString',
          coordinates: [
            [
              [-5, 50],
              [-30, 45],
              [-70, 40],
            ],
            [[1, 1]], // a single point is not a line
            [
              [10, 10],
              [999, 10], // invalid point dropped
              [11, 11],
            ],
          ],
        },
      },
      {
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
      },
    ],
  });
  assert.deepEqual(
    out.map((n) => n.id),
    ['cable:example-1:0', 'cable:example-1:2'],
  );
  assert.deepEqual(out[0].position, { longitude: -30, latitude: 45, altitude: 0 });
  assert.equal(out[0].meta.color, '#3a9bd9');
  assert.deepEqual(out[1].meta.path, [
    [10, 10],
    [11, 11],
  ]);
  const card = describeCable(out[0]);
  assert.equal(card.title, 'Example-1');
  assert.equal(
    card.links[0].url,
    'https://www.submarinecablemap.com/submarine-cable/example-1',
  );
});

test('landing points', () => {
  const [p] = parseLandingPoints({
    features: [
      {
        properties: { id: 'bude', name: 'Bude, United Kingdom', is_tbd: false },
        geometry: { type: 'Point', coordinates: [-4.54, 50.83] },
      },
      { properties: { id: 'bad' }, geometry: { type: 'Point', coordinates: [500, 0] } },
    ],
  });
  assert.equal(p.id, 'landing:bude');
  assert.equal(describeLanding(p).subtitle, 'Cable landing point');
  assert.deepEqual(parseCables(null), []);
});
