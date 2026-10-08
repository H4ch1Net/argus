// The DOT networks added from each provider's documentation (the 511
// platform, WSDOT, NYC DOT, Singapore LTA, the rest of Caltrans), keyed
// networks offered only with their key, and camera sub-kinds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMERA_SOURCES,
  KEYED_CAMERA_SOURCES,
  createTrafficCamSource,
  offeredSources,
  sourcesInView,
  parseCameraCatalog,
} from './sources.js';
import { parseTrafficCams, describeTrafficCam, trafficCamNote, trafficCamSearchText } from './format.js';
import { cameraKinds, kindsPass, KIND_IDS, kindLabel } from './kinds.js';
import { createSetFilter } from '../webcams/categories.js';

const src = (id) => CAMERA_SOURCES.find((s) => s.id === id);
const ids = (cams) => cams.map((c) => c.id);

test('the 511 platform, v2 shape (AZ511): an enabled view on the network host', () => {
  const row = (id, over = {}) => ({
    Id: id,
    Source: 'ADOT',
    SourceId: `cam-${id}`,
    Roadway: 'I-10',
    Direction: 'Eastbound',
    Latitude: 33.45,
    Longitude: -112.07,
    Location: 'I-10 EB @ 7th St',
    SortOrder: 0,
    Views: [
      { Id: 1, Url: `https://az511.gov/map/Cctv/${id}`, Status: 'Enabled', Description: 'Looking East' },
    ],
    ...over,
  });
  const out = parseCameraCatalog(
    [
      row(101),
      row(102, { Views: [{ Url: 'https://evil.example/map/Cctv/102', Status: 'Enabled' }] }),
      row(103, { Views: [{ Url: 'https://az511.gov/map/Cctv/103', Status: 'Disabled' }] }),
      row(104, { Latitude: 47.6, Longitude: -122.3 }), // Seattle: outside Arizona
      row(105, {
        Location: 'SR-87 Beeline Hwy near Sunflower',
        Views: [{ Url: 'https://cdn.traveliq.co/map/Cctv/105--1', Status: 'Enabled', Description: 'NB' }],
      }),
      row(101), // duplicate
    ],
    src('az511'),
  );
  assert.deepEqual(ids(out), ['az511-101', 'az511-105']);
  assert.equal(out[0].name, 'I-10 EB @ 7th St - Looking East');
  assert.deepEqual(out[0].image, { feedId: 'az511-img', path: '/101' });
  assert.equal(out[0].pose.heading, 90);
  assert.equal(out[0].provider, 'AZ511');
  assert.match(out[0].license, /developer API terms with your own key/);
  // A TravelIQ partner host is normalized onto the network's own still feed.
  assert.deepEqual(out[1].image, { feedId: 'az511-img', path: '/105--1' });
});

test('the 511 platform, 511NY v1 shape: one Url per camera, disabled and blocked skipped', () => {
  const row = (id, over = {}) => ({
    ID: id,
    Name: `I-87 at Exit ${id}`,
    DirectionOfTravel: 'Northbound',
    RoadwayName: 'I-87 - Adirondack Northway',
    Url: `https://511ny.org/map/Cctv/${id}`,
    VideoUrl: null,
    Disabled: false,
    Blocked: false,
    Latitude: 42.75,
    Longitude: -73.8,
    ...over,
  });
  const out = parseCameraCatalog(
    [
      row('NYSDOT_1'),
      row('NYSDOT_2', { Disabled: true }),
      row('NYSDOT_3', { Blocked: true }),
      row('NYSDOT_4', { Url: 'https://s9.nysdot.skyvdn.com/rtplive/R1_001/playlist.m3u8' }),
      row('NYSDOT_5', { Url: 'https://www.511ny.org/map/Cctv/NYSDOT_5' }),
      row('NYSDOT_6', { Name: 'Tappan Zee Bridge (Cuomo Bridge) toll plaza' }),
    ],
    src('ny511'),
  );
  assert.deepEqual(ids(out), ['ny511-nysdot_1', 'ny511-nysdot_5', 'ny511-nysdot_6']);
  assert.deepEqual(out[0].image, { feedId: 'ny511-img', path: '/NYSDOT_1' });
  assert.equal(out[0].pose.heading, 0);
  assert.deepEqual(out[2].kinds, ['bridge']);
});

