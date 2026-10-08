import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMERA_SOURCES,
  sourcesInView,
  parseCameraCatalog,
  createTrafficCamSource,
} from './sources.js';
import { parseTrafficCams, describeTrafficCam, trafficCamNote } from './format.js';

const src = (id) => CAMERA_SOURCES.find((s) => s.id === id);

test('Caltrans: in-service cameras on the official host only', () => {
  const row = (over = {}) => ({
    cctv: {
      inService: 'true',
      location: {
        locationName: 'TV102 -- I-580 : Grand Ave',
        nearbyPlace: 'Oakland',
        latitude: '37.81',
        longitude: '-122.25',
        direction: 'West',
      },
      imageData: {
        static: {
          currentImageURL:
            'https://cwwp2.dot.ca.gov/data/d4/cctv/image/tv102i580grand/tv102i580grand.jpg',
        },
      },
      ...over,
    },
  });
  const out = parseCameraCatalog(
    {
      data: [
        row(),
        row({ inService: 'false' }),
        row({ imageData: { static: { currentImageURL: 'https://evil.example/x.jpg' } } }),
        row({ location: { latitude: 'x', longitude: '1' } }),
      ],
    },
    src('caltrans-d4'),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'caltrans-d4-tv102');
  assert.equal(out[0].name, 'I-580 : Grand Ave (Oakland)');
  assert.deepEqual(out[0].image, {
    feedId: 'caltrans-img',
    path: '/d4/cctv/image/tv102i580grand/tv102i580grand.jpg',
  });
  assert.equal(out[0].provider, 'Caltrans');
});

test('TfL: available JamCams with an image on the official bucket', () => {
  const cam = (id, available, imageUrl) => ({
    id: `JamCams_${id}`,
    commonName: `Cam ${id}`,
    lat: 51.5,
    lon: -0.12,
    additionalProperties: [
      { key: 'available', value: available },
      { key: 'imageUrl', value: imageUrl },
    ],
  });
  const ok = 'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00001.06514.jpg';
  const out = parseCameraCatalog(
    [
      cam('00001.06514', 'true', ok),
      cam('2', 'false', ok),
      cam('3', 'true', 'https://x.example/a.jpg'),
    ],
    src('tfl'),
  );
  assert.deepEqual(
    out.map((c) => c.id),
    ['tfl-00001.06514'],
  );
  assert.deepEqual(out[0].image, { feedId: 'tfl-img', path: '/00001.06514.jpg' });
});

test('Vegvesen: still URL must match the camera id on the official host', () => {
  const f = (id, still, extra = {}) => ({
    geometry: { coordinates: [10.75, 59.91] },
    properties: {
      cameraId: id,
      description: 'Oslo',
      roadNumber: 'E18',
      stillImageUrl: still,
      ...extra,
    },
  });
  const out = parseCameraCatalog(
    {
      features: [
        f('3000123_1', 'https://kamera.atlas.vegvesen.no/api/images/3000123_1', {
          orientationDescription: 'Drammen',
        }),
        f('3000124_1', 'https://kamera.atlas.vegvesen.no/api/images/other'),
        f('bad id!', 'https://kamera.atlas.vegvesen.no/api/images/bad id!'),
        f('3000125_1', 'https://kamera.atlas.vegvesen.no/api/images/3000125_1', {
          'status.stillImageAvailability': 'noImages',
        }),
      ],
    },
    src('vegvesen'),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'E18 Oslo → Drammen');
  assert.deepEqual(out[0].image, { feedId: 'vegvesen-img', path: '/3000123_1' });
});

test('only catalogues in view are fetched; stills resolve to proxy URLs', async () => {
  const asked = [];
  const proxyClient = {
    getJson: async (feedId, path) => {
      asked.push(`${feedId}${path}`);
      return [];
    },
    buildUrl: (feedId, path) => `https://proxy.test/feed/${feedId}${path}`,
  };
  const london = { lamin: 51.4, lamax: 51.6, lomin: -0.3, lomax: 0.1 };
  const r = await createTrafficCamSource({ proxyClient })({ bbox: london });
  assert.deepEqual(asked, ['tfl/Place/Type/JamCam']);
  assert.equal(trafficCamNote(r), '');
  assert.deepEqual(sourcesInView({ lamin: 0, lamax: 40, lomin: 0, lomax: 1 }), {
    sources: [],
    tooWide: true,
  });

  const withCam = createTrafficCamSource({
    proxyClient: { ...proxyClient, getJson: async () => [] },
    sources: [{ ...src('tfl') }],
  });
  const empty = await withCam({ bbox: { lamin: 10, lamax: 11, lomin: 10, lomax: 11 } });
  assert.equal(trafficCamNote(empty), 'no camera network in view');
});

test('the card shows the still through the proxy and is honest about it', () => {
  const [n] = parseTrafficCams({
    cameras: [
      {
        id: 'tfl-1',
        name: 'Cam 1',
        lat: 51.5,
        lon: -0.1,
        provider: 'Transport for London',
        region: 'London',
        license: 'Powered by TfL Open Data',
        imageUrl: 'https://proxy.test/feed/tfl-img/1.jpg',
      },
    ],
  });
  const card = describeTrafficCam(n);
  assert.equal(card.image.url, 'https://proxy.test/feed/tfl-img/1.jpg');
  assert.equal(card.subtitle, 'Transport for London · London');
  assert.ok(card.rows.some(([k, v]) => k === 'Note' && /nothing here analyses/.test(v)));
});
