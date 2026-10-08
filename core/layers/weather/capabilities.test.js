import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWmsCapabilities,
  selectFrame,
  unionTimeline,
  isoInstant,
  CAPABILITIES_PARAMS,
} from './capabilities.js';

const NOW = Date.UTC(2026, 9, 8, 12, 0);
const iso = (minAgo) =>
  new Date(NOW - minAgo * 60_000).toISOString().replace('.000Z', 'Z');

function doc({
  times,
  def = times.at(-1),
  name = 'conus_base_reflectivity_mosaic',
  extra = '',
}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms">
  <Capability>
    <Layer>
      <Title>observations</Title>
      <Layer queryable="1">
        <Name>other_layer</Name>
        <EX_GeographicBoundingBox>
          <westBoundLongitude>-10</westBoundLongitude><eastBoundLongitude>10</eastBoundLongitude>
          <southBoundLatitude>-10</southBoundLatitude><northBoundLatitude>10</northBoundLatitude>
        </EX_GeographicBoundingBox>
        <Dimension name="time" units="ISO8601" default="${iso(0)}">${iso(0)}</Dimension>
      </Layer>
      <Layer queryable="1">
        <Name>${name}</Name>
        <EX_GeographicBoundingBox>
          <westBoundLongitude>-127</westBoundLongitude>
          <eastBoundLongitude>-65</eastBoundLongitude>
          <southBoundLatitude>20</southBoundLatitude>
          <northBoundLatitude>52</northBoundLatitude>
        </EX_GeographicBoundingBox>
        <Dimension name="time" units="ISO8601" default="${def}">${times.join(',')}</Dimension>
        ${extra}
      </Layer>
    </Layer>
  </Capability>
</WMS_Capabilities>`;
}

const times = Array.from({ length: 40 }, (_, i) => iso((39 - i) * 4)); // every 4 min

test('reads the leaf layer, its bounds and the latest frames', () => {
  const caps = parseWmsCapabilities(doc({ times }), 'conus_base_reflectivity_mosaic', {
    nowMs: NOW,
  });
  assert.deepEqual(caps.bounds, { west: -127, south: 20, east: -65, north: 52 });
  assert.equal(caps.times.length, 13);
  assert.equal(caps.allowedTimes.length, 26);
  assert.equal(caps.times.at(-1), new Date(NOW).toISOString());
  assert.equal(caps.defaultTime, caps.times.at(-1));
  assert.ok(caps.times.every((t, i, a) => i === 0 || a[i - 1] < t));
  // A workspace-prefixed name matches too.
  const prefixed = doc({ times, name: 'weather_radar:conus_base_reflectivity_mosaic' });
  assert.equal(
    parseWmsCapabilities(prefixed, 'conus_base_reflectivity_mosaic', { nowMs: NOW }).times
      .length,
    13,
  );
  assert.deepEqual(CAPABILITIES_PARAMS, {
    service: 'WMS',
    version: '1.3.0',
    request: 'GetCapabilities',
  });
});

test('refuses DOCTYPE and ENTITY declarations, and oversized documents', () => {
  const bad = `<!DOCTYPE x [<!ENTITY a "b">]>${doc({ times })}`;
  assert.throws(
    () => parseWmsCapabilities(bad, 'conus_base_reflectivity_mosaic'),
    /DOCTYPE/,
  );
  const ent = doc({ times }).replace('<Capability>', '<!ENTITY lol "lol"><Capability>');
  assert.throws(() => parseWmsCapabilities(ent, 'conus_base_reflectivity_mosaic'));
  assert.throws(() =>
    parseWmsCapabilities(' '.repeat(600 * 1024), 'conus_base_reflectivity_mosaic'),
  );
  assert.throws(() => parseWmsCapabilities(null, 'x'));
});

test('refuses intervals, future times, a missing layer and a bad default', () => {
  const opts = { nowMs: NOW };
  const L = 'conus_base_reflectivity_mosaic';
  assert.throws(() =>
    parseWmsCapabilities(doc({ times: [`${iso(60)}/${iso(0)}/PT4M`] }), L, opts),
  );
  assert.throws(() =>
    parseWmsCapabilities(doc({ times: [...times, iso(-30)] }), L, opts),
  );
  assert.throws(() => parseWmsCapabilities(doc({ times }), 'secret_layer', opts));
  assert.throws(() => parseWmsCapabilities(doc({ times, def: iso(999) }), L, opts));
  assert.throws(() =>
    parseWmsCapabilities(
      doc({ times, extra: '<Dimension name="time" units="ISO8601">x</Dimension>' }),
      L,
      opts,
    ),
  );
  assert.throws(() =>
    parseWmsCapabilities(doc({ times: [iso(48 * 60)], def: iso(48 * 60) }), L, opts),
  );
  // Nested Layer elements must balance.
  assert.throws(() =>
    parseWmsCapabilities(doc({ times }).replace('</Layer>', ''), L, opts),
  );
});

test('strict UTC instants only', () => {
  assert.equal(isoInstant('2026-10-08T12:00:00Z'), '2026-10-08T12:00:00.000Z');
  assert.equal(isoInstant('2026-10-08T12:00:00.000Z'), '2026-10-08T12:00:00.000Z');
  assert.equal(isoInstant('2026-02-30T00:00:00Z'), null);
  assert.equal(isoInstant('2026-10-08T12:00:00+01:00'), null);
  assert.equal(isoInstant('2026-10-08'), null);
  assert.equal(isoInstant('PT1H'), null);
});

test('selectFrame picks the newest frame at or before the target within the gap', () => {
  const list = [iso(60), iso(30), iso(10)];
  assert.equal(
    selectFrame(list, NOW, 30 * 60_000),
    new Date(NOW - 600_000).toISOString().replace('.000Z', 'Z'),
  );
  assert.equal(selectFrame(list, NOW - 20 * 60_000, 30 * 60_000), iso(30));
  assert.equal(selectFrame(list, NOW - 100 * 60_000, 30 * 60_000), null); // too old
  assert.equal(selectFrame(list, NOW - 61 * 60_000, 30 * 60_000), null); // before all
  assert.equal(selectFrame([], NOW, 1), null);
  assert.equal(selectFrame(list, 'not a time', 1), null);
});

test('unionTimeline merges, de-duplicates and sorts', () => {
  const u = unionTimeline([[iso(10), iso(30)], [iso(30), iso(20)], null, ['junk']]);
  assert.equal(u.length, 3);
  assert.ok(Date.parse(u[0]) < Date.parse(u[2]));
});
