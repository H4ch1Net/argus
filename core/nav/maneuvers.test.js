import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MANEUVER_TYPES,
  MODIFIERS,
  modifierForAngle,
  fromOsrm,
  fromValhalla,
  fromTomTom,
  maneuverLabel,
  instructionText,
} from './maneuvers.js';

const inVocab = (m) =>
  MANEUVER_TYPES.includes(m.type) &&
  (m.modifier === undefined || MODIFIERS.includes(m.modifier));

test('turn angles become OSRM modifiers', () => {
  assert.equal(modifierForAngle(5), 'straight');
  assert.equal(modifierForAngle(-40), 'slight left');
  assert.equal(modifierForAngle(90), 'right');
  assert.equal(modifierForAngle(-150), 'sharp left');
  assert.equal(modifierForAngle(178), 'uturn');
  assert.equal(modifierForAngle(NaN), 'straight');
});

test('OSRM maneuvers stay in the vocabulary, extras folded', () => {
  assert.deepEqual(fromOsrm({ type: 'turn', modifier: 'left' }), {
    type: 'turn',
    modifier: 'left',
  });
  assert.deepEqual(fromOsrm({ type: 'roundabout', modifier: 'right', exit: 2 }), {
    type: 'roundabout',
    modifier: 'right',
    exit: 2,
  });
  assert.equal(fromOsrm({ type: 'roundabout turn' }).type, 'roundabout');
  assert.equal(fromOsrm({ type: 'use lane', modifier: 'straight' }).type, 'continue');
  assert.equal(fromOsrm({ type: 'warp', modifier: 'sideways' }).modifier, undefined);
  assert.equal(fromOsrm({}).type, 'continue');
});

test('every Valhalla type maps into the vocabulary', () => {
  for (let t = 0; t <= 43; t += 1)
    assert.ok(inVocab(fromValhalla({ type: t })), `type ${t}`);
  assert.deepEqual(fromValhalla({ type: 10 }), { type: 'turn', modifier: 'right' });
  assert.deepEqual(fromValhalla({ type: 23 }), {
    type: 'fork',
    modifier: 'slight right',
  });
  assert.deepEqual(fromValhalla({ type: 20 }), {
    type: 'off ramp',
    modifier: 'slight right',
  });
  // A roundabout: the exit count, and the turn from the bearing in to the bearing out.
  assert.deepEqual(
    fromValhalla(
      { type: 26, roundabout_exit_count: 3, bearing_before: 0 },
      { exitBearing: 270 },
    ),
    { type: 'roundabout', exit: 3, modifier: 'left' },
  );
});

test('TomTom maneuver codes map into the vocabulary', () => {
  assert.deepEqual(fromTomTom({ maneuver: 'TURN_LEFT' }), {
    type: 'turn',
    modifier: 'left',
  });
  assert.deepEqual(
    fromTomTom({ maneuver: 'ROUNDABOUT_RIGHT', roundaboutExitNumber: 2 }),
    {
      type: 'roundabout',
      modifier: 'right',
      exit: 2,
    },
  );
  assert.deepEqual(
    fromTomTom({ maneuver: 'ENTER_MOTORWAY', turnAngleInDecimalDegrees: 30 }),
    {
      type: 'on ramp',
      modifier: 'slight right',
    },
  );
  assert.equal(fromTomTom({ maneuver: 'ARRIVE_LEFT' }).modifier, 'left');
  assert.ok(inVocab(fromTomTom({ maneuver: 'SOMETHING_NEW' })));
});

test('ctOS labels and instructions are short and upper case', () => {
  assert.equal(maneuverLabel({ type: 'turn', modifier: 'right' }), 'TURN RIGHT');
  assert.equal(maneuverLabel({ type: 'turn', modifier: 'slight left' }), 'BEAR LEFT');
  assert.equal(maneuverLabel({ type: 'turn', modifier: 'uturn' }), 'U-TURN');
  assert.equal(maneuverLabel({ type: 'fork', modifier: 'slight right' }), 'KEEP RIGHT');
  assert.equal(maneuverLabel({ type: 'roundabout', exit: 2 }), 'ROUNDABOUT EXIT 2');
  assert.equal(
    maneuverLabel({ type: 'off ramp', modifier: 'slight right' }),
    'EXIT RIGHT',
  );
  assert.equal(maneuverLabel({ type: 'arrive', modifier: 'left' }), 'ARRIVE LEFT');
  assert.equal(
    instructionText({ type: 'turn', modifier: 'right' }, 'Folsom Street'),
    'TURN RIGHT ONTO FOLSOM STREET',
  );
  assert.equal(
    instructionText({ type: 'depart' }, 'Market Street'),
    'HEAD OUT ON MARKET STREET',
  );
  assert.equal(instructionText({ type: 'arrive' }, 'Folsom Street'), 'ARRIVE');
  assert.equal(instructionText({ type: 'continue' }), 'CONTINUE');
});