test('WSDOT: active cameras with a still on images.wsdot.wa.gov; partner credit', () => {
  const cam = (id, over = {}) => ({
    CameraID: id,
    CameraLocation: {
      Description: null,
      Direction: 'N',
      Latitude: 47.6,
      Longitude: -122.33,
      MilePost: 165,
      RoadName: 'I-5',
    },
    CameraOwner: null,
    Description: null,
    ImageURL: `https://images.wsdot.wa.gov/nw/005vc${id}.jpg`,
    IsActive: true,
    Title: `I-5 at MP ${id}: Seneca St`,
    ...over,
  });
  const out = parseCameraCatalog(
    [
      cam(16500),
      cam(16501, { IsActive: false }),
      cam(16502, { ImageURL: 'https://images.drivebc.ca/bchighwaycam/pub/cameras/2.jpg' }),
      cam(16503, { ImageURL: 'https://images.wsdot.wa.gov/nw/005vc16503.jpg?x=1' }),
      cam(16504, {
        CameraOwner: 'City of Bellevue',
        Title: 'Snoqualmie Pass Summit',
        ImageURL: 'https://images.wsdot.wa.gov/sc/090VC05200.jpg',
      }),
      cam(16505, { Title: 'SR 543 Blaine Truck Crossing border' }),
    ],
    src('wsdot'),
  );
  assert.deepEqual(ids(out), ['wsdot-16500', 'wsdot-16504', 'wsdot-16505']);
  assert.deepEqual(out[0].image, { feedId: 'wsdot-img', path: '/nw/005vc16500.jpg' });
  assert.equal(out[0].pose.heading, 0);
  assert.equal(out[1].credit, 'Image courtesy of City of Bellevue');
  assert.deepEqual(out[1].kinds, ['pass']);
  assert.deepEqual(out[2].kinds, ['border']);
});

test('NYC DOT: online cameras, the still pinned to /api/cameras/<id>/image', () => {
  const id = '053e8995-f8cb-4d02-a659-70ac7c7da5db';
  const cam = (cid, over = {}) => ({
    id: cid,
    name: '1 Ave @ 110 St',
    latitude: 40.79,
    longitude: -73.94,
    area: 'Manhattan',
    isOnline: 'true',
    imageUrl: `https://webcams.nyctmc.org/api/cameras/${cid}/image`,
    ...over,
  });
  const out = parseCameraCatalog(
    [
      cam(id),
      cam('1d2e3f40-0000-0000-0000-000000000001', { isOnline: 'false' }),
      cam('1d2e3f40-0000-0000-0000-000000000002', {
        imageUrl: 'https://webcams.nyctmc.org/api/cameras/other/image',
      }),
      cam('1d2e3f40-0000-0000-0000-000000000003', { imageUrl: undefined }),
      cam('not a uuid'),
      cam('1d2e3f40-0000-0000-0000-000000000004', { latitude: 42.65, longitude: -73.75 }),
      cam('1d2e3f40-0000-0000-0000-000000000005', { name: 'Brooklyn Bridge @ Park Row' }),
    ],
    src('nycdot'),
  );
  assert.deepEqual(ids(out), [
    `nycdot-${id}`,
    'nycdot-1d2e3f40-0000-0000-0000-000000000003',
    'nycdot-1d2e3f40-0000-0000-0000-000000000005',
  ]);
  assert.deepEqual(out[0].image, { feedId: 'nycdot-img', path: `/${id}/image` });
  assert.equal(out[0].region, 'Manhattan');
  assert.deepEqual(out[2].kinds, ['bridge']);
});

test('Singapore LTA: data.gov.sg traffic images, stills pinned to images.data.gov.sg', () => {
  const cam = (id, over = {}) => ({
    timestamp: '2026-10-08T17:20:44+08:00',
    image: `https://images.data.gov.sg/api/traffic-images/2026/10/2e0a3d2a-71b1-4d8e-a3a6-${id}.jpg`,
    location: { latitude: 1.29531332, longitude: 103.871146 },
    camera_id: id,
    image_metadata: { height: 240, width: 320, md5: 'x' },
    ...over,
  });
  const out = parseCameraCatalog(
    {
      items: [
        {
          timestamp: '2026-10-08T17:20:44+08:00',
          cameras: [
            cam('1001'),
            cam('1002', { image: 'https://evil.example/a.jpg' }),
            cam('1003', { location: { latitude: 51.5, longitude: -0.1 } }),
            cam('x'),
          ],
        },
      ],
      api_info: { status: 'healthy' },
    },
    src('lta-sg'),
  );
  assert.deepEqual(ids(out), ['lta-sg-1001']);
  assert.deepEqual(out[0].image, {
    feedId: 'lta-sg-img',
    path: '/2026/10/2e0a3d2a-71b1-4d8e-a3a6-1001.jpg',
  });
});

