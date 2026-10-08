import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CITIES } from '../search/places.js';
import {
  cadenceMs,
  ecefToLatLon,
  fmtAlt,
  fmtBearing,
  fmtDistKm,
  fmtGsd,
  fmtSignedDeg,
  gsdMetres,
  headingDeg,
  inFreeArea,
  intelReadout,
  NEAR_MAX_KM,
  nearestPlace,
  niirsFromGsd,
  normalizePlaces,
  offNadirDeg,
  utcStamp,
  viewBand,
} from './intelHudModel.js';

const near = (actual, expected, tol, msg) =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg ?? ''} expected ${expected} +/- ${tol}, got ${actual}`,
  );
const RAD = Math.PI / 180;
const PLACES = normalizePlaces(CITIES);

test('the pure half stays pure: no Cesium, no DOM', () => {
  for (const f of ['./intelHudModel.js', '../geo/mgrs.js', '../geo/sun.js']) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /from ['"]cesium['"]/, f);
    assert.doesNotMatch(src, /\bdocument\.|\bwindow\./, f);
  }
});

test('view bands by camera altitude', () => {
  const cases = [
    [0, 'STREET'],
    [1999, 'STREET'],
    [2000, 'CITY'],
    [24999, 'CITY'],
    [25000, 'METRO'],
    [119999, 'METRO'],
    [120000, 'REGIONAL'],
    [999999, 'REGIONAL'],
    [1000000, 'GLOBAL'],
    [2e7, 'GLOBAL'],
    [-50, 'STREET'],
  ];
  for (const [alt, band] of cases) assert.equal(viewBand(alt), band, `${alt}`);
  assert.equal(viewBand(NaN), null);
  assert.equal(viewBand(undefined), null);
});

test('GSD from range, vertical FOV and canvas height', () => {
  // 1 km straight down, 60 degree FOV over 1000 px: 2 * 1000 * tan(30) / 1000.
  near(gsdMetres(1000, 60 * RAD, 1000), 1.1547, 1e-4);
  // The FOV defaults to 60 degrees when the frustum has none.
  assert.equal(gsdMetres(1000, undefined, 1000), gsdMetres(1000, 60 * RAD, 1000));
  // Scales linearly with range, inversely with pixels.
  near(gsdMetres(2000, 60 * RAD, 500), 4 * gsdMetres(1000, 60 * RAD, 1000), 1e-9);
  assert.equal(gsdMetres(0, 1, 1000), null);
  assert.equal(gsdMetres(-5, 1, 1000), null);
  assert.equal(gsdMetres(1000, 1, 0), null);
  assert.equal(gsdMetres(NaN, 1, 1000), null);
});

test('NIIRS by the simplified GIQE, clamped to 0..9', () => {
  // 1 m = 39.37 in: 10.25 - 3.32 * log10(39.37) = 4.95.
  near(niirsFromGsd(1), 4.954, 0.001);
  // Round trip: the GSD that should read NIIRS 6.
  near(niirsFromGsd(0.0254 * 10 ** ((10.25 - 6) / 3.32)), 6, 1e-9);
  assert.equal(niirsFromGsd(0.001), 9);
  assert.equal(niirsFromGsd(1000), 0);
  assert.equal(niirsFromGsd(0), null);
  assert.equal(niirsFromGsd(null), null);
});

test('off-nadir angle and heading from camera radians', () => {
  assert.equal(offNadirDeg(-Math.PI / 2), 0);
  near(offNadirDeg(-Math.PI / 4), 45, 1e-9);
  assert.equal(offNadirDeg(0), 90);
  assert.equal(offNadirDeg(0.3), 90); // looking up still clamps to the horizon
  assert.equal(offNadirDeg(undefined), null);
  near(headingDeg(-Math.PI / 2), 270, 1e-9);
  near(headingDeg(2 * Math.PI + 0.1), 0.1 / RAD, 1e-9);
  assert.equal(headingDeg(0), 0);
  assert.equal(headingDeg(null), null);
});

test('places: CITIES rows and { name, lat, lon } objects both work', () => {
  assert.equal(PLACES.length, CITIES.length);
  assert.deepEqual(PLACES[0], {
    name: CITIES[0][0],
    lat: CITIES[0][1],
    lon: CITIES[0][2],
  });
  assert.deepEqual(
    normalizePlaces([
      { name: 'A', lat: 1, lon: 2 },
      { name: 'B', lat: 3, lng: 4 },
      { name: '', lat: 0, lon: 0 },
      { name: 'C', lat: 'x', lon: 0 },
      ['D', 5, 6, 3, 'Country'],
      null,
    ]),
    [
      { name: 'A', lat: 1, lon: 2 },
      { name: 'B', lat: 3, lon: 4 },
      { name: 'D', lat: 5, lon: 6 },
    ],
  );
  assert.deepEqual(normalizePlaces(undefined), []);
});

test('nearest place with distance and bearing from the point to it', () => {
  const grid = [
    { name: 'North', lat: 1, lon: 0 },
    { name: 'East', lat: 0, lon: 3 },
  ];
  const n = nearestPlace(0, 0, grid);
  assert.equal(n.name, 'North');
  near(n.distKm, 111.2, 0.1); // one degree of latitude
  near(n.bearingDeg, 0, 1e-9);
  const e = nearestPlace(0, 2.5, grid);
  assert.equal(e.name, 'East');
  near(e.bearingDeg, 90, 1e-6);
  // From the Eiffel Tower, central Paris lies about 4 km to the east.
  const p = nearestPlace(48.8584, 2.2945, PLACES);
  assert.equal(p.name, 'Paris');
  near(p.distKm, 4.06, 0.05);
  near(p.bearingDeg, 87.5, 1);
  assert.equal(nearestPlace(0, 0, []), null);
  assert.equal(nearestPlace(NaN, 0, grid), null);
});

test('ECEF to geodetic round-trips to the millimetre', () => {
  const a = 6378137;
  const e2 = (1 / 298.257223563) * (2 - 1 / 298.257223563);
  const toEcef = (lat, lon, h) => {
    const p = lat * RAD;
    const l = lon * RAD;
    const n = a / Math.sqrt(1 - e2 * Math.sin(p) ** 2);
    return {
      x: (n + h) * Math.cos(p) * Math.cos(l),
      y: (n + h) * Math.cos(p) * Math.sin(l),
      z: (n * (1 - e2) + h) * Math.sin(p),
    };
  };
  for (const [lat, lon, h] of [
    [48.8584, 2.2945, 300],
    [-33.8568, 151.2153, 0],
    [0, -179.5, 8848],
    [89.9999, 45, 2800],
    [-90, 0, 0],
    [12.34, -56.78, -400],
  ]) {
    const g = ecefToLatLon(toEcef(lat, lon, h));
    near(g.lat, lat, 1e-9, 'lat');
    if (Math.abs(lat) < 90) near(g.lon, lon, 1e-9, 'lon');
    near(g.height, h, 0.001, 'height');
  }
  const eq = ecefToLatLon({ x: a, y: 0, z: 0 });
  near(eq.lat, 0, 1e-12);
  near(eq.lon, 0, 1e-12);
  assert.equal(ecefToLatLon(undefined), null);
  assert.equal(ecefToLatLon({ x: 0, y: 0, z: 0 }), null);
  assert.equal(ecefToLatLon({ x: 1, y: 2 }), null);
});

test('free area and cadence', () => {
  const insets = { top: 50, right: 45, bottom: 300, left: 0 };
  assert.equal(inFreeArea(180, 390, 360, 780, insets), true);
  assert.equal(inFreeArea(180, 500, 360, 780, insets), false); // under the sheet
  assert.equal(inFreeArea(340, 200, 360, 780, insets), false); // under the stack
  assert.equal(inFreeArea(1, 1, 10, 10), true);
  assert.equal(cadenceMs('minimal'), 500);
  assert.equal(cadenceMs('MINIMAL'), 500);
  assert.equal(cadenceMs('balanced'), 250);
  assert.equal(cadenceMs(undefined), 250);
});

test('formatting', () => {
  assert.equal(fmtAlt(850.4), '850M');
  assert.equal(fmtAlt(12400), '12.4KM');
  assert.equal(fmtAlt(1204000), '1204KM');
  assert.equal(fmtAlt(null), '---');
  assert.equal(fmtGsd(0.4213), '0.42M');
  assert.equal(fmtGsd(12.34), '12.3M');
  assert.equal(fmtGsd(640.2), '640M');
  assert.equal(fmtGsd(1250), '1.25KM');
  assert.equal(fmtGsd(25650), '25.6KM');
  assert.equal(fmtGsd(250000), '250KM');
  assert.equal(fmtDistKm(0.64), '640M');
  assert.equal(fmtDistKm(4.06), '4.1KM');
  assert.equal(fmtDistKm(312.4), '312KM');
  assert.equal(fmtBearing(45), '045°');
  assert.equal(fmtBearing(359.6), '000°');
  assert.equal(fmtBearing(-90), '270°');
  assert.equal(fmtBearing(undefined), '---°');
  assert.equal(fmtSignedDeg(32.14), '+32.1°');
  assert.equal(fmtSignedDeg(-4), '-4.0°');
  assert.equal(fmtSignedDeg(-0.04), '+0.0°');
  assert.deepEqual(utcStamp(new Date('2026-10-08T09:48:12.345Z')), {
    date: '2026-10-08',
    time: '09:48:12Z',
  });
});

test('readout: centre point over the Eiffel Tower, straight down from 12 km', () => {
  const r = intelReadout({
    center: { lat: 48.8584, lon: 2.2945 },
    camera: { lat: 48.8584, lon: 2.2945, height: 12000 },
    groundHeight: 35,
    rangeM: 11965,
    pitch: -Math.PI / 2,
    heading: 0,
    fovy: 60 * RAD,
    heightPx: 900,
    places: PLACES,
    date: new Date('2026-10-08T09:48:12Z'),
  });
  assert.equal(r.source, 'CENTER');
  assert.equal(r.band, 'CITY');
  near(r.gsdM, (2 * 11965 * Math.tan(30 * RAD)) / 900, 1e-9);
  assert.deepEqual(r.text, {
    date: '2026-10-08',
    time: '09:48:12Z',
    band: 'CITY',
    alt: '12.0KM',
    hdg: '000°',
    ona: '0.0°',
    mgrs: '31U DQ 48252 11954',
    dms: `48°51'30"N 002°17'40"E`,
    gsd: '15.4M',
    niirs: '1.0',
    sun: '+30.2°',
    nearLabel: 'NEAR',
    near: 'PARIS 4.1KM 087°',
  });
});

