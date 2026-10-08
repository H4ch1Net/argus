import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePerimeters, wfigsParams, WFIGS_OUT_FIELDS } from './parse.js';
import {
  containmentLevel,
  perimeterInkName,
  describePerimeter,
  formatCost,
  formatAge,
  perimeterSearchText,
} from './format.js';
import { createPerimeterMockSource } from './mockSource.js';
import { loadPerimeters } from './source.js';

const ring = [
  [-120, 39],
  [-119.9, 39],
  [-119.9, 39.1],
  [-120, 39.1],
  [-120, 39],
];
const feature = (props, geometry = { type: 'Polygon', coordinates: [ring] }) => ({
  type: 'Feature',
  properties: {
    poly_IncidentName: 'TEST',
    attr_UniqueFireIdentifier: '2026-CATEST-000001',
    attr_IncidentSize: 1200,
    attr_PercentContained: 40,
    attr_POOState: 'US-CA',
    ...props,
  },
  geometry,
});

test('the query is pinned to the reference fields and generalization', () => {
  const p = wfigsParams();
  assert.equal(p.where, '1=1');
  assert.equal(p.f, 'geojson');
  assert.equal(p.outSR, '4326');
  assert.equal(p.maxAllowableOffset, '0.001');
  assert.equal(p.outFields.split(',').length, WFIGS_OUT_FIELDS.length);
  assert.equal(p.resultOffset, undefined);
  assert.equal(wfigsParams(2000).resultOffset, '2000');
});

test('parses a perimeter into an open ring with a centroid', () => {
  const [n] = parsePerimeters({ features: [feature({})] });
  assert.equal(n.id, 'wfigs:2026-CATEST-000001');
  assert.equal(n.type, 'fire-perimeter');
  assert.equal(n.meta.polygon.length, 4);
  assert.ok(Math.abs(n.position.longitude + 119.95) < 1e-9);
  assert.ok(Math.abs(n.position.latitude - 39.05) < 1e-9);
  assert.equal(n.meta.containedPct, 40);
});

test('skips degenerate features without blanking the snapshot', () => {
  const list = parsePerimeters({
    features: [
      feature({}, null), // generalized away
      feature({ attr_UniqueFireIdentifier: 'B' }, { type: 'Point', coordinates: [0, 0] }),
      feature({ attr_UniqueFireIdentifier: 'C' }),
      feature({ attr_UniqueFireIdentifier: 'C' }), // duplicate id
      {
        type: 'Feature',
        properties: null,
        geometry: { type: 'Polygon', coordinates: [ring] },
      },
      feature({ attr_UniqueFireIdentifier: 'D', poly_IncidentName: '<b>x</b>\u0007' }),
    ],
  });
  assert.deepEqual(
    list.map((n) => n.meta.incidentId),
    ['C', 'D'],
  );
  assert.equal(list[1].meta.name, 'bx/b');
  assert.deepEqual(parsePerimeters(null), []);
});

test('multipolygons become one entity per part, largest first, only the first searchable', () => {
  const small = [
    [-121, 40],
    [-120.99, 40],
    [-120.99, 40.01],
    [-121, 40],
  ];
  const list = parsePerimeters({
    features: [feature({}, { type: 'MultiPolygon', coordinates: [[small], [ring]] })],
  });
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'wfigs:2026-CATEST-000001');
  assert.equal(list[1].id, 'wfigs:2026-CATEST-000001:1');
  assert.equal(list[0].meta.polygon.length, 4);
  assert.match(perimeterSearchText(list[0]), /test/i);
  assert.equal(perimeterSearchText(list[1]), '');
});

test('containment maps to the ctOS palette', () => {
  assert.equal(containmentLevel(null), 'uncontained');
  assert.equal(containmentLevel(0), 'uncontained');
  assert.equal(containmentLevel(50), 'partial');
  assert.equal(containmentLevel(100), 'contained');
  assert.equal(perimeterInkName(0), 'error');
  assert.equal(perimeterInkName(60), 'white');
  assert.equal(perimeterInkName(100), 'muted');
});

test('the card reads naturally and carries no link it cannot vouch for', () => {
  const now = Date.UTC(2026, 9, 8, 12);
  const [n] = parsePerimeters({
    features: [
      feature({
        attr_FireDiscoveryDateTime: now - 3 * 86_400_000,
        poly_DateCurrent: now - 2 * 3_600_000,
        attr_EstimatedCostToDate: 4_200_000,
        attr_CpxName: 'NORTH COMPLEX',
      }),
    ],
  });
  const card = describePerimeter(n, now);
  assert.equal(card.title, 'Test');
  assert.equal(card.subtitle, 'Fire, partly contained');
  const row = (k) => card.rows.find((r) => r[0] === k)?.[1];
  assert.match(row('Size'), /^1,200 acres/);
  assert.equal(row('State'), 'CA');
  assert.equal(row('Cost to date'), '$4.2M');
  assert.equal(row('Part of'), 'North Complex');
  assert.match(row('Discovered'), /\(3d ago\)$/);
  assert.match(row('Perimeter as of'), /\(2h ago\)$/);
  assert.deepEqual(card.links, []);
});

test('cost and age formatting', () => {
  assert.equal(formatCost(500), null);
  assert.equal(formatCost(85_000), '$85K');
  assert.equal(formatCost(999_600), '$1M');
  assert.equal(formatCost(1.3e9), '$1.3B');
  assert.equal(formatAge(-1), null);
  assert.equal(formatAge(90_000), '1m');
});

test('the demo source parses, including a hole and a split incident', async () => {
  const list = parsePerimeters(await createPerimeterMockSource()());
  assert.equal(list.length, 5);
  assert.ok(list.some((n) => n.meta.holes.length === 1));
  assert.ok(list.every((n) => n.meta.demo));
});

test('the source pages while the service reports more', async () => {
  const offsets = [];
  const proxyClient = {
    async getJson(feed, path, { params }) {
      assert.equal(feed, 'wfigs');
      assert.equal(path, '/0/query');
      offsets.push(params.resultOffset ?? '0');
      const more = offsets.length < 3;
      return {
        type: 'FeatureCollection',
        features: [feature({ attr_UniqueFireIdentifier: `F${offsets.length}` })],
        ...(more ? { exceededTransferLimit: true } : {}),
      };
    },
  };
  const all = await loadPerimeters(proxyClient);
  assert.deepEqual(offsets, ['0', '1', '2']);
  assert.equal(all.features.length, 3);
  await assert.rejects(loadPerimeters({ getJson: async () => ({ error: 'x' }) }));
});