test('camera kinds: conservative rules, several at once, none for plain roads', () => {
  assert.deepEqual(cameraKinds('I-80 at Donner Summit'), ['pass']);
  assert.deepEqual(cameraKinds('Bay Bridge on-ramp'), ['ramp', 'bridge']);
  assert.deepEqual(cameraKinds('Caldecott Tunnel west portal'), ['tunnel']);
  assert.deepEqual(cameraKinds('SR-905 at Otay Mesa Port of Entry'), ['border']);
  assert.deepEqual(cameraKinds('US-59 @ Laredo International Bridge 1'), ['bridge', 'border']);
  assert.deepEqual(cameraKinds('I-5 SB', 'BC border crossings'), ['border']);
  assert.deepEqual(cameraKinds('I-35 / US-290 Interchange'), ['ramp']);
  // Street names are not structures; "Poe" is a street, "POE" a port of entry.
  assert.deepEqual(cameraKinds('Bridge St @ Main St'), []);
  assert.deepEqual(cameraKinds('Pass Rd at 5th Ave'), []);
  assert.deepEqual(cameraKinds('Poe Ave at Bypass'), []);
  assert.deepEqual(cameraKinds('SR-11 POE'), ['border']);
  assert.deepEqual(cameraKinds('Overpass at Elm'), []);
  assert.deepEqual(cameraKinds(null, undefined, ''), []);
  assert.equal(KIND_IDS.length, 6);
  assert.equal(kindLabel('pass'), 'Mountain pass');

  // DriveBC's own border region tags its cameras.
  const [bc] = parseCameraCatalog(
    [
      {
        id: 9,
        is_on: true,
        should_appear: true,
        region_name: 'Border Cams',
        location: { coordinates: [-122.75, 49.0] },
      },
    ],
    src('drivebc'),
  );
  assert.deepEqual(bc.kinds, ['border']);
});

test('the kind filter: a plain camera counts as "road"; the card and search show kinds', () => {
  const f = createSetFilter(KIND_IDS);
  assert.ok(kindsPass([], f));
  f.set(['border', 'pass']);
  assert.equal(kindsPass([], f), false);
  assert.ok(kindsPass(['bridge', 'border'], f));
  assert.equal(kindsPass(['tunnel'], f), false);
  f.set(['road']);
  assert.ok(kindsPass([], f));

  const cameras = [
    { id: 'a', name: 'Donner Summit', lat: 39.3, lon: -120.3, provider: 'Caltrans', region: 'Sierra', license: 'x', kinds: ['pass'] },
    { id: 'b', name: 'Main St', lat: 39.3, lon: -120.3, provider: 'Caltrans', region: 'Sierra', license: 'x', kinds: [] },
  ];
  f.set(['pass']);
  assert.equal(trafficCamNote({ cameras, inView: 1 }, f), '1 hidden by filter');
  const [pass] = parseTrafficCams({ cameras });
  const card = describeTrafficCam(pass);
  assert.equal(card.rows.find(([k]) => k === 'Covers')[1], 'Mountain pass');
  assert.match(trafficCamSearchText(pass), /Mountain pass/);
});

test('keyed networks are offered only when the proxy has their key', async () => {
  assert.deepEqual(
    KEYED_CAMERA_SOURCES.map((s) => s.feedId).sort(),
    ['ak511', 'az511', 'ctroads', 'ga511', 'id511', 'la511', 'nvroads', 'ny511', 'udot', 'wi511', 'wsdot'],
  );
  for (const s of KEYED_CAMERA_SOURCES) assert.match(s.env, /^[A-Z0-9_]+$/);
  assert.equal(offeredSources(CAMERA_SOURCES).some((s) => s.keyed), false);

  const asked = [];
  const proxyClient = {
    getJson: async (feedId, path, { params } = {}) => {
      asked.push(`${feedId}${path}?${new URLSearchParams(params ?? {})}`);
      return [];
    },
    buildUrl: (feedId, path) => `https://proxy.test/feed/${feedId}${path}`,
  };
  const phoenix = { lamin: 33.3, lamax: 33.6, lomin: -112.3, lomax: -111.9 };
  await createTrafficCamSource({ proxyClient })({ bbox: phoenix });
  assert.deepEqual(asked, [], 'no keyless network covers Phoenix; AZ511 needs its key');
  await createTrafficCamSource({
    proxyClient,
    isConfigured: (id) => id === 'az511',
  })({ bbox: phoenix });
  assert.deepEqual(asked, ['az511/cameras?format=json']);
});

test('a filter change re-draws from a one-minute memo, never a second request', async () => {
  let calls = 0;
  let t = 0;
  const source = createTrafficCamSource({
    proxyClient: {
      getJson: async () => {
        calls += 1;
        return [];
      },
      buildUrl: () => '',
    },
    now: () => t,
  });
  const london = { lamin: 51.4, lamax: 51.6, lomin: -0.3, lomax: 0.1 };
  await source({ bbox: london });
  await source({ bbox: london });
  assert.equal(calls, 1);
  t += 61_000;
  await source({ bbox: london });
  assert.equal(calls, 2);
  await source({ bbox: { ...london, lamax: 51.61 } });
  assert.equal(calls, 3);
});

test('every Caltrans district is covered; Orange County fetches district 12', () => {
  const districts = CAMERA_SOURCES.filter((s) => s.kind === 'caltrans').map((s) =>
    Number(s.id.slice('caltrans-d'.length)),
  );
  assert.deepEqual(
    districts.sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  );
  const irvine = { lamin: 33.62, lamax: 33.72, lomin: -117.85, lomax: -117.72 };
  assert.ok(sourcesInView(irvine).sources.some((s) => s.id === 'caltrans-d12'));
  assert.equal(src('caltrans-d12').path, '/d12/cctv/cctvStatusD12.json');
  assert.equal(src('caltrans-d1').path, '/d1/cctv/cctvStatusD01.json');
});