test('readout: sky at the centre falls back to the camera nadir and AGL', () => {
  const r = intelReadout({
    center: null,
    camera: { lat: -33.8568, lon: 151.2153, height: 3000 },
    groundHeight: 500,
    rangeM: 99999, // ignored without a centre hit
    pitch: -0.2,
    heading: -Math.PI / 2,
    heightPx: 1000,
    places: PLACES,
    date: new Date('2026-10-08T09:48:12Z'),
  });
  assert.equal(r.source, 'NADIR');
  assert.equal(r.aglM, 2500);
  near(r.gsdM, (2 * 2500 * Math.tan(30 * RAD)) / 1000, 1e-9);
  assert.equal(r.text.mgrs, '56H LH 34900 52288');
  assert.equal(r.text.hdg, '270°');
  assert.equal(r.text.ona, '78.5°');
  assert.equal(r.text.near, 'SYDNEY 1.5KM 198°');
});

test('readout: far from any place reads REF, not NEAR', () => {
  const r = intelReadout({
    center: { lat: 0, lon: -140 },
    camera: { lat: 0, lon: -140, height: 2e7 },
    rangeM: 2e7,
    pitch: -Math.PI / 2,
    heading: 0,
    fovy: 60 * RAD,
    heightPx: 900,
    places: PLACES,
    date: new Date('2026-10-08T09:48:12Z'),
  });
  assert.equal(r.band, 'GLOBAL');
  assert.ok(r.near.distKm > NEAR_MAX_KM);
  assert.equal(r.text.nearLabel, 'REF');
  assert.equal(r.text.niirs, '0.0');
});

test('readout: no camera at all is all dashes, never a throw', () => {
  const t = intelReadout({}).text;
  for (const k of ['band', 'alt', 'mgrs', 'dms', 'gsd', 'niirs', 'near']) {
    assert.equal(t[k], '---', k);
  }
  assert.equal(t.sun, '---°');
  assert.equal(intelReadout({ center: { lat: 89, lon: 0 } }).text.mgrs, '---'); // UPS: out of scope
});
