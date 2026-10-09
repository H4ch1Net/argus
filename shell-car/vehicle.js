// The VEHICLE panel's numbers: pure (no DOM), tested in vehicle.test.js. The
// Android app reads the car through the Car App Library's CarInfo (make,
// model, year, energy profile, fuel and battery level, range, odometer,
// speed; see android/.../car/CarStats.kt) and sends it with
// argusCar.setCarInfo(json). This turns that into what the panel shows: a
// body variant for the silhouette, readouts in the driver's units, the
// average consumption since the last fill-up, and whether the vehicle is
// parked (the panel shows only then).

import { clamp, formatDistance } from './model.js';

const ELECTRIC = 'electric';
const HEAVY = new Set(['diesel_1', 'diesel_2', 'biodiesel', 'lpg', 'cng', 'lng']);
const BODY_STYLES = new Set(['sedan', 'suv', 'ev']);
const US_GALLON_L = 3.785411784;
const IMP_GALLON_L = 4.54609;

/**
 * The silhouette to draw: 'ev' for a car that only takes electricity, 'suv'
 * for the fuels that mostly mean a truck or SUV (diesel, gas), else 'sedan'.
 * The car does not report its body style; this is a guess from its fuels
 * (the phone's Settings can name it instead: setCarInfo's `body`).
 */
export function vehicleVariant({ fuelTypes } = {}) {
  const fuels = (fuelTypes || []).map(String);
  if (fuels.length && fuels.every((f) => f === ELECTRIC)) return 'ev';
  if (fuels.some((f) => HEAVY.has(f))) return 'suv';
  return 'sedan';
}

/**
 * Average consumption since the fill-up the app last saw: the drop in fuel
 * level times the tank size, over the distance on the odometer. Null until it
 * means something: a known tank, at least 8 km driven and a measurable drop
 * (fuel gauges move in steps of about a percent).
 * @returns {{ litres: number, km: number, lPer100km: number } | null}
 */
export function consumption({
  fuelPctStart,
  fuelPct,
  odometerStartM,
  odometerM,
  tankL,
} = {}) {
  const vals = [fuelPctStart, fuelPct, odometerStartM, odometerM, tankL];
  if (!vals.every(Number.isFinite) || tankL <= 0) return null;
  const km = (odometerM - odometerStartM) / 1000;
  const used = ((fuelPctStart - fuelPct) / 100) * tankL;
  if (km < 8 || used < 0.5) return null;
  const lPer100km = (used / km) * 100;
  // Anything outside 1 to 40 L/100 km is a gauge glitch or a wrong tank size.
  if (lPer100km < 1 || lPer100km > 40) return null;
  return { litres: used, km, lPer100km };
}

/** Miles per gallon from L/100 km: US gallons, or imperial ones. */
export const mpg = (lPer100km, imperialGallon = false) =>
  (100 / lPer100km) * ((imperialGallon ? IMP_GALLON_L : US_GALLON_L) / 1.609344);

/** UK miles use the imperial gallon; the other mile countries the US one. */
export const usesImperialGallon = (locale) => /[-_]GB\b/i.test(String(locale || ''));

const pct = (v) => (Number.isFinite(v) ? `${Math.round(clamp(v, 0, 100))}%` : '--');

function odometer(m, units) {
  if (!Number.isFinite(m) || m < 0) return '--';
  const v = units === 'imperial' ? m / 1609.344 : m / 1000;
  return `${Math.round(v).toLocaleString('en-US')} ${units === 'imperial' ? 'MI' : 'KM'}`;
}

/**
 * Everything the VEHICLE panel draws, from a setCarInfo payload.
 * @param {object} info  { model?: { make, name, year }, energy?: { fuelTypes }, body?,
 *   fuelPct?, batteryPct?, rangeM?, lowFuel?, odometerM?, speedMps?,
 *   economy?: { fuelPctStart, odometerStartM }, tankL? }
 * @param {{ units?: 'metric'|'imperial', imperialGallon?: boolean }} [opts]
 */
export function vehicleView(info, { units = 'metric', imperialGallon = false } = {}) {
  const i = info || {};
  const model = i.model || {};
  const fuels = i.energy?.fuelTypes || [];
  // The body the driver chose in the phone's Settings wins over the guess.
  const variant = BODY_STYLES.has(i.body) ? i.body : vehicleVariant({ fuelTypes: fuels });
  const name = [model.make, model.name, Number.isFinite(model.year) ? model.year : null]
    .filter((p) => p !== null && p !== undefined && String(p).trim())
    .map((p) => String(p).trim().toUpperCase())
    .join(' ');
  const electricOnly = variant === 'ev';
  const hasBattery = Number.isFinite(i.batteryPct) || fuels.includes(ELECTRIC);
  const rows = [];
  if (!electricOnly)
    rows.push({ key: 'fuel', label: 'FUEL', value: pct(i.fuelPct), meter: i.fuelPct });
  if (hasBattery)
    rows.push({
      key: 'battery',
      label: 'BATTERY',
      value: pct(i.batteryPct),
      meter: i.batteryPct,
    });
  rows.push({
    key: 'range',
    label: 'RANGE',
    value: Number.isFinite(i.rangeM)
      ? formatDistance(i.rangeM, units).replace(/([0-9])([A-Z])/, '$1 $2')
      : '--',
  });
  rows.push({ key: 'odo', label: 'ODO', value: odometer(i.odometerM, units) });
  if (!electricOnly) {
    const c = consumption({
      fuelPctStart: i.economy?.fuelPctStart,
      fuelPct: i.fuelPct,
      odometerStartM: i.economy?.odometerStartM,
      odometerM: i.odometerM,
      tankL: i.tankL,
    });
    rows.push(
      units === 'imperial'
        ? {
            key: 'avg',
            label: 'AVG MPG',
            value: c ? mpg(c.lPer100km, imperialGallon).toFixed(1) : '--',
          }
        : { key: 'avg', label: 'AVG L/100KM', value: c ? c.lPer100km.toFixed(1) : '--' },
    );
  }
  const known =
    Boolean(name) ||
    [i.fuelPct, i.batteryPct, i.rangeM, i.odometerM].some(Number.isFinite) ||
    fuels.length > 0;
  return {
    known,
    variant,
    title: name || 'VEHICLE',
    rows,
    lowFuel: i.lowFuel === true,
  };
}

/**
 * Parked or driving, from the speed (the car's own, else the GPS): parked
 * once it has stayed under `stopMps` for `parkMs`, driving again as soon as
 * it passes `goMps`. No speed for a while counts as standing still.
 */
export function createParkedTracker({ parkMs = 3000, stopMps = 1, goMps = 1.5 } = {}) {
  let parked = false;
  let slowSince = null;
  return {
    update(speed, now) {
      const s = Number.isFinite(speed) ? speed : 0;
      if (s >= goMps || (s >= stopMps && !parked)) {
        parked = false;
        slowSince = null;
      } else if (s < stopMps) {
        slowSince ??= now;
        if (now - slowSince >= parkMs) parked = true;
      }
      return parked;
    },
    get parked() {
      return parked;
    },
  };
}
