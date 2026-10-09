import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  choosePick,
  entityPickClass,
  PICK_POINT,
  PICK_LINE,
  PICK_AREA,
} from './pickPriority.js';

const storm = { id: 'storm' };
const alpr = { id: 'alpr' };
const cable = { id: 'cable' };
const plane = { id: 'plane' };

test('a contact under a storm cone beats the cone, whatever the drill order', () => {
  assert.equal(
    choosePick([
      { target: storm, cls: PICK_AREA },
      { target: alpr, cls: PICK_POINT },
    ]),
    alpr,
  );
});

test('a line beats an area, a contact beats a line', () => {
  assert.equal(
    choosePick([
      { target: storm, cls: PICK_AREA },
      { target: cable, cls: PICK_LINE },
    ]),
    cable,
  );
  assert.equal(
    choosePick([
      { target: cable, cls: PICK_LINE },
      { target: storm, cls: PICK_AREA },
      { target: plane, cls: PICK_POINT },
    ]),
    plane,
  );
});

test('within a class the nearest (first) wins', () => {
  assert.equal(
    choosePick([
      { target: alpr, cls: PICK_POINT },
      { target: plane, cls: PICK_POINT },
    ]),
    alpr,
  );
  assert.equal(
    choosePick([
      { target: storm, cls: PICK_AREA },
      { target: { id: 'perimeter' }, cls: PICK_AREA },
    ]),
    storm,
  );
});

test('an area alone under the tap is still selectable', () => {
  assert.equal(choosePick([{ target: storm, cls: PICK_AREA }]), storm);
});

test('contacts behind the planet and rejected targets never win', () => {
  assert.equal(
    choosePick([
      { target: plane, cls: PICK_POINT, occluded: true },
      { target: storm, cls: PICK_AREA },
    ]),
    storm,
  );
  assert.equal(
    choosePick([
      { target: { id: 'trail' }, cls: PICK_LINE, accepted: false },
      { target: storm, cls: PICK_AREA },
    ]),
    storm,
  );
  assert.equal(choosePick([{ target: plane, cls: PICK_POINT, occluded: true }]), null);
  assert.equal(choosePick([null, { cls: PICK_POINT }]), null);
  assert.equal(choosePick([]), null);
});

test('entity hits are classed by what they draw', () => {
  assert.equal(entityPickClass({ polygon: {}, polyline: {} }, 'primitive'), PICK_AREA);
  assert.equal(entityPickClass({ polyline: {} }, 'primitive'), PICK_LINE);
  // An arc: a polyline plus a travelling pulse point. The pulse is a contact.
  assert.equal(entityPickClass({ polyline: {}, point: {} }, 'point'), PICK_POINT);
  assert.equal(entityPickClass({ polyline: {}, point: {} }, 'primitive'), PICK_LINE);
  assert.equal(entityPickClass({ billboard: {} }, 'primitive'), PICK_POINT);
  assert.equal(entityPickClass({ ellipse: {} }, 'primitive'), PICK_AREA);
  assert.equal(entityPickClass({}, 'model'), PICK_POINT);
  assert.equal(entityPickClass(null, 'primitive'), PICK_AREA);
});
