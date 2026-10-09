import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  signalsQuery,
  parseSignals,
  signalKind,
  normalizeSignals,
  createSignalsSource,
  SIGNALS_MAX_VIEW_KM,
} from './parse.js';
import { describeSignal, signalSearchText } from './format.js';
import { SF_SIGNALS } from './fixtures.js';

test('the query asks for junction and crossing signals in one tile', () => {
  const ql = signalsQuery({ lamin: 37.7, lomin: -122.5, lamax: 37.8, lomax: -122.4 });
  assert.match(ql, /node\["highway"="traffic_signals"\]\(37\.7,-122\.5,37\.8,-122\.4\);/);
  assert.match(ql, /node\["crossing"="traffic_signals"\]/);
  assert.match(ql, /out \d+;$/);
});

test('real San Francisco signals parse into junctions and crossings', () => {
  const list = parseSignals(SF_SIGNALS);
  assert.equal(list.length, SF_SIGNALS.elements.length);
  const kinds = list.map((n) => n.meta.kind);
  assert.equal(kinds.filter((k) => k === 'junction').length, 5);
  assert.equal(kinds.filter((k) => k === 'crossing').length, 3);
  assert.equal(
    signalKind({ highway: 'crossing', crossing: 'traffic_signals' }),
    'crossing',
  );
  const j = describeSignal(list[0]);
  const row = (c, l) => c.rows.find((r) => r[0] === l)?.[1];
  assert.equal(j.title, 'Traffic signals');
  assert.equal(row(j, 'Mode'), 'Signals');
  assert.equal(row(j, 'Faces'), 'Both directions');
  assert.match(j.links[0].url, /^https:\/\/www\.openstreetmap\.org\/node\/\d+$/);
  const c = describeSignal(
    list.find((n) => n.meta.tags['traffic_signals:sound'] === 'yes'),
  );
  assert.equal(c.title, 'Crossing signals');
  assert.equal(row(c, 'Sound'), 'Yes');
  assert.equal(row(c, 'Button'), 'Yes');
  assert.match(signalSearchText(list[0]), /traffic signals junction/);
  assert.equal(normalizeSignals({ items: list }), list);
  assert.deepEqual(parseSignals({ elements: [{ type: 'way', id: 1 }] }), []);
});

test('the source loads only in views about 20 km across or less', async () => {
  let asked = 0;
  const src = createSignalsSource({
    proxyClient: null,
    fetchTile: async () => {
      asked += 1;
      return SF_SIGNALS;
    },
  });
  const wide = await src({
    bbox: { lamin: 37.5, lamax: 37.9, lomin: -122.6, lomax: -122.1 },
  });
  assert.equal(wide.tooWide, true);
  assert.equal(asked, 0);
  assert.ok(SIGNALS_MAX_VIEW_KM >= 18 && SIGNALS_MAX_VIEW_KM <= 25);
  const near = await src({
    bbox: { lamin: 37.781, lamax: 37.789, lomin: -122.419, lomax: -122.406 },
  });
  assert.equal(near.tooWide, false);
  assert.equal(asked, 1);
  assert.equal(near.items.length, SF_SIGNALS.elements.length);
});
