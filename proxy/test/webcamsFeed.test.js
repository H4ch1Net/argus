// proxy/feeds/webcams.js: public webcams, more DOT camera networks and border
// wait times. Every feed path- and query-pinned and named; keys injected server
// side only (a client can neither see one nor bring its own); stills on
// image-only feeds; and the paths core's parsers produce are exactly what the
// pins allow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { feeds as webcamFeeds, FIVE11_NETWORKS } from '../feeds/webcams.js';
import { validateFeeds, loadConfig } from '../lib/config.js';
import { buildUpstreamUrl } from '../lib/relay.js';
import { createRequestHandler } from '../lib/app.js';
import {
  windyQuery,
  snapBBox,
  NPS_QUERY,
  createWebcamSource,
} from '../../core/layers/webcams/sources.js';
import {
  parseWindy,
  parseNps,
  parseEpic,
  parseObservatories,
} from '../../core/layers/webcams/parse.js';
import { OBSERVATORY_CAMERAS } from '../../core/layers/webcams/data/observatories.js';
import {
  CAMERA_SOURCES,
  KEYED_CAMERA_SOURCES,
  parseCameraCatalog,
} from '../../core/layers/trafficcams/sources.js';
import { CBP_PATH, CBSA_PATH } from '../../core/layers/borderwaits/source.js';

const feed = (id) => webcamFeeds.find((f) => f.id === id);
const isImageFeed = (f) => /-(img|imgproxy)$/.test(f.id);

/** Would the relay forward this sub-path (with its query) on this feed? */
function allowed(id, subpath, search = '') {
  const f = feed(id);
  assert.ok(f, `feed ${id} exists`);
  let target;
  try {
    target = buildUpstreamUrl(f, subpath, search);
  } catch {
    return false;
  }
  const pathOk = (f.allowPaths || []).some((re) => re.test(target.pathname));
  return pathOk && (!f.allowQuery || f.allowQuery(target.searchParams));
}
const qs = (params) => (params ? `?${new URLSearchParams(params)}` : '');

const KEYED = {
  windy: { secret: 'WINDY_WEBCAMS_KEY', as: 'header', name: 'x-windy-api-key' },
  'nps-webcams': { secret: 'NPS_API_KEY', as: 'header', name: 'X-Api-Key' },
  wsdot: { secret: 'WSDOT_ACCESS_CODE', as: 'query', name: 'AccessCode' },
};

