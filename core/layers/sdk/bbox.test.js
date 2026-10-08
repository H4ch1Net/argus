import { test } from 'node:test';
import assert from 'node:assert/strict';
import { padBBox, insideView } from './bbox.js';

test('pads a view and tests points against it', () => {
  const b = padBBox({ lamin: 0, lamax: 1, lomin: 0, lomax: 2 });
  assert.deepEqual(b, { lamin: -0.25, lamax: 1.25, lomin: -0.5, lomax: 2.5 });
  const inside = insideView({ lamin: 52.3, lamax: 52.4, lomin: 4.8, lomax: 5.0 });
  assert.equal(inside(52.35, 4.9), true); // Amsterdam
  assert.equal(inside(51.9, 4.5), false); // Rotterdam, outside the view
  assert.equal(insideView(undefined)(10, 10), true);
});
