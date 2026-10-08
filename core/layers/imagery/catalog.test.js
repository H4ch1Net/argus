import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateBox,
  boxFromPin,
  boxFromBBox,
  boxSideKm,
  catalogWindow,
  cmrQuery,
  parseCmrUmm,
  fetchCmrPages,
  createCmrFetcher,
  groupGranulesByDay,
  coverageFor,
  viirsCandidates,
  searchImagery,
  rankLatest,
  formatCandidate,
  gibsTileTemplate,
  imageryRasterSpec,
  wvsSnapshotParams,
  wvsSnapshotUrl,
  snapshotSize,
  createImageryCatalogue,
  parseCandidateKey,
} from './catalog.js';

// The proxy client's buildUrl, minus the network.
function buildUrl(feedId, path = '/', params) {
  const url = new URL(`https://proxy.test/feed/${feedId}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));
  return url.toString();
}

const BOX = { west: -122.6, south: 37.6, east: -122.3, north: 37.9 };
const NOW = Date.parse('2026-10-08T15:00:00Z');

function granule(id, start, cloud, ring) {
  return {
    meta: { 'concept-id': id },
    umm: {
      TemporalExtent: {
        RangeDateTime: { BeginningDateTime: start, EndingDateTime: start },
      },
      AdditionalAttributes: [{ Name: 'CLOUD_COVERAGE', Values: [String(cloud)] }],
      SpatialExtent: {
        HorizontalSpatialDomain: {
          Geometry: {
            GPolygons: [
              {
                Boundary: {
                  Points: ring.map(([Longitude, Latitude]) => ({ Longitude, Latitude })),
                },
              },
            ],
          },
        },
      },
    },
  };
}
const COVER = [
  [-123, 37],
  [-122, 37],
  [-122, 38],
  [-123, 38],
];
const SLIVER = [
  [-122.7, 37.5],
  [-122.5, 37.5],
  [-122.5, 37.7],
  [-122.7, 37.7],
];

test('box validation: size cap, dateline, poles, degenerate', () => {
  assert.equal(validateBox(BOX).ok, true);
  assert.equal(
    validateBox({ west: 170, south: 0, east: -170, north: 5 }).reason,
    'dateline',
  );
  assert.equal(validateBox({ west: 0, south: 86, east: 1, north: 87 }).reason, 'polar');
  assert.equal(
    validateBox({ west: 1, south: 2, east: 1, north: 3 }).reason,
    'degenerate',
  );
  assert.equal(validateBox({ west: 'x', south: 0, east: 1, north: 1 }).reason, 'invalid');
  assert.equal(validateBox(null).reason, 'invalid');
  assert.equal(
    validateBox({ west: 190, south: 0, east: 191, north: 1 }).reason,
    'invalid',
  );
  // 10 degrees of latitude is ~1113 km: over the 1000 km cap.
  const big = validateBox({ west: 0, south: 0, east: 1, north: 10 });
  assert.equal(big.reason, 'too-large');
  assert.match(big.message, /1113 km wide, limit 1000 km/);
  // The same longitude span is narrower near the pole: 12 degrees at 60N is ~668 km.
  assert.equal(validateBox({ west: 0, south: 60, east: 12, north: 61 }).ok, true);
  // south/north are put in order; west/east are not (that is the dateline test).
  assert.deepEqual(validateBox({ west: 1, south: 3, east: 2, north: 2 }).box, {
    west: 1,
    south: 2,
    east: 2,
    north: 3,
  });
});

test('pin boxes are ~10 km on the ground and SDK bboxes convert', () => {
  const b = boxFromPin(-122.4, 37.8);
  const { width, height } = boxSideKm(b);
  assert.ok(Math.abs(width - 10) < 0.01 && Math.abs(height - 10) < 0.01);
  assert.equal(boxFromPin(NaN, 0), null);
  assert.deepEqual(boxFromBBox({ lamin: 1, lomin: 2, lamax: 3, lomax: 4 }), {
    west: 2,
    south: 1,
    east: 4,
    north: 3,
  });
});

test('the catalogue window is whole UTC days, so a repeat query is the same URL', () => {
  const a = catalogWindow(NOW);
  const b = catalogWindow(NOW + 3 * 3600_000);
  assert.deepEqual(a, b);
  assert.deepEqual(a, {
    startIso: '2026-09-09T00:00:00Z',
    endIso: '2026-10-08T23:59:59Z',
  });
  assert.throws(() => catalogWindow('nope'));
});

test('CMR query params for one product', () => {
  const p = cmrQuery({ product: 'S30', box: BOX, ...catalogWindow(NOW) });
  assert.deepEqual(p, {
    collection_concept_id: 'C2021957295-LPCLOUD',
    bounding_box: '-122.6,37.6,-122.3,37.9',
    temporal: '2026-09-09T00:00:00Z,2026-10-08T23:59:59Z',
    sort_key: '-start_date',
    page_size: '200',
  });
  assert.equal(cmrQuery({ product: 'L30', box: BOX, pageSize: 9999 }).page_size, '2000');
  assert.throws(() => cmrQuery({ product: 'VIIRS', box: BOX }), /No CMR collection/);
  assert.throws(() => cmrQuery({ product: 'S30', box: { ...BOX, north: 60 } }));
});

test('parses CMR umm_json granules, dropping ones without a start', () => {
  const json = {
    hits: 3,
    items: [
      granule('G1', '2026-10-07T18:40:00Z', 12, COVER),
      { umm: {}, meta: { 'concept-id': 'G2' } },
      {
        meta: { 'concept-id': 'G3' },
        umm: {
          TemporalExtent: {
            RangeDateTime: { BeginningDateTime: '2026-10-06T18:00:00Z' },
          },
          SpatialExtent: {
            HorizontalSpatialDomain: {
              Geometry: {
                BoundingRectangles: [
                  {
                    WestBoundingCoordinate: -123,
                    SouthBoundingCoordinate: 37,
                    EastBoundingCoordinate: -122,
                    NorthBoundingCoordinate: 38,
                  },
                ],
              },
            },
          },
        },
      },
    ],
  };
  const { granules, hits } = parseCmrUmm(json, 'S30');
  assert.equal(hits, 3);
  assert.equal(granules.length, 2);
  assert.deepEqual(granules[0], {
    id: 'G1',
    product: 'S30',
    timeStart: '2026-10-07T18:40:00Z',
    timeEnd: '2026-10-07T18:40:00Z',
    cloud: 12,
    footprint: COVER,
  });
  assert.equal(granules[1].cloud, null);
  assert.equal(granules[1].footprint.length, 4);
  assert.deepEqual(parseCmrUmm(null, 'S30'), { granules: [], hits: 0 });
});

test('pages follow CMR-Search-After until a short page, and stop on a repeated cursor', async () => {
  const page = (ids, hits) => ({
    hits,
    items: ids.map((id) => granule(id, '2026-10-01T00:00:00Z', 5, COVER)),
  });
  const calls = [];
  const pages = [
    { json: page(['a', 'b'], 3), cursor: 'c1' },
    { json: page(['c'], 3), cursor: 'c2' },
  ];
  const r = await fetchCmrPages({
    product: 'S30',
    params: { page_size: '2' },
    fetchPage: async (_p, cursor) => {
      calls.push(cursor);
      return pages.shift();
    },
  });
  assert.deepEqual(calls, [null, 'c1']);
  assert.deepEqual(
    r.granules.map((g) => g.id),
    ['a', 'b', 'c'],
  );
  assert.equal(r.truncated, false);

  // A transport that cannot see the header (cursor null) reads one page, truncated.
  const one = await fetchCmrPages({
    product: 'S30',
    params: { page_size: '2' },
    fetchPage: async () => ({ json: page(['a', 'b'], 40), cursor: null }),
  });
  assert.equal(one.granules.length, 2);
  assert.equal(one.truncated, true);

  // A cache answering the same page again (same cursor) cannot loop forever.
  let n = 0;
  const loop = await fetchCmrPages({
    product: 'S30',
    params: { page_size: '2' },
    fetchPage: async () => {
      n += 1;
      return { json: page(['a', 'b'], 40), cursor: 'same' };
    },
  });
  assert.equal(n, 2);
  assert.equal(loop.granules.length, 2); // duplicates dropped
});

test('the proxy fetcher sends the cursor header and reads the next one', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return {
      ok: true,
      json: async () => ({ hits: 0, items: [] }),
      headers: { get: (h) => (h === 'CMR-Search-After' ? 'next' : null) },
    };
  };
  const fetchPage = createCmrFetcher({ buildUrl, fetchImpl });
  const r = await fetchPage({ page_size: '2' }, 'cur');
  assert.equal(r.cursor, 'next');
  assert.equal(seen[0].url, 'https://proxy.test/feed/cmr/granules.umm_json?page_size=2');
  assert.equal(seen[0].init.headers['cmr-search-after'], 'cur');
  const failing = createCmrFetcher({
    buildUrl,
    fetchImpl: async () => ({ ok: false, status: 502 }),
  });
  await assert.rejects(failing({}, null), /502/);
});

test('groups granules into one candidate per product and UTC day, with cloud and coverage', () => {
  const { granules } = parseCmrUmm(
    {
      items: [
        granule('a', '2026-10-07T18:40:00Z', 12, COVER),
        granule('b', '2026-10-07T18:41:00Z', 30, COVER),
        granule('c', '2026-10-05T18:40:00Z', 3, SLIVER),
      ],
    },
    'S30',
  );
  const days = groupGranulesByDay(granules);
  assert.deepEqual(
    days.map((c) => c.key),
    ['S30:2026-10-07', 'S30:2026-10-05'],
  );
  assert.deepEqual(days[0].cloud, { min: 12, max: 30 });
  assert.equal(days[0].timeRange.start, '2026-10-07T18:40:00.000Z');
  assert.equal(coverageFor(days[0], BOX), 'full');
  assert.equal(coverageFor(days[1], BOX), 'partial');
  assert.equal(coverageFor({ granules: [] }, BOX), 'unknown');
});

test('VIIRS gives one full-coverage candidate per day, today first', () => {
  const v = viirsCandidates('2026-10-08T23:59:59Z', 3);
  assert.deepEqual(
    v.map((c) => c.key),
    ['VIIRS:2026-10-08', 'VIIRS:2026-10-07', 'VIIRS:2026-10-06'],
  );
  assert.equal(v[0].coverage, 'full');
  assert.deepEqual(viirsCandidates('garbage'), []);
});

test('searchImagery folds both HLS products with VIIRS; one failing product is an error entry', async () => {
  const fetchPage = async (params) => {
    if (params.collection_concept_id === 'C2021957657-LPCLOUD') throw new Error('boom');
    return {
      json: {
        hits: 2,
        items: [
          granule('s1', '2026-10-07T18:40:00Z', 50, COVER),
          granule('s2', '2026-10-04T18:40:00Z', 5, COVER),
        ],
      },
      cursor: null,
    };
  };
  const r = await searchImagery({ box: BOX, fetchPage, now: NOW, days: 5 });
  assert.deepEqual(r.errors, [{ product: 'L30', message: 'boom' }]);
  assert.equal(r.truncated, false);
  assert.deepEqual(
    r.candidates.map((c) => c.key),
    [
      'VIIRS:2026-10-08',
      'S30:2026-10-07',
      'VIIRS:2026-10-07',
      'VIIRS:2026-10-06',
      'VIIRS:2026-10-05',
      'S30:2026-10-04',
      'VIIRS:2026-10-04',
    ],
  );
  assert.equal(r.candidates[1].coverage, 'full');
  // The newest clear, covering day wins over a newer cloudy one.
  const start = rankLatest(r.candidates);
  assert.equal(start.candidate.key, 'S30:2026-10-04');
  assert.equal(start.reason, 'clear');
  await assert.rejects(
    searchImagery({ box: { ...BOX, north: 80 }, fetchPage }),
    TypeError,
  );
});

test('rankLatest falls back to cloudy, partial, then the VIIRS overview', () => {
  const g = (cloud, ring) => ({ cloud, footprint: ring });
  const mk = (key, granules, coverage) => ({
    key,
    product: key.split(':')[0],
    day: key.split(':')[1],
    granules,
    availability: granules.length ? 'present' : 'unknown',
    coverage,
  });
  assert.equal(
    rankLatest([mk('S30:2026-10-07', [g(80, COVER)], 'full')]).reason,
    'cloudy',
  );
  assert.equal(
    rankLatest([mk('S30:2026-10-07', [g(1, SLIVER)], 'partial')]).reason,
    'partial',
  );
  const overview = rankLatest(viirsCandidates('2026-10-08', 2), { truncated: true });
  assert.equal(overview.reason, 'overview');
  assert.equal(overview.certain, false);
  assert.deepEqual(rankLatest([]), { candidate: null, reason: null, certain: true });
});

test('candidate readout and key parsing', () => {
  const [c] = groupGranulesByDay(
    parseCmrUmm(
      {
        items: [
          granule('a', '2026-10-05T18:40:00Z', 12, COVER),
          granule('b', '2026-10-05T18:52:00Z', 20, COVER),
        ],
      },
      'L30',
    ).granules,
  );
  assert.equal(
    formatCandidate(c, NOW),
    'Oct 5, 2026 18:40-18:52Z · 3 days ago · Landsat 8/9 via HLS · 30 m · 12-20% cloud',
  );
  assert.match(
    formatCandidate(viirsCandidates(NOW, 1)[0], NOW),
    /today · VIIRS NOAA-21 · 250 m · overview · cloud unknown$/,
  );
  assert.equal(formatCandidate({ product: 'X', day: '2026-01-01' }), '');
  assert.deepEqual(parseCandidateKey('S30:2026-10-05'), {
    product: 'S30',
    day: '2026-10-05',
  });
  assert.equal(parseCandidateKey('S30:2026-02-30'), null);
});

test('GIBS tile template and raster spec go through the proxy and keep the placeholders', () => {
  assert.equal(
    gibsTileTemplate(buildUrl, 'S30', '2026-10-05'),
    'https://proxy.test/feed/gibs/HLS_S30_Nadir_BRDF_Adjusted_Reflectance/default/2026-10-05/GoogleMapsCompatible_Level12/{z}/{y}/{x}.png',
  );
  assert.match(
    gibsTileTemplate(buildUrl, 'VIIRS', '2026-10-05'),
    /VIIRS_NOAA21_CorrectedReflectance_TrueColor\/default\/2026-10-05\/GoogleMapsCompatible_Level9\/\{z\}\/\{y\}\/\{x\}\.jpg$/,
  );
  assert.throws(() => gibsTileTemplate(buildUrl, 'S30', '2026-13-01'));
  const spec = imageryRasterSpec({
    buildUrl,
    product: 'L30',
    day: '2026-10-05',
    box: BOX,
  });
  assert.equal(spec.kind, 'xyz');
  assert.deepEqual(spec.rectangle, [-122.6, 37.6, -122.3, 37.9]);
  assert.equal(spec.maximumLevel, 12);
  assert.ok(spec.credit);
  // Same day, another box: a different key, so the raster engine reloads.
  const other = imageryRasterSpec({
    buildUrl,
    product: 'L30',
    day: '2026-10-05',
    box: { ...BOX, west: -122.7 },
  });
  assert.equal(other.url, spec.url);
  assert.notEqual(other.key, spec.key);
  assert.throws(() =>
    imageryRasterSpec({
      buildUrl,
      product: 'L30',
      day: '2026-10-05',
      box: { ...BOX, east: 170 },
    }),
  );
});

test('Worldview snapshot params put the BBOX in lat,lon order and clamp the size', () => {
  const p = wvsSnapshotParams({
    product: 'S30',
    day: '2026-10-05',
    box: BOX,
    width: 9999,
    height: 3,
  });
  assert.deepEqual(p, {
    REQUEST: 'GetSnapshot',
    LAYERS: 'HLS_S30_Nadir_BRDF_Adjusted_Reflectance',
    CRS: 'EPSG:4326',
    TIME: '2026-10-05',
    BBOX: '37.6,-122.6,37.9,-122.3',
    WIDTH: '2048',
    HEIGHT: '16',
    FORMAT: 'image/png',
  });
  assert.match(
    wvsSnapshotUrl(buildUrl, { product: 'VIIRS', day: '2026-10-05', box: BOX }),
    /^https:\/\/proxy\.test\/feed\/wvs\/snapshot\?REQUEST=GetSnapshot&LAYERS=VIIRS_/,
  );
  assert.deepEqual(snapshotSize({ west: 0, south: 0, east: 2, north: 1 }, 256), {
    width: 256,
    height: 128,
  });
});

test('the UI controller searches, selects and hands the raster engine its spec', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      hits: 1,
      items: [granule('s', '2026-10-07T18:40:00Z', 4, COVER)],
    }),
    headers: { get: () => null },
  });
  const cat = createImageryCatalogue({ buildUrl, fetchImpl, now: () => NOW });
  // The raster engine subscribes through the source itself and reloads on change.
  const changes = [];
  const off = cat.rasterSource.subscribe((sel) => changes.push(sel?.product ?? null));
  assert.equal((await cat.rasterSource()).kind, 'empty');
  const r = await cat.search(BOX, { days: 2 });
  assert.equal(r.start.candidate.key, 'S30:2026-10-07');
  cat.select(r.start.candidate);
  const spec = await cat.rasterSource();
  assert.equal(spec.kind, 'xyz');
  assert.match(spec.url, /HLS_S30_.*2026-10-07/);
  cat.select('VIIRS:2026-10-08');
  assert.match((await cat.rasterSource()).url, /VIIRS_/);
  assert.match(cat.thumbnailUrl(r.candidates[0]), /feed\/wvs\/snapshot\?/);
  assert.throws(() => cat.select('nope'));
  cat.clear();
  assert.equal(cat.selection, null);
  assert.equal((await cat.rasterSource()).kind, 'empty');
  assert.deepEqual(changes, ['S30', 'VIIRS', null]);
  off();
  cat.select('S30:2026-10-07');
  assert.equal(changes.length, 3);
});
