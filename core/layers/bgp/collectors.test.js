import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RIS_COLLECTORS, collectorFor } from './collectors.js';

test('collectorFor accepts bare and fqdn host forms', () => {
  assert.equal(collectorFor('rrc21'), RIS_COLLECTORS.rrc21);
  assert.equal(collectorFor('rrc21.ripe.net'), RIS_COLLECTORS.rrc21);
  assert.equal(collectorFor('RRC00'), RIS_COLLECTORS.rrc00);
});

test('collectorFor returns null for unknown hosts', () => {
  assert.equal(collectorFor('unknown'), null);
  assert.equal(collectorFor(''), null);
  assert.equal(collectorFor(null), null);
});

test('every collector has in-range coordinates and a city', () => {
  for (const [id, c] of Object.entries(RIS_COLLECTORS)) {
    assert.ok(c.city, `${id} has a city`);
    assert.ok(c.longitude >= -180 && c.longitude <= 180, `${id} longitude`);
    assert.ok(c.latitude >= -90 && c.latitude <= 90, `${id} latitude`);
  }
});
