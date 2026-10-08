import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cycloneConeEntities,
  cycloneTrackEntities,
  forecastStatusNote,
} from './parse.js';
import { describeCone, describeTrack, CONE_NOTE, forecastSearchText } from './format.js';
import { createCycloneForecastMockSource, forecastGeometryFor } from './mockSource.js';
import { createCycloneForecastSource } from './source.js';
import { nhcGisParams, NHC_GIS_LAYERS } from '../cyclones/forecast.js';

test('the demo payload yields one cone and one track per storm', async () => {
  const raw = await createCycloneForecastMockSource()();
  const cones = cycloneConeEntities(raw);
  const tracks = cycloneTrackEntities(raw);
  assert.equal(cones.length, 2);
  assert.equal(tracks.length, 2);
  const cone = cones[0];
  assert.match(cone.id, /^nhccone:al992026:7:0$/);
  assert.equal(cone.type, 'cyclone-cone');
  assert.ok(cone.meta.polygon.length >= 3);
  // Open ring: the renderer closes it.
  const [a, b] = [cone.meta.polygon[0], cone.meta.polygon.at(-1)];
  assert.ok(a[0] !== b[0] || a[1] !== b[1]);
  assert.ok(Number.isFinite(cone.position.longitude));
  assert.equal(tracks[0].meta.path.length, 8);
  assert.deepEqual(
    [tracks[0].position.longitude, tracks[0].position.latitude],
    tracks[0].meta.path[0],
  );
  assert.equal(forecastStatusNote(raw), '');
});

test('cards say what the cone means and list the official forecast', async () => {
  const raw = await createCycloneForecastMockSource()();
  const card = describeCone(cycloneConeEntities(raw)[0]);
  assert.equal(card.title, 'Demo Alpha');
  assert.match(card.subtitle, /advisory #7/);
  assert.ok(card.rows.some(([, v]) => v === CONE_NOTE));
  assert.equal(CONE_NOTE, 'cone = uncertainty in the centre track, not storm size');
  assert.equal(card.sections[0].rows[0][0], 'Now');
  assert.match(card.sections[0].rows[1][0], /^\+12 h$/);
  assert.ok(card.rows.some(([k, v]) => k === 'Source' && /demo/.test(v)));
  const track = describeTrack(cycloneTrackEntities(raw)[0]);
  assert.match(track.subtitle, /^Forecast track/);
  assert.match(forecastSearchText(cycloneConeEntities(raw)[0]), /demo alpha/i);
});

test('no geometry for a storm whose GIS advisory is behind the status', () => {
  const storm = {
    id: 'al992026',
    name: 'Late',
    intensity: '60',
    latitudeNumeric: 20,
    longitudeNumeric: -60,
    movementDir: 300,
    movementSpeed: 10,
    forecastAdvisory: { advNum: '008' },
  };
  const raw = { status: { activeStorms: [storm] }, gis: forecastGeometryFor(storm, '7') };
  assert.deepEqual(cycloneConeEntities(raw), []);
  assert.deepEqual(cycloneTrackEntities(raw), []);
  assert.equal(forecastStatusNote(raw), 'awaiting current-advisory geometry');
  assert.equal(
    forecastStatusNote({ status: { activeStorms: [storm] }, gis: null }),
    'forecast geometry unavailable',
  );
  assert.equal(forecastStatusNote({ status: { activeStorms: [] } }), 'no active storms');
});

test('the source asks the GIS layers only with storms active, and shares one load', async () => {
  const calls = [];
  const proxyClient = {
    async getJson(feed, path, opts = {}) {
      calls.push({ feed, path, params: opts.params });
      if (feed === 'nhc') return { activeStorms: [{ id: 'al012026' }] };
      return { type: 'FeatureCollection', features: [] };
    },
  };
  const a = createCycloneForecastSource({ proxyClient });
  const b = createCycloneForecastSource({ proxyClient });
  const [ra, rb] = await Promise.all([a({}), b({})]);
  assert.equal(ra, rb);
  assert.equal(calls.length, 4);
  assert.deepEqual(
    calls.slice(1).map((c) => c.path),
    ['/5/query', '/6/query', '/7/query'],
  );
  assert.deepEqual(calls[1].params, nhcGisParams(NHC_GIS_LAYERS[0]));
  await a({});
  assert.equal(calls.length, 4); // within the share window

  const quiet = [];
  const idle = createCycloneForecastSource({
    proxyClient: {
      async getJson(feed) {
        quiet.push(feed);
        return { activeStorms: [] };
      },
    },
  });
  assert.deepEqual(await idle({}), { status: { activeStorms: [] }, gis: null });
  assert.deepEqual(quiet, ['nhc']);
});

test('an aborted caller rejects without cancelling the shared load', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const proxyClient = {
    async getJson() {
      await gate;
      return { activeStorms: [] };
    },
  };
  const src = createCycloneForecastSource({ proxyClient });
  const controller = new AbortController();
  const aborted = src({}, controller.signal);
  const other = src({});
  controller.abort();
  await assert.rejects(aborted, { name: 'AbortError' });
  release();
  assert.deepEqual((await other).gis, null);
});
