import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAPILLARY_FIELDS,
  mapillaryQuery,
  mapillaryThumbPath,
  mapillaryTiles,
  nearestImage,
  parseMapillaryImages,
  proxiedThumb,
  streetPhotoToNormalized,
  tileAt,
  viewSmallEnough,
} from './parse.js';
import { capturedText, compassText, describeStreetPhoto } from './format.js';
import {
  createStreetPhotoSource,
  createStreetPhotoTiles,
  findNearestStreetPhoto,
} from './source.js';
import { createStreetPhotoMockSource, createStreetPhotoMockTiles } from './mockSource.js';

// Mapillary API v4 /images, the documented response shape (not live-tested:
// no token in the build environment). Thumbnail URLs as the API returns them,
// signed links on Meta's image CDN.
const SAMPLE = {
  data: [
    {
      id: '1234567890123456',
      captured_at: 1717250700000,
      compass_angle: 132.4,
      geometry: { type: 'Point', coordinates: [-122.41941, 37.77493] },
      thumb_256_url:
        'https://scontent-sjc3-1.xx.fbcdn.net/m1/v/t6/An9xAbCdEfGh_ij-KL01?stp=s256x192&ccb=10-5&oh=00_Aa1&oe=6713A2F0&_nc_sid=201bca',
      thumb_1024_url:
        'https://scontent-sjc3-1.xx.fbcdn.net/m1/v/t6/An9xAbCdEfGh_ij-KL02?stp=s1024x768&ccb=10-5&oh=00_Ab2&oe=6713A2F0&_nc_sid=201bca',
      is_pano: false,
    },
    {
      id: '2222222222222222',
      captured_at: 1600000000000,
      compass_angle: -30,
      geometry: { type: 'Point', coordinates: [-122.4185, 37.7752] },
      thumb_256_url: 'https://evil.example/x.jpg',
      is_pano: true,
    },
    { id: 'abc', geometry: { type: 'Point', coordinates: [0, 0] } }, // not a Mapillary id
    { id: '33', geometry: { type: 'LineString', coordinates: [] } },
    { id: '44' },
  ],
};