test('the feeds validate, are registered, pinned, named and governed', async () => {
  const { feeds } = await import('../feeds.js');
  assert.equal(validateFeeds(feeds), feeds);
  for (const f of webcamFeeds)
    assert.ok(
      feeds.some((g) => g.id === f.id),
      `${f.id} is in the registry`,
    );
  for (const f of webcamFeeds) {
    assert.ok(f.allowPaths?.length, `${f.id} has a path allowlist`);
    assert.equal(typeof f.allowQuery, 'function', `${f.id} pins its query`);
    assert.match(f.headers['user-agent'], /^Argus\/.+github\.com/);
    assert.ok(f.governor?.ratePerMinute > 0, `${f.id} is rate-governed`);
    assert.deepEqual(f.methods, ['GET']);
    assert.match(f.baseUrl, /^https:\/\//, `${f.id} is https`);
    assert.equal(f.auth, undefined);
  }
  // Every upstream is marked as untested, in the file itself.
  const src = fs.readFileSync(new URL('../feeds/webcams.js', import.meta.url), 'utf8');
  const marks = src.match(
    /\/\/ Per the provider's documentation, not live-tested here\./g,
  );
  const objects = src.match(/^ {4}id(?::|,$)/gm);
  assert.equal(marks?.length, objects.length, 'one marker per feed definition');
});

test('stills: image-only, keyless; catalogues: cached', () => {
  const images = webcamFeeds.filter(isImageFeed);
  assert.equal(images.length, 19);
  for (const f of images) {
    assert.equal(f.imageOnly, true, `${f.id} is image-only`);
    assert.equal(f.inject, undefined, `${f.id} carries no key`);
  }
  for (const f of webcamFeeds.filter((x) => !isImageFeed(x)))
    assert.ok(f.cache?.ttlMs > 0, `${f.id} is cached`);
  // Windy's still links expire after about 10 minutes: its list is cached less.
  assert.ok(feed('windy').cache.ttlMs + feed('windy').cache.staleMs <= 12 * 60_000);
});

test('keys: exactly these feeds, injected server side, required', () => {
  const keyed = webcamFeeds.filter((f) => f.inject?.length);
  const expected = {
    ...KEYED,
    ...Object.fromEntries(
      FIVE11_NETWORKS.map((n) => [n.id, { secret: n.secret, as: 'query', name: 'key' }]),
    ),
  };
  assert.deepEqual(keyed.map((f) => f.id).sort(), Object.keys(expected).sort());
  for (const f of keyed) assert.deepEqual(f.inject, [expected[f.id]], f.id);
  // core's keyed networks name the same feed and env var as the proxy injects.
  for (const s of KEYED_CAMERA_SOURCES) {
    const f = feed(s.feedId);
    assert.ok(f, `${s.feedId} has a feed`);
    assert.equal(f.inject[0].secret, s.env, `${s.id} env var`);
  }
});

test('Windy: the documented query only, a bbox or a circle, never a key', () => {
  const box = snapBBox({ lamin: 45.9, lamax: 46.1, lomin: 7.6, lomax: 7.9 });
  const q = windyQuery(box, 50);
  assert.ok(allowed('windy', '/webcams', qs(q)));
  assert.ok(
    allowed(
      'windy',
      '/webcams',
      qs({ nearby: '46.02,7.75,25', limit: 50, offset: 0, include: 'images,location' }),
    ),
  );
  assert.equal(allowed('windy', '/webcams', qs({ ...q, key: 'mine' })), false);
  assert.equal(allowed('windy', '/webcams', qs({ ...q, nearby: '1,1,5' })), false);
  assert.equal(allowed('windy', '/webcams', qs({ ...q, limit: 51 })), false);
  assert.equal(allowed('windy', '/webcams', qs({ ...q, offset: 5000 })), false);
  assert.equal(
    allowed('windy', '/webcams', qs({ ...q, include: 'images,secrets' })),
    false,
  );
  assert.equal(allowed('windy', '/webcams', qs({ ...q, bbox: '60,40,10,-20' })), false);
  assert.equal(allowed('windy', '/webcams', qs({ ...q, bbox: '46,8,47,7' })), false);
  const noInclude = { ...q };
  delete noInclude.include;
  assert.equal(allowed('windy', '/webcams', qs(noInclude)), false);
  assert.equal(allowed('windy', '/webcams/1234', qs(q)), false);
  assert.equal(allowed('windy', '/categories', qs(q)), false);
});

test("Windy, NPS, EPIC and observatory stills: core's paths pass, nothing else", () => {
  const windy = parseWindy({
    webcams: [
      {
        webcamId: 1,
        status: 'active',
        location: { latitude: 46, longitude: 7 },
        images: {
          current: {
            preview: 'https://images-webcams.windy.com/35/1/current/preview/1.jpg',
          },
        },
      },
      {
        webcamId: 2,
        status: 'active',
        location: { latitude: 46, longitude: 7 },
        images: {
          current: {
            preview:
              'https://imgproxy.windy.com/_/preview/plain/current/2/original.jpg?token=abc.DEF-1',
          },
        },
      },
    ],
  });
  const nps = parseNps({
    data: [
      {
        id: 'A1B2',
        status: 'Active',
        latitude: 44.46,
        longitude: -110.83,
        images: [{ url: 'https://www.nps.gov/common/uploads/cropped_image/x/AB-12.jpg' }],
      },
    ],
  });
  const epic = parseEpic([
    { image: 'epic_1b_20261007003633', centroid_coordinates: { lat: 6, lon: 168 } },
  ]);
  const obs = parseObservatories(OBSERVATORY_CAMERAS);
  const stills = [...windy, ...nps, ...epic, ...obs].flatMap((c) =>
    [c.image, c.fullImage].filter(Boolean),
  );
  assert.equal(stills.length, 2 + 1 + 2 + OBSERVATORY_CAMERAS.length);
  for (const img of stills)
    assert.ok(allowed(img.feedId, img.path, qs(img.params)), `${img.feedId}${img.path}`);

  assert.equal(allowed('windy-img', '/35/1/current/preview/1.html'), false);
  assert.equal(allowed('windy-img', '/a.jpg', '?a=1&b=2&c=3&d=4&e=5'), false);
  assert.equal(allowed('windy-imgproxy', '/a.jpg', '?t=%3Cscript%3E'), false);
  assert.equal(
    allowed('nps-img', '/common/uploads/cropped_image/x/AB-12.jpg', '?width=10'),
    false,
  );
  assert.equal(allowed('nps-img', '/common/uploads/../../api/v1/webcams.jpg'), false);
  assert.equal(allowed('nps-img', '/media/webcam/view.htm'), false);
  assert.equal(
    allowed('epic-img', '/archive/natural/2026/10/07/png/epic_1b_20261007003633.png'),
    false,
    'the multi-megabyte PNG stays out',
  );
  assert.equal(allowed('epic-img', '/api/natural'), false);
  assert.equal(
    allowed('sdo-img', '/assets/img/latest/latest_1024_0193.jpg', '?x=1'),
    false,
  );
  assert.equal(allowed('soho-img', '/data/realtime/c3/1024/../../index.html'), false);
});

test('every client path resolves to the provider URL it stands for', () => {
  const upstream = (id, path, params) =>
    buildUpstreamUrl(feed(id), path, qs(params)).href;
  // Catalogues.
  assert.equal(
    upstream('windy', '/webcams'),
    'https://api.windy.com/webcams/api/v3/webcams',
  );
  assert.equal(
    upstream('nps-webcams', '/webcams'),
    'https://developer.nps.gov/api/v1/webcams',
  );
  assert.equal(upstream('epic', '/natural'), 'https://epic.gsfc.nasa.gov/api/natural');
  assert.equal(upstream('cbp-bwt', CBP_PATH), 'https://bwt.cbp.gov/api/bwtnew');
  assert.equal(
    upstream('cbsa-bwt', CBSA_PATH),
    'https://www.cbsa-asfc.gc.ca/bwt-taf/bwt-eng.csv',
  );
  const src = (id) => CAMERA_SOURCES.find((s) => s.id === id);
  const cat = (id) => upstream(src(id).feedId, src(id).path, src(id).params);
  assert.equal(cat('ny511'), 'https://511ny.org/api/getcameras?format=json');
  assert.equal(cat('az511'), 'https://az511.gov/api/v2/get/cameras?format=json');
  assert.equal(cat('nvroads'), 'https://www.nvroads.com/api/v2/get/cameras?format=json');
  assert.equal(
    cat('wsdot'),
    'https://www.wsdot.wa.gov/Traffic/api/HighwayCameras/HighwayCamerasREST.svc/GetCamerasAsJson',
  );
  assert.equal(cat('nycdot'), 'https://webcams.nyctmc.org/api/cameras');
  assert.equal(cat('lta-sg'), 'https://api.data.gov.sg/v1/transport/traffic-images');
  // Stills: each parsed still points back at exactly the URL it was published at.
  const published = [
    [
      parseWindy({
        webcams: [
          {
            webcamId: 2,
            location: { latitude: 46, longitude: 7 },
            images: {
              current: {
                preview:
                  'https://imgproxy.windy.com/_/preview/plain/current/2/original.jpg?token=abc',
              },
            },
          },
        ],
      })[0].image,
      'https://imgproxy.windy.com/_/preview/plain/current/2/original.jpg?token=abc',
    ],
    [
      parseNps({
        data: [
          {
            id: 'A1',
            latitude: 44,
            longitude: -110,
            images: [
              { url: 'https://www.nps.gov/common/uploads/structured_data/AB-1.jpg' },
            ],
          },
        ],
      })[0].image,
      'https://www.nps.gov/common/uploads/structured_data/AB-1.jpg',
    ],
    [
      parseEpic([
        { image: 'epic_1b_20261007003633', centroid_coordinates: { lat: 6, lon: 168 } },
      ])[0].image,
      'https://epic.gsfc.nasa.gov/archive/natural/2026/10/07/thumbs/epic_1b_20261007003633.jpg',
    ],
    [
      parseObservatories(OBSERVATORY_CAMERAS)[0].image,
      'https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_0193.jpg',
    ],
    [
      parseObservatories(OBSERVATORY_CAMERAS)[2].image,
      'https://soho.nascom.nasa.gov/data/realtime/c3/1024/latest.jpg',
    ],
    [
      parseCameraCatalog(
        [
          {
            Id: 7,
            Latitude: 33.45,
            Longitude: -112.07,
            Views: [{ Url: 'https://az511.gov/map/Cctv/7', Status: 'Enabled' }],
          },
        ],
        src('az511'),
      )[0].image,
      'https://az511.gov/map/Cctv/7',
    ],
    [
      parseCameraCatalog(
        [
          {
            id: '053e8995-f8cb-4d02-a659-70ac7c7da5db',
            latitude: 40.79,
            longitude: -73.94,
          },
        ],
        src('nycdot'),
      )[0].image,
      'https://webcams.nyctmc.org/api/cameras/053e8995-f8cb-4d02-a659-70ac7c7da5db/image',
    ],
    [
      parseCameraCatalog(
        {
          items: [
            {
              cameras: [
                {
                  camera_id: '1001',
                  image:
                    'https://images.data.gov.sg/api/traffic-images/2026/10/2e0a3d2a-71b1.jpg',
                  location: { latitude: 1.3, longitude: 103.87 },
                },
              ],
            },
          ],
        },
        src('lta-sg'),
      )[0].image,
      'https://images.data.gov.sg/api/traffic-images/2026/10/2e0a3d2a-71b1.jpg',
    ],
    [
      parseCameraCatalog(
        [
          {
            CameraID: 9,
            CameraLocation: { Latitude: 47.6, Longitude: -122.3 },
            ImageURL: 'https://images.wsdot.wa.gov/nw/005vc00009.jpg',
          },
        ],
        src('wsdot'),
      )[0].image,
      'https://images.wsdot.wa.gov/nw/005vc00009.jpg',
    ],
  ];
  for (const [img, url] of published)
    assert.equal(upstream(img.feedId, img.path, img.params), url);
});

test('catalogues reach their one document: NPS, EPIC, CBP, CBSA', () => {
  assert.ok(allowed('nps-webcams', '/webcams', qs(NPS_QUERY)));
  assert.ok(allowed('nps-webcams', '/webcams', qs({ ...NPS_QUERY, parkCode: 'yell' })));
  assert.equal(
    allowed('nps-webcams', '/webcams', qs({ ...NPS_QUERY, api_key: 'x' })),
    false,
  );
  assert.equal(allowed('nps-webcams', '/parks', qs(NPS_QUERY)), false);
  assert.equal(allowed('nps-webcams', '/webcams', qs({ limit: 5000, start: 0 })), false);
  assert.ok(allowed('epic', '/natural'));
  assert.equal(allowed('epic', '/natural/all'), false);
  assert.equal(allowed('epic', '/natural', '?api_key=x'), false);
  assert.ok(allowed('cbp-bwt', CBP_PATH));
  assert.equal(allowed('cbp-bwt', '/bwtnew', '?x=1'), false);
  assert.equal(allowed('cbp-bwt', '/admin'), false);
  assert.ok(allowed('cbsa-bwt', CBSA_PATH));
  assert.ok(allowed('cbsa-bwt', '/bwt-fra.csv'));
  assert.equal(allowed('cbsa-bwt', '/menu-eng.html'), false);
});

test("traffic camera networks: core's catalogue requests and stills pass the pins", () => {
  for (const s of CAMERA_SOURCES.filter((x) => x.feedId && feed(x.feedId))) {
    assert.ok(allowed(s.feedId, s.path, qs(s.params)), `${s.id}: ${s.feedId}${s.path}`);
    // A client-supplied key is refused: the proxy's own key is the only one.
    assert.equal(
      allowed(s.feedId, s.path, qs({ ...s.params, key: 'mine', AccessCode: 'mine' })),
      false,
      `${s.id} refuses a client key`,
    );
  }
  for (const n of FIVE11_NETWORKS) {
    const f = feed(n.id);
    assert.equal(new URL(f.baseUrl).origin, n.origin);
    assert.ok(allowed(`${n.id}-img`, '/12345--1'));
    assert.equal(allowed(`${n.id}-img`, '/12345', '?key=x'), false);
    assert.equal(allowed(`${n.id}-img`, '/../../api/v2/get/cameras'), false);
    assert.equal(allowed(n.id, '/events', '?format=json'), false);
  }
  const src = (id) => CAMERA_SOURCES.find((s) => s.id === id);
  const stills = [
    ...parseCameraCatalog(
      [
        {
          Id: 7,
          Latitude: 33.45,
          Longitude: -112.07,
          Views: [{ Url: 'https://az511.gov/map/Cctv/7', Status: 'Enabled' }],
        },
      ],
      src('az511'),
    ),
    ...parseCameraCatalog(
      [
        {
          ID: 'NYSDOT_1',
          Latitude: 42.7,
          Longitude: -73.8,
          Url: 'https://511ny.org/map/Cctv/NYSDOT_1',
        },
      ],
      src('ny511'),
    ),
    ...parseCameraCatalog(
      [
        {
          CameraID: 9,
          CameraLocation: { Latitude: 47.6, Longitude: -122.3 },
          ImageURL: 'https://images.wsdot.wa.gov/nw/005vc00009.jpg',
          IsActive: true,
        },
      ],
      src('wsdot'),
    ),
    ...parseCameraCatalog(
      [
        {
          id: '053e8995-f8cb-4d02-a659-70ac7c7da5db',
          latitude: 40.79,
          longitude: -73.94,
        },
      ],
      src('nycdot'),
    ),
    ...parseCameraCatalog(
      {
        items: [
          {
            cameras: [
              {
                camera_id: '1001',
                image:
                  'https://images.data.gov.sg/api/traffic-images/2026/10/2e0a3d2a-71b1.jpg',
                location: { latitude: 1.3, longitude: 103.87 },
              },
            ],
          },
        ],
      },
      src('lta-sg'),
    ),
  ].map((c) => c.image);
  assert.equal(stills.length, 5);
  for (const img of stills)
    assert.ok(allowed(img.feedId, img.path), `${img.feedId}${img.path}`);
  assert.equal(allowed('nycdot-img', '/../cameras'), false);
  assert.equal(allowed('nycdot', '/cameras/x/image'), false);
  assert.equal(allowed('lta-sg-img', '/2026/10/x.png'), false);
  assert.equal(allowed('wsdot-img', '/nw/a.jpg', '?AccessCode=x'), false);
});

test('through the relay: keys added server side, client keys refused, stills images only', async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (req.url.startsWith('/35/')) {
      const html = req.url.includes('html');
      res.writeHead(200, { 'content-type': html ? 'text/html' : 'image/jpeg' });
      res.end(html ? '<script>alert(1)</script>' : 'JPEG');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"webcams":[]}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const local = ['windy', 'windy-img', 'nps-webcams', 'ny511', 'wsdot'].map((id) => {
    const f = feed(id);
    return { ...f, baseUrl: origin + new URL(f.baseUrl).pathname };
  });
  const envKeys = {
    WINDY_WEBCAMS_KEY: 'test-windy',
    NPS_API_KEY: 'test-nps',
    NY511_KEY: 'test-511',
  };
  Object.assign(process.env, envKeys);
  delete process.env.WSDOT_ACCESS_CODE;
  const proxy = http.createServer(
    createRequestHandler({ config: loadConfig({}), feeds: local }),
  );
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  t.after(() => {
    for (const k of Object.keys(envKeys)) delete process.env[k];
    proxy.close();
    upstream.close();
  });
  const base = `http://127.0.0.1:${proxy.address().port}`;
  const get = (p) => fetch(`${base}${p}`, { headers: { accept: 'application/json' } });

  const q = windyQuery(snapBBox({ lamin: 45.9, lamax: 46.1, lomin: 7.6, lomax: 7.9 }));
  const r1 = await get(`/feed/windy/webcams${qs(q)}`);
  assert.equal(r1.status, 200);
  assert.equal(seen.at(-1).headers['x-windy-api-key'], 'test-windy');
  assert.equal(new URL(seen.at(-1).url, origin).searchParams.get('bbox'), q.bbox);
  assert.equal((await r1.text()).includes('test-windy'), false);

  assert.equal((await get('/feed/nps-webcams/webcams?limit=500&start=0')).status, 200);
  assert.equal(seen.at(-1).headers['x-api-key'], 'test-nps');

  assert.equal((await get('/feed/ny511/getcameras?format=json')).status, 200);
  assert.equal(new URL(seen.at(-1).url, origin).searchParams.get('key'), 'test-511');

  const before = seen.length;
  assert.equal((await get('/feed/ny511/getcameras?format=json&key=mine')).status, 403);
  assert.equal((await get(`/feed/windy/webcams${qs({ ...q, key: 'x' })}`)).status, 403);
  // No access code on this proxy: the feed is not configured, nothing goes out.
  const r2 = await get('/feed/wsdot/GetCamerasAsJson');
  assert.equal(r2.status, 502);
  assert.match((await r2.json()).error, /WSDOT_ACCESS_CODE/);
  assert.equal(seen.length, before, 'refused requests never reached the upstream');

  assert.equal((await get('/feed/windy-img/35/1/current/preview/1.jpg')).status, 200);
  assert.equal(seen.at(-1).headers['x-windy-api-key'], undefined, 'no key on stills');
  assert.equal((await get('/feed/windy-img/35/1/current/preview/1.html')).status, 403);

  // /health says which keyed feeds can serve.
  const health = await (await get('/health')).json();
  const conf = Object.fromEntries(health.feeds.map((f) => [f.id, f.configured]));
  assert.equal(conf.windy, true);
  assert.equal(conf.wsdot, false);
  assert.equal(conf['windy-img'], true);
});

