import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  consumption,
  createParkedTracker,
  mpg,
  usesImperialGallon,
  vehicleVariant,
  vehicleView,
} from './vehicle.js';

const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b} (±${eps})`);

test('the silhouette follows the fuels the car reports', () => {
  assert.equal(vehicleVariant({ fuelTypes: ['electric'] }), 'ev');
  assert.equal(vehicleVariant({ fuelTypes: ['unleaded', 'electric'] }), 'sedan');
  assert.equal(vehicleVariant({ fuelTypes: ['diesel_1'] }), 'suv');
  assert.equal(vehicleVariant({ fuelTypes: [] }), 'sedan');
  assert.equal(vehicleVariant(), 'sedan');
  // The body set on the phone wins; anything else is ignored.
  assert.equal(
    vehicleView({ body: 'suv', energy: { fuelTypes: ['unleaded'] } }).variant,
    'suv',
  );
  assert.equal(
    vehicleView({ body: 'tank', energy: { fuelTypes: ['electric'] } }).variant,
    'ev',
  );
});

test('consumption is the fuel drop times the tank over the distance', () => {
  // 50 L tank, 80% -> 50%: 15 L over 250 km = 6 L/100 km.
  const c = consumption({
    fuelPctStart: 80,
    fuelPct: 50,
    odometerStartM: 10_000_000,
    odometerM: 10_250_000,
    tankL: 50,
  });
  near(c.lPer100km, 6, 1e-9);
  near(c.litres, 15, 1e-9);
  // 6 L/100 km is 39.2 US mpg and 47.1 imperial mpg.
  near(mpg(6), 39.2, 0.05);
  near(mpg(6, true), 47.08, 0.05);
});

test('consumption stays unknown until it means something', () => {
  const base = {
    fuelPctStart: 80,
    fuelPct: 79,
    odometerStartM: 0,
    odometerM: 5000,
    tankL: 50,
  };
  assert.equal(consumption(base), null); // 5 km, 0.5 L: too little yet
  assert.equal(consumption({ ...base, tankL: undefined }), null);
  assert.equal(consumption({ ...base, tankL: 0 }), null);
  assert.equal(consumption({ ...base, odometerM: 100_000, fuelPct: 81 }), null); // refuelled
  assert.equal(consumption({ ...base, odometerM: 9000, fuelPct: 40 }), null); // 222 L/100 km: glitch
  assert.ok(consumption({ ...base, odometerM: 100_000, fuelPct: 70 }));
  assert.equal(consumption(), null);
});

test('the panel reads in the driver units', () => {
  const info = {
    model: { make: 'Toyota', name: 'Corolla', year: 2021 },
    energy: { fuelTypes: ['unleaded'] },
    fuelPct: 62.4,
    rangeM: 412_000,
    odometerM: 48_213_400,
    lowFuel: false,
    economy: { fuelPctStart: 92.4, odometerStartM: 47_963_400 },
    tankL: 50,
  };
  const v = vehicleView(info, { units: 'metric' });
  assert.equal(v.known, true);
  assert.equal(v.title, 'TOYOTA COROLLA 2021');
  assert.equal(v.variant, 'sedan');
  const row = (k) => v.rows.find((r) => r.key === k);
  assert.equal(row('fuel').value, '62%');
  assert.equal(row('range').value, '412 KM');
  assert.equal(row('odo').value, '48,213 KM');
  assert.equal(row('avg').label, 'AVG L/100KM');
  assert.equal(row('avg').value, '6.0'); // 15 L over 250 km
  assert.equal(row('battery'), undefined);
  const us = vehicleView(info, { units: 'imperial' });
  assert.equal(us.rows.find((r) => r.key === 'avg').label, 'AVG MPG');
  assert.equal(us.rows.find((r) => r.key === 'avg').value, '39.2');
  assert.equal(us.rows.find((r) => r.key === 'odo').value, '29,958 MI');
  assert.equal(usesImperialGallon('en-GB'), true);
  assert.equal(usesImperialGallon('en-US'), false);
});

test('an EV shows its battery, and unknowns read --', () => {
  const ev = vehicleView({
    energy: { fuelTypes: ['electric'] },
    batteryPct: 80,
    rangeM: 300_000,
  });
  assert.equal(ev.variant, 'ev');
  assert.deepEqual(
    ev.rows.map((r) => r.key),
    ['battery', 'range', 'odo'],
  );
  assert.equal(ev.rows[0].value, '80%');
  assert.equal(ev.rows[2].value, '--');
  const none = vehicleView({});
  assert.equal(none.known, false);
  assert.equal(none.title, 'VEHICLE');
  assert.ok(none.rows.every((r) => r.value === '--'));
  assert.equal(vehicleView({ lowFuel: true }).lowFuel, true);
});

test('parked after three seconds under 1 m/s, driving at once', () => {
  const p = createParkedTracker();
  assert.equal(p.update(12, 0), false);
  assert.equal(p.update(0.4, 1000), false);
  assert.equal(p.update(0.2, 3000), false);
  assert.equal(p.update(0, 4000), true);
  assert.equal(p.parked, true);
  // Creeping in a car park (1.2 m/s) does not count as driving off.
  assert.equal(p.update(1.2, 4500), true);
  assert.equal(p.update(2, 5000), false);
  // A stop shorter than three seconds is not parking.
  p.update(0, 6000);
  assert.equal(p.update(5, 8000), false);
  assert.equal(p.update(0, 9000), false);
  // No speed at all counts as standing.
  assert.equal(p.update(null, 12_500), true);
});
