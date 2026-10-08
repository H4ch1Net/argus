import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SATELLITE_CLASSES,
  SATELLITE_CLASS_LEGEND,
  satelliteClassOf,
  satelliteClassColor,
  satelliteClassLabel,
  tallySatelliteClasses,
  satelliteClassLegend,
} from './classes.js';
import { INK } from '../../ui/palette.js';

test('groups map to classes, with the constellation as a subtype', () => {
  assert.deepEqual(satelliteClassOf('gps-ops'), { klass: 'nav', subtype: 'GPS' });
  assert.equal(satelliteClassLabel('glo-ops'), 'NAV · GLONASS');
  assert.equal(satelliteClassLabel('geo'), 'GEO');
  assert.equal(satelliteClassLabel('starlink'), 'COMMS · Starlink');
  assert.equal(satelliteClassLabel('stations'), 'STATION');
  // Unknown groups fall back to the neutral bucket rather than vanishing.
  assert.equal(satelliteClassLabel('weird'), 'VISUAL');
});

test('the ISS is a station whichever group loaded it', () => {
  assert.equal(satelliteClassLabel('visual', { norad: '25544' }), 'STATION · ISS');
  assert.equal(satelliteClassLabel('visual', { norad: 25544 }), 'STATION · ISS');
  assert.equal(satelliteClassColor('visual', { norad: '25544' }), INK.white);
});

test('every class colour is a palette ink, never a state colour', () => {
  const inks = new Set(Object.values(INK));
  for (const c of Object.values(SATELLITE_CLASSES)) {
    assert.ok(inks.has(c.color), c.label);
    assert.notEqual(c.color, INK.success);
    assert.notEqual(c.color, INK.error);
  }
  assert.equal(new Set(Object.values(SATELLITE_CLASSES).map((c) => c.color)).size, 5);
});

test('the legend lists present classes in order with counts', () => {
  assert.deepEqual(
    SATELLITE_CLASS_LEGEND.map((r) => r.label),
    ['STATION', 'NAV', 'GEO', 'VISUAL', 'COMMS'],
  );
  const counts = tallySatelliteClasses([
    'geo',
    'gps-ops',
    'galileo',
    { group: 'visual', norad: '25544' },
    'visual',
    null,
  ]);
  assert.deepEqual(counts, { geo: 1, nav: 2, station: 1, visual: 2 });
  const legend = satelliteClassLegend(counts);
  assert.deepEqual(
    legend.map((r) => [r.klass, r.count]),
    [
      ['station', 1],
      ['nav', 2],
      ['geo', 1],
      ['visual', 2],
    ],
  );
  assert.equal(legend[1].color, INK.cyan);
  assert.deepEqual(satelliteClassLegend(null), []);
});