test('a still that answers with HTML is refused (image-only feed)', async (t) => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html></html>');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const f = feed('epic-img');
  const proxy = http.createServer(
    createRequestHandler({
      config: loadConfig({}),
      feeds: [{ ...f, baseUrl: origin + new URL(f.baseUrl).pathname }],
    }),
  );
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  t.after(() => {
    proxy.close();
    upstream.close();
  });
  const res = await fetch(
    `http://127.0.0.1:${proxy.address().port}/feed/epic-img/archive/natural/2026/10/07/thumbs/epic_1b_20261007003633.jpg`,
  );
  assert.equal(res.status, 502);
});

test("the webcam source's requests are what the proxy allows", async () => {
  const asked = [];
  const source = createWebcamSource({
    proxyClient: {
      getJson: async (feedId, path, { params } = {}) => {
        asked.push([feedId, path, params]);
        return feedId === 'epic' ? [] : { total: 0, webcams: [], data: [] };
      },
      buildUrl: () => '',
    },
    isConfigured: () => true,
  });
  await source({ bbox: { lamin: 45.9, lamax: 46.1, lomin: 7.6, lomax: 7.9 } });
  assert.deepEqual(asked.map(([id]) => id).sort(), ['epic', 'nps-webcams', 'windy']);
  for (const [id, path, params] of asked) assert.ok(allowed(id, path, qs(params)), id);
});
