import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLaunches, launchQuery, primaryLaunch } from './parse.js';
import { describeLaunchPad, launchColorHex, relativeTime } from './format.js';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const launch = (id, net, extra = {}) => ({
  id,
  name: `Rocket | Mission ${id}`,
  net,
  status: { name: 'Go for Launch', abbrev: 'Go' },
  launch_service_provider: { name: 'Example Space' },
  rocket: { configuration: { full_name: 'Example Rocket 9' } },
  mission: { name: `Mission ${id}`, orbit: { name: 'Low Earth Orbit' } },
  pad: {
    id: 87,
    name: 'Launch Complex 39A',
    latitude: '28.60822681',
    longitude: '-80.60428186',
    location: { name: 'Kennedy Space Center, FL, USA' },
  },
  ...extra,
});

test('groups launches by pad and orders them by date', () => {
  const pads = parseLaunches({
    results: [
      launch('b', '2026-10-20T00:00:00Z'),
      launch('a', '2026-10-05T00:00:00Z', {
        status: { name: 'Launch Successful', abbrev: 'Success' },
      }),
      launch('c', '2026-10-10T00:00:00Z', {
        pad: { id: 2, name: 'SLC-4E', latitude: 34.632, longitude: -120.611 },
      }),
      launch('x', '2026-10-11T00:00:00Z', { pad: { id: 3, name: 'No coords' } }),
    ],
  });
  assert.equal(pads.length, 2);
  const lc39 = pads.find((p) => p.id === 'pad:87');
  assert.deepEqual(
    lc39.meta.launches.map((l) => l.id),
    ['a', 'b'],
  );
  assert.ok(Math.abs(lc39.position.latitude - 28.6082) < 1e-3);
});

test('the marker is about the next launch ahead, else the latest', () => {
  const [pad] = parseLaunches({
    results: [launch('a', '2026-10-05T00:00:00Z'), launch('b', '2026-10-20T00:00:00Z')],
  });
  assert.equal(primaryLaunch(pad.meta.launches, NOW).id, 'b');
  assert.equal(primaryLaunch(pad.meta.launches, Date.parse('2026-11-01')).id, 'b');
  const card = describeLaunchPad(pad, NOW);
  assert.equal(card.title, 'Rocket | Mission b');
  assert.equal(card.subtitle, 'Launch Complex 39A · Kennedy Space Center, FL, USA');
  assert.match(card.rows[1][1], /^2026-10-20 00:00 UTC \(in 12 d\)$/);
  assert.equal(card.sections[0].rows[0][1], 'Rocket | Mission a');
});

test('the query window is day-rounded so the URL is cacheable', () => {
  const a = launchQuery(NOW);
  const b = launchQuery(NOW + 3600_000);
  assert.deepEqual(a, b);
  assert.equal(a.net__gte, '2026-10-01T00:00:00Z');
  assert.equal(a.net__lte, '2026-11-22T00:00:00Z');
});

test('colours and relative times', () => {
  assert.equal(launchColorHex({ net: NOW + 3600_000 }, NOW), '#ffd54f');
  assert.equal(launchColorHex({ net: NOW + 5 * 86400_000 }, NOW), '#69f0ae');
  assert.equal(launchColorHex({ net: NOW - 1, abbrev: 'Failure' }, NOW), '#ef5350');
  assert.equal(relativeTime(NOW - 2 * 3600_000, NOW), '2 h ago');
  assert.equal(relativeTime(null, NOW), 'date TBD');
  assert.deepEqual(parseLaunches({ results: 'x' }), []);
});
