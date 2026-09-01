import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  snapBBox,
  areaTooLarge,
  buildBBoxQuery,
  createOverpassSource,
} from './client.js';
import { parseOverpass } from './parse.js';

test('snapBBox expands to the coarse grid', () => {
  const s = snapBBox({ lamin: 40.03, lomin: -74.07, lamax: 40.12, lomax: -73.94 });
  assert.equal(Math.round(s.lamin * 10) / 10, 40.0);
  assert.equal(Math.round(s.lamax * 10) / 10, 40.2);
  assert.equal(Math.round(s.lomin * 10) / 10, -74.1);
  assert.equal(Math.round(s.lomax * 10) / 10, -73.9);
});

test('areaTooLarge gates broad views', () => {
  assert.equal(areaTooLarge({ lamin: 0, lomin: 0, lamax: 1, lomax: 1 }, 3), false);
  assert.equal(areaTooLarge({ lamin: 0, lomin: 0, lamax: 10, lomax: 1 }, 3), true);
});

test('buildBBoxQuery composes QL with south,west,north,east order', () => {
  const ql = buildBBoxQuery(['node["man_made"="surveillance"]'], {
    lamin: 40,
    lomin: -74,
    lamax: 41,
    lomax: -73,
  });
  assert.match(ql, /\[out:json\]/);
  assert.match(ql, /node\["man_made"="surveillance"\]\(40,-74,41,-73\);/);
  assert.match(ql, /out center 2000;/);
});

test('source skips broad views, queries + caches narrow ones', async () => {
  let calls = 0;
  const proxyClient = {
    getJson: async () => {
      calls += 1;
      return {
        elements: [
          {
            type: 'node',
            id: 1,
            lat: 40.5,
            lon: -73.5,
            tags: { man_made: 'surveillance' },
          },
        ],
      };
    },
  };
  const source = createOverpassSource({
    proxyClient,
    filters: ['node["x"]'],
    maxAreaDeg: 3,
  });

  const broad = await source({ bbox: { lamin: 0, lomin: 0, lamax: 20, lomax: 20 } });
  assert.deepEqual(broad, { elements: [] });
  assert.equal(calls, 0);

  const bbox = { lamin: 40.4, lomin: -73.6, lamax: 40.5, lomax: -73.5 };
  const a = await source({ bbox });
  const b = await source({ bbox }); // same snapped region -> cache hit
  assert.equal(calls, 1);
  assert.equal(parseOverpass(a).length, 1);
  assert.deepEqual(a, b);
});