const buildUrl = (feed, path, params) => {
  const u = new URL(`https://proxy.test/feed/${feed}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) u.searchParams.set(k, v);
  return u.toString();
};

test('parses the documented /images shape, skipping junk', () => {
  const imgs = parseMapillaryImages(SAMPLE);
  assert.equal(imgs.length, 2);
  const [a, b] = imgs;
  assert.equal(a.id, '1234567890123456');
  assert.deepEqual([a.lon, a.lat], [-122.41941, 37.77493]);
  assert.equal(a.compass, 132.4);
  assert.equal(a.capturedAt, 1717250700000);
  assert.equal(b.compass, 330);
  assert.equal(b.pano, true);
  assert.equal(b.thumb1024, null);
  assert.deepEqual(parseMapillaryImages(null), []);
});

test('tiles: zoomed in only, snapped, nearest first', () => {
  const view = { lamin: 37.766, lomin: -122.432, lamax: 37.786, lomax: -122.412 };
  assert.ok(viewSmallEnough(view));
  const tiles = mapillaryTiles(view);
  assert.ok(tiles.length >= 4 && tiles.length <= 6);
  const mid = tileAt(37.776, -122.422);
  assert.equal(tiles[0].key, mid.key);
  assert.ok(Math.abs(mid.lamax - mid.lamin - 0.01) < 1e-9);
  assert.deepEqual(
    mapillaryTiles({ lamin: 37, lomin: -123, lamax: 38, lomax: -122 }),
    [],
  );
  const q = mapillaryQuery(mid);
  assert.equal(q.fields, MAPILLARY_FIELDS);
  assert.equal(q.bbox, `${mid.lomin},${mid.lamin},${mid.lomax},${mid.lamax}`);
});

test('thumbnails go through the image-only proxy feed, never straight to a CDN', () => {
  const p = mapillaryThumbPath(SAMPLE.data[0].thumb_1024_url);
  assert.equal(p.path, '/m1/v/t6/An9xAbCdEfGh_ij-KL02');
  assert.equal(p.params.oh, '00_Ab2');
  const url = proxiedThumb(buildUrl, SAMPLE.data[0].thumb_1024_url);
  assert.match(url, /^https:\/\/proxy\.test\/feed\/mapillary-img\/m1\/v\/t6\//);
  assert.doesNotMatch(url, /fbcdn/);
  assert.equal(proxiedThumb(buildUrl, 'https://evil.example/x.jpg'), null);
  assert.equal(proxiedThumb(buildUrl, null), null);
});

test('the card: photo, capture time, facing, licence and a link, no person', () => {
  const [img] = parseMapillaryImages(SAMPLE);
  const n = streetPhotoToNormalized({
    ...img,
    image: 'https://proxy.test/feed/mapillary-img/x',
  });
  assert.equal(n.id, 'mly-1234567890123456');
  assert.equal(n.type, 'streetphoto');
  const card = describeStreetPhoto(n, { distanceM: 42.4 });
  assert.equal(card.title, 'STREET PHOTO');
  const rows = Object.fromEntries(card.rows);
  assert.equal(rows.Captured, '2024-06-01 14:05 UTC');
  assert.equal(rows.Facing, '132° SE');
  assert.equal(rows['From target'], '42 m');
  assert.match(rows.Licence, /CC BY-SA 4\.0/);
  assert.equal(card.image.url, 'https://proxy.test/feed/mapillary-img/x');
  assert.equal(
    card.links[0].url,
    'https://www.mapillary.com/app/?pKey=1234567890123456&focus=photo',
  );
  assert.doesNotMatch(JSON.stringify(card), /creator|username/i);
  assert.equal(compassText(null), 'unknown');
  assert.equal(compassText(359.6), '000° N');
  assert.equal(capturedText(undefined), 'unknown');
});

test('nearest image within a radius', () => {
  const imgs = parseMapillaryImages(SAMPLE);
  const best = nearestImage(imgs, 37.7749, -122.4194);
  assert.equal(best.image.id, '1234567890123456');
  assert.ok(best.distanceM < 5);
  assert.equal(nearestImage(imgs, 37.8, -122.5, 400), null);
});

test('the source fetches each tile once through the pinned feed', async () => {
  const calls = [];
  const proxyClient = {
    buildUrl,
    async getJson(feed, path, { params }) {
      calls.push([feed, path, params.bbox]);
      return params.bbox === mapillaryQuery(tileAt(37.775, -122.419)).bbox
        ? SAMPLE
        : { data: [] };
    },
  };
  const tiles = createStreetPhotoTiles({ proxyClient });
  const source = createStreetPhotoSource({ proxyClient, tiles });
  const view = {
    bbox: { lamin: 37.772, lomin: -122.422, lamax: 37.778, lomax: -122.416 },
  };
  const a = await source(view);
  assert.equal(a.tooWide, false);
  assert.equal(a.images.length, 2);
  assert.match(a.images[0].image, /feed\/mapillary-img\//);
  const n = calls.length;
  await source(view);
  assert.equal(calls.length, n, 'cached');
  assert.ok(calls.every(([feed, path]) => feed === 'mapillary' && path === '/images'));
  const wide = await source({ bbox: { lamin: 37, lomin: -123, lamax: 38, lomax: -122 } });
  assert.deepEqual(wide, { images: [], tooWide: true });

  const near = await findNearestStreetPhoto(tiles, 37.7749, -122.4194);
  assert.equal(near.image.id, '1234567890123456');
});

test('the demo stand-in: deterministic sequences labelled DEMO', async () => {
  const src = createStreetPhotoMockSource();
  const view = { bbox: { lamin: 51.5, lomin: -0.13, lamax: 51.51, lomax: -0.12 } };
  const a = await src(view);
  const b = await src(view);
  assert.ok(a.images.length >= 30);
  assert.deepEqual(a.images, b.images);
  const card = describeStreetPhoto(streetPhotoToNormalized(a.images[0]));
  assert.equal(card.title, 'STREET PHOTO (DEMO)');
  assert.equal(card.image, null);
  const near = await findNearestStreetPhoto(
    createStreetPhotoMockTiles(),
    51.505,
    -0.125,
    {
      maxM: 2000,
    },
  );
  assert.ok(near);
});
