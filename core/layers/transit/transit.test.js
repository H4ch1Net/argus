import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agenciesInView, TRANSIT_AGENCIES } from './agencies.js';
import { createTransitSource } from './source.js';
import { parseTransit, transitNote } from './parse.js';
import { describeTransit, transitColorHex } from './format.js';
import { encodeVehicleFeed } from './encode.js';

const boston = { lamin: 42.2, lamax: 42.5, lomin: -71.3, lomax: -70.9 };

test('only agencies overlapping the view are selected', () => {
  assert.deepEqual(
    agenciesInView(boston).agencies.map((a) => a.feedId),
    ['gtfsrt-mbta'],
  );
  // The middle of the Atlantic: nothing.
  const sea = { lamin: 30, lamax: 31, lomin: -40, lomax: -39 };
  assert.deepEqual(agenciesInView(sea), { agencies: [], tooWide: false });
  // A continent-wide view is skipped entirely.
  const wide = { lamin: 10, lamax: 60, lomin: -120, lomax: -60 };
  assert.deepEqual(agenciesInView(wide), { agencies: [], tooWide: true });
  assert.deepEqual(agenciesInView(undefined).agencies, []);
});

test('every agency has a feed id, a path, and a sane coverage circle', () => {
  for (const a of TRANSIT_AGENCIES) {
    assert.match(a.feedId, /^gtfsrt-/);
    assert.ok(a.path.startsWith('/'));
    assert.ok(Math.abs(a.center[0]) <= 90 && Math.abs(a.center[1]) <= 180);
    assert.ok(a.radiusKm > 0 && a.radiusKm < 1000);
  }
});

function fakeClient(byFeed) {
  const calls = [];
  return {
    calls,
    async getBytes(feedId, path) {
      calls.push(`${feedId}${path}`);
      const r = byFeed[feedId];
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

test('the source fetches only agencies in view and decodes them', async () => {
  const now = Math.floor(Date.now() / 1000);
  const client = fakeClient({
    'gtfsrt-mbta': encodeVehicleFeed({
      timestamp: now,
      vehicles: [
        {
          id: 'e1',
          vehicleId: 'y1234',
          routeId: '1',
          lat: 42.35,
          lon: -71.06,
          timestamp: now,
        },
      ],
    }),
  });
  const source = createTransitSource({ proxyClient: client });
  const result = await source({ bbox: boston });
  assert.deepEqual(client.calls, ['gtfsrt-mbta/VehiclePositions.pb']);
  const list = parseTransit(result);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'gtfsrt-mbta:y1234');
  assert.equal(list[0].meta.agency, 'MBTA');
  assert.equal(transitNote(result), '');
});

test('one failing agency keeps the others; all failing is an error', async () => {
  const agencies = [
    { ...TRANSIT_AGENCIES[0], feedId: 'ok' },
    { ...TRANSIT_AGENCIES[0], feedId: 'bad', name: 'Bad' },
  ];
  const good = encodeVehicleFeed({ vehicles: [{ id: 'v', lat: 42.3, lon: -71 }] });
  const partial = createTransitSource({
    proxyClient: fakeClient({ ok: good, bad: new Error('proxy bad responded 502') }),
    agencies,
  });
  const r = await partial({ bbox: boston });
  assert.equal(parseTransit(r).length, 1);
  assert.equal(transitNote(r), 'Bad failed');

  const broken = createTransitSource({
    proxyClient: fakeClient({ ok: new Error('down'), bad: new Error('down') }),
    agencies,
  });
  await assert.rejects(broken({ bbox: boston }), /down/);
});

test('stale fixes are dropped; the card reads in plain units', () => {
  const now = 1_700_000_000_000;
  const agency = TRANSIT_AGENCIES[3];
  const result = {
    feeds: [
      {
        agency,
        timestamp: null,
        vehicles: [
          {
            id: 'fresh',
            routeId: '550',
            latitude: 60.2,
            longitude: 24.9,
            speed: 10,
            bearing: 45,
            timestamp: now / 1000 - 20,
          },
          {
            id: 'old',
            routeId: '550',
            latitude: 60.2,
            longitude: 24.9,
            timestamp: now / 1000 - 3600,
          },
        ],
      },
    ],
  };
  const list = parseTransit(result, now);
  assert.deepEqual(
    list.map((n) => n.meta.vehicleId),
    ['fresh'],
  );
  const card = describeTransit(list[0], now);
  assert.equal(card.title, 'Route 550');
  assert.equal(card.subtitle, 'HSL · Helsinki');
  assert.deepEqual(
    card.rows.find(([k]) => k === 'Speed'),
    ['Speed', '36 km/h'],
  );
  assert.deepEqual(
    card.rows.find(([k]) => k === 'Reported'),
    ['Reported', '20 s ago'],
  );
  assert.deepEqual(
    card.rows.find(([k]) => k === 'License'),
    ['License', 'CC BY 4.0'],
  );
  assert.equal(transitColorHex('550'), transitColorHex('550'));
  assert.match(transitColorHex(undefined), /^#[0-9a-f]{6}$/);
});

test('notes explain an empty layer', () => {
  assert.equal(transitNote({ tooWide: true }), 'zoom to a covered city');
  assert.equal(
    transitNote({ tooWide: false, inView: 0, feeds: [] }),
    'no covered agency in view',
  );
});
