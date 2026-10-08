import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aqGrid,
  aqQuery,
  parseAirQuality,
  sampleAirQuality,
  aqiCategory,
  formatAirQuality,
  airQualityPixels,
  AQ_CURRENT,
  AQ_PATH,
  AQI_CATEGORIES,
} from './field.js';
import { createAirQualitySource, createAirQualityMockSource } from './source.js';
import { windGrid } from '../wind/field.js';

const view = { lamin: 40, lomin: -10, lamax: 55, lomax: 10 };

const answer = (grid, f) =>
  grid.lats.map((lat, k) => ({
    current: { time: '2026-10-08T09:00', ...f(lat, grid.lons[k], k) },
  }));

test('the grid and query match the wind grid shape, with the AQ fields', () => {
  const g = aqGrid(view);
  assert.equal(g.lats.length, 48);
  const q = aqQuery(g);
  assert.equal(q.current, AQ_CURRENT);
  assert.equal(q.timezone, 'UTC');
  assert.equal(q.latitude.split(',').length, 48);
  assert.equal(AQ_PATH, '/air-quality');
});

test('parse keeps every pollutant, NaN where missing, and samples bilinearly', () => {
  const g = windGrid(view, { nx: 2, ny: 2 });
  const payload = answer(g, (lat, lon, k) =>
    k === 3 ? { us_aqi: null } : { us_aqi: 40, european_aqi: 20, pm2_5: 8, ozone: 70 },
  );
  const f = parseAirQuality(payload, g);
  assert.equal(f.count, 3);
  assert.equal(f.time, '2026-10-08T09:00');
  assert.ok(Number.isNaN(f.usAqi[3]));
  assert.ok(Number.isNaN(f.pm10[0]), 'pm10 never sent');
  // The missing corner is left out of the blend, not averaged as zero.
  const s = sampleAirQuality(f, (g.west + g.east) / 2, (g.south + g.north) / 2);
  assert.equal(s.usAqi, 40);
  assert.equal(s.pm10, null);
  assert.equal(sampleAirQuality(f, 100, 0), null, 'outside the grid');
  assert.equal(parseAirQuality([{}], g), null, 'wrong length');
  assert.equal(
    parseAirQuality(
      answer(g, () => ({})),
      g,
    ),
    null,
    'nothing measured',
  );
});

test('AQI categories, readout and colours', () => {
  assert.equal(aqiCategory(0).label, 'Good');
  assert.equal(aqiCategory(50).label, 'Good');
  assert.equal(aqiCategory(50.6).label, 'Moderate');
  assert.equal(aqiCategory(151).label, 'Unhealthy');
  assert.equal(aqiCategory(400).label, 'Hazardous');
  assert.equal(aqiCategory(NaN), null);
  assert.equal(formatAirQuality({ usAqi: 42.2 }), 'AQI 42 GOOD');
  assert.equal(formatAirQuality({ usAqi: 120 }), 'AQI 120 USG');
  assert.equal(formatAirQuality(null), '--');
  assert.equal(AQI_CATEGORIES.length, 6);
});

test('overlay pixels take the category colour, softly faded at the edges', () => {
  const g = windGrid(view, { nx: 2, ny: 2 });
  const f = parseAirQuality(
    answer(g, () => ({ us_aqi: 160 })),
    g,
  );
  const w = 40;
  const h = 30;
  const px = airQualityPixels(f, w, h, 150);
  const mid = ((h / 2) * w + w / 2) * 4;
  assert.deepEqual([...px.subarray(mid, mid + 4)], [255, 0, 0, 150]);
  assert.ok(px[3] < 150, 'the corner fades');
  assert.ok(airQualityPixels(null, 2, 2).every((v) => v === 0));
});

test('the source asks the pinned feed for the view grid; the mock fills it', async () => {
  let asked = null;
  const src = createAirQualitySource({
    proxyClient: {
      getJson: async (id, path, opts) => {
        asked = { id, path, params: opts.params };
        return [];
      },
    },
  });
  const out = await src({ bbox: view });
  assert.equal(asked.id, 'openmeteo-aq');
  assert.equal(asked.path, '/air-quality');
  assert.equal(asked.params.current, AQ_CURRENT);
  assert.equal(out.grid.lats.length, 48);
  assert.equal(await src({}), null);
  const mock = await createAirQualityMockSource()({ bbox: view });
  const f = parseAirQuality(mock.payload, mock.grid);
  assert.equal(f.count, 48);
});
