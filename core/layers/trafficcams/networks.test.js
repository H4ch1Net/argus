// The networks ported from gods-eye-view: one small fixture per catalogue,
// shaped like the payloads the reference's own tests use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMERA_SOURCES,
  sourcesInView,
  createTrafficCamSource,
  capCameras,
  rankingAnchors,
} from './sources.js';
import {
  parseCameraCatalog,
  parseTarkteeLocations,
  parseTarkteeImages,
  driveBcImageCredit,
  fintrafficCameraName,
  TXDOT_DISTRICTS,
} from './parse.js';
import {
  parseTrafficCams,
  describeTrafficCam,
  decodeBase64Jpeg,
  jpegFromSnapshotJson,
} from './format.js';
import { TALLINN_CAMERAS } from './data/tallinn.js';
import { WARENDORF_CAMERAS } from './data/warendorf.js';
import { fallbackHeading } from './pose.js';

const src = (id) => CAMERA_SOURCES.find((s) => s.id === id);
const ids = (cams) => cams.map((c) => c.id);

test('Ontario 511: an enabled, not-down view on the official still host', () => {
  const row = (id, over = {}) => ({
    Id: id,
    Latitude: 43.65,
    Longitude: -79.38,
    Location: 'Hwy 401 near Yonge St',
    Roadway: 'Highway 401',
    Direction: 'Eastbound',
    Views: [
      { Url: 'https://511on.ca/map/Cctv/100', Status: 'Enabled', Description: 'Down' },
      {
        Url: 'https://511on.ca/map/Cctv/101',
        Status: 'Enabled',
        Description: 'Looking East',
      },
    ],
    ...over,
  });
  const out = parseCameraCatalog(
    [
      row('1'),
      row('2', {
        Views: [{ Url: 'https://evil.example/map/Cctv/9', Status: 'Enabled' }],
      }),
      row('3', { Views: [{ Url: 'https://511on.ca/map/Cctv/9', Status: 'Disabled' }] }),
      row('4', { Latitude: 0, Longitude: 0 }),
      row('5', {
        Direction: '',
        Views: [
          {
            Url: 'https://x.traveliq.co/map/Cctv/7',
            Status: 'enabled',
            Description: 'NB',
          },
        ],
      }),
      row('1'), // duplicate id
    ],
    src('on511'),
  );
  assert.deepEqual(ids(out), ['on511-1', 'on511-5']);
  assert.equal(out[0].name, 'Hwy 401 near Yonge St - Looking East');
  assert.deepEqual(out[0].image, { feedId: 'on511-img', path: '/101' });
  assert.equal(out[0].pose.heading, 90);
  assert.equal(out[0].pose.headingSource, 'feed');
  // A partner host is normalized onto 511on.ca; the view text gives the heading.
  assert.deepEqual(out[1].image, { feedId: 'on511-img', path: '/7' });
  assert.equal(out[1].pose.heading, 0);
  assert.equal(out[0].license, 'Ontario 511, Open Government Licence - Ontario');
});

test('DriveBC: switched-on, published cameras; orientation; partner credits only', () => {
  const row = (id, over = {}) => ({
    id,
    name: `Camera ${id}`,
    is_on: true,
    should_appear: true,
    region_name: 'Lower Mainland',
    orientation: 'NE',
    elevation: 12,
    location: { type: 'Point', coordinates: [-123.1, 49.28] },
    credit: '',
    ...over,
  });
  const out = parseCameraCatalog(
    [
      row(5, { credit: '<p>Images courtesy of <b>TransLink</b></p>' }),
      row(6, { is_on: false }),
      row(7, { should_appear: false }),
      row('8'),
      row(9, { location: { coordinates: [-0.1, 51.5] } }),
      row(10, {
        orientation: null,
        region_name: 'Border Cams',
        credit: 'This camera relies on solar power',
        elevation: 99999,
      }),
    ],
    src('drivebc'),
  );
  assert.deepEqual(ids(out), ['drivebc-5', 'drivebc-10']);
  assert.deepEqual(out[0].image, { feedId: 'drivebc-img', path: '/5.jpg' });
  assert.equal(out[0].credit, 'Images courtesy of TransLink');
  assert.equal(out[0].pose.heading, 45);
  assert.equal(out[0].pose.groundM, 12);
  assert.equal(out[0].region, 'Lower Mainland');
  assert.equal(out[1].credit, null);
  assert.equal(out[1].region, 'BC border crossings');
  assert.equal(out[1].pose.headingSource, 'hash');
  assert.equal(out[1].pose.groundM, 4000);
  assert.equal(
    driveBcImageCredit('City of Surrey &amp; partners'),
    'City of Surrey & partners',
  );
});

test('Calgary: http upgraded and pinned; the address quadrant is never a heading', () => {
  const row = (over = {}) => ({
    camera_url: {
      url: 'http://trafficcam.calgary.ca/loc142.jpg',
      description: 'Camera 143',
    },
    quadrant: 'SW',
    camera_location: 'Bow Trail / 37 Street SW',
    point: { type: 'Point', coordinates: [-114.1413616, 51.0453097] },
    ...over,
  });
  const out = parseCameraCatalog(
    [
      row(),
      row(), // the same frame twice
      row({ camera_url: { url: 'https://evil.example/loc1.jpg' } }),
      row({ camera_url: { url: 'https://trafficcam.calgary.ca.evil.test/loc2.jpg' } }),
      row({ camera_url: { url: 'https://trafficcam.calgary.ca/a/b.jpg' } }),
      row({ camera_url: { url: 'ftp://trafficcam.calgary.ca/loc3.jpg' } }),
      row({ point: { coordinates: [-79.38, 43.65] } }),
      row({ camera_url: { url: 'https://trafficcam.calgary.ca/deerfoot_16av.jpg' } }),
    ],
    src('calgary'),
  );
  assert.deepEqual(ids(out), ['calgary-142', 'calgary-deerfoot_16av']);
  assert.deepEqual(out[0].image, { feedId: 'calgary-img', path: '/loc142.jpg' });
  assert.equal(out[0].name, 'Bow Trail / 37 Street SW');
  assert.equal(out[0].pose.headingSource, 'hash');
  assert.equal(out[0].pose.heading, fallbackHeading('calgary-142'));
  assert.equal(out[0].pose.groundM, 1045);
  assert.match(out[0].license, /Open Government Licence - City of Calgary/);
});

test('Fintraffic: gathering stations, in-collection presets, one camera per preset', () => {
  const station = (id, over = {}) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [24.94, 60.17, over.alt ?? 0] },
    properties: {
      id,
      name: 'vt3_Hyvinkää_Noppo',
      collectionStatus: over.status ?? 'GATHERING',
      presets: over.presets ?? [
        { id: `${id}01`, inCollection: true },
        { id: `${id}02`, inCollection: false },
        { id: `${id}03x`, inCollection: true },
        { id: 'C9999901', inCollection: true },
      ],
    },
  });
  const out = parseCameraCatalog(
    {
      features: [
        station('C01503'),
        station('C01504', { status: 'REMOVED_TEMPORARILY' }),
        station('C01505', {
          alt: 140,
          presets: [{ id: 'C0150501', inCollection: true }],
        }),
      ],
    },
    src('fintraffic'),
  );
  assert.deepEqual(ids(out), ['fi-c0150301', 'fi-c0150501']);
  assert.deepEqual(out[0].image, { feedId: 'fintraffic-img', path: '/C0150301.jpg' });
  assert.equal(out[0].name, 'vt3 Hyvinkää Noppo (view 01)');
  assert.equal(out[0].pose.groundM, 90); // 0 means "not reported"
  assert.equal(out[1].pose.groundM, 140);
  assert.equal(out[0].pose.headingSource, 'hash');
  assert.equal(out[0].license, 'Fintraffic / digitraffic.fi, CC BY 4.0');
  assert.equal(
    fintrafficCameraName('', 'C01503', 'C0150302'),
    'Fintraffic C01503 (view 02)',
  );
});

test('TxDOT: online devices only, strict travel-token headings, a JSON still', () => {
  const row = (over = {}) => ({
    icd_Id: 'FM-734 @ US-290 EB',
    name: 'FM-734 @ US-290 EB',
    latitude: 30.34396,
    longitude: -97.57988,
    statusDescription: 'Device Online',
    hasSnapshot: true,
    dirDescription: 'North',
    ...over,
  });
  const payload = {
    roadwayCctvStatuses: {
      'FM-734': [
        row(),
        row({ icd_Id: 'b', statusDescription: 'Device Offline' }),
        row({ icd_Id: 'c', latitude: null }),
        row({ icd_Id: 'd', latitude: '30.1', longitude: '-97.7' }),
        row({ icd_Id: 'e', latitude: 0, longitude: 0 }),
        row({ icd_Id: 'f', hasSnapshot: false }),
        row({ icd_Id: 'N LAMAR @ W 6TH', name: 'N Lamar @ W 6th' }),
      ],
      'US-290': [row()], // an interchange camera listed under both roadways
    },
  };
  const out = parseCameraCatalog(payload, src('txdot-aus'));
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'txdot-aus-Rk0tNzM0IEAgVVMtMjkwIEVC');
  assert.deepEqual(out[0].image, {
    feedId: 'txdot-img',
    path: '/GetCctvSnapshotByIcdId',
    params: { icdId: 'FM-734 @ US-290 EB', districtCode: 'AUS' },
    format: 'json-base64-jpeg',
  });
  assert.equal(out[0].pose.heading, 90);
  assert.equal(out[0].pose.heightM, 12);
  assert.equal(out[0].pose.groundM, 149);
  // "N Lamar @ W 6th" is two street names, not a facing.
  assert.equal(out[1].pose.headingSource, 'hash');
  assert.equal(out[1].pose.heightM, 10);
  assert.equal(TXDOT_DISTRICTS.length, 25);
  assert.deepEqual(parseCameraCatalog(payload, { ...src('txdot-aus'), params: {} }), []);
});

test('Austin: Socrata rows, TURNED_ON only, headings from dedicated fields first', () => {
  const columns = [
    ':sid',
    ':id',
    'camera_id',
    'location_name',
    'camera_status',
    'location',
    'direction',
  ].map((fieldName) => ({ fieldName }));
  const payload = {
    meta: { view: { columns } },
    data: [
      [1, 'row-a', '42', '5TH ST / WEST AVE', 'TURNED_ON', 'POINT (-97.75 30.27)', null],
      [2, 'row-b', '43', 'CONGRESS AVE / 6TH', 'DESIRED', 'POINT (-97.74 30.27)', null],
      [3, 'row-c', '44', 'LAMAR BLVD WB', 'TURNED_ON', 'POINT (-97.76 30.28)', 'South'],
      [4, 'row-d', 'x', 'NO ID', 'TURNED_ON', 'POINT (-97.76 30.28)', null],
      [5, 'row-e', '45', 'FAR AWAY', 'TURNED_ON', 'POINT (-95.36 29.76)', null],
      [6, 'row-f', '46', 'MOPAC NB', '', { latitude: '30.3', longitude: '-97.8' }, null],
      'not a row',
    ],
  };
  const out = parseCameraCatalog(payload, src('austin'));
  assert.deepEqual(ids(out), ['austin-42', 'austin-44', 'austin-46']);
  assert.deepEqual(out[0].image, { feedId: 'austin-img', path: '/42.jpg' });
  // "WEST AVE" is a street: no facing claimed.
  assert.equal(out[0].pose.headingSource, 'hash');
  // The dedicated direction field wins over the WB token in the name.
  assert.equal(out[1].pose.heading, 180);
  assert.equal(out[2].pose.heading, 0);
  assert.equal(out[2].lat, 30.3);
});

const LOCATIONS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0">
  <payloadPublication>
    <predefinedLocationContainer id="TRAFFIC_CAMERAS" version="0">
      <predefinedLocation id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" version="0">
        <predefinedLocationName>
          <values><value lang="et">Test Site &amp; Co</value></values>
        </predefinedLocationName>
        <location><pointByCoordinates><pointCoordinates>
          <latitude>59.4370</latitude><longitude>24.7530</longitude>
        </pointCoordinates></pointByCoordinates></location>
      </predefinedLocation>
      <predefinedLocation id="ffffffff-0000-1111-2222-333333333333" version="0">
        <predefinedLocationName><values><value lang="et">Far Away</value></values></predefinedLocationName>
        <location><pointByCoordinates><pointCoordinates>
          <latitude>48.85</latitude><longitude>2.35</longitude>
        </pointCoordinates></pointByCoordinates></location>
      </predefinedLocation>
    </predefinedLocationContainer>
  </payloadPublication>
</d2LogicalModel>`;

const IMAGES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0">
  <payloadPublication>
    <trafficView id="1">
      <linearTrafficView id="1">
        <linearPredefinedLocationReference targetClass="PredefinedLocation" id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" version="0"/>
        <trafficViewRecord id="1-1"><urlLink>
          <urlLinkAddress>https://tarktee.transpordiamet.ee/images/42/42_202608251542.jpg</urlLinkAddress>
        </urlLink></trafficViewRecord>
      </linearTrafficView>
    </trafficView>
    <trafficView id="2">
      <linearPredefinedLocationReference id="ffffffff-0000-1111-2222-333333333333"/>
      <urlLinkAddress>https://tarktee.transpordiamet.ee/images/43/43_1.jpg</urlLinkAddress>
    </trafficView>
  </payloadPublication>
</d2LogicalModel>`;

test('Tarktee: two DATEX II documents joined on the location id', () => {
  const locations = parseTarkteeLocations(LOCATIONS_XML);
  const images = parseTarkteeImages(IMAGES_XML);
  assert.equal(locations.size, 2);
  assert.equal(
    locations.get('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee').name,
    'Test Site & Co',
  );
  assert.equal(
    images.get('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
    '/42/42_202608251542.jpg',
  );
  const out = parseCameraCatalog(
    { locations: LOCATIONS_XML, images: IMAGES_XML },
    src('tarktee'),
  );
  // The Paris point is outside Estonia.
  assert.deepEqual(ids(out), ['ee-tarktee-42']);
  assert.deepEqual(out[0].image, {
    feedId: 'tarktee-img',
    path: '/42/42_202608251542.jpg',
  });
  assert.equal(out[0].lat, 59.437);
  assert.equal(out[0].pose.groundM, 40);
});

test('Tarktee: DOCTYPE/ENTITY documents and foreign image hosts are refused', () => {
  const doctype = LOCATIONS_XML.replace(
    '<d2LogicalModel',
    '<!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><d2LogicalModel',
  );
  assert.equal(parseTarkteeLocations(doctype).size, 0);
  assert.equal(
    parseTarkteeImages(IMAGES_XML.replace('<payload', '<!entity y "z"><payload')).size,
    0,
  );
  const foreign = IMAGES_XML.replace(
    'https://tarktee.transpordiamet.ee/images/42/42_202608251542.jpg',
    'https://evil.example/images/42/42.jpg',
  );
  assert.equal(
    parseTarkteeImages(foreign).has('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
    false,
  );
  const traversal = IMAGES_XML.replace(
    '/images/42/42_202608251542.jpg',
    '/images/42/../../api/x.jpg',
  );
  assert.equal(
    parseTarkteeImages(traversal).has('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
    false,
  );
  assert.equal(parseTarkteeLocations(null).size, 0);
  assert.deepEqual(parseCameraCatalog({}, src('tarktee')), []);
});

test('Tallinn and Warendorf: curated catalogues with curated poses', () => {
  const tallinn = parseCameraCatalog(TALLINN_CAMERAS, src('tallinn'));
  assert.equal(tallinn.length, 255);
  assert.equal(new Set(ids(tallinn)).size, 255);
  for (const c of tallinn) {
    assert.match(c.image.path, /^\/cam\d{3}\.jpg$/);
    assert.equal(c.image.feedId, 'tallinn-img');
    assert.equal(c.curated, true);
  }
  const byId = Object.fromEntries(tallinn.map((c) => [c.id, c]));
  assert.equal(byId['tallinn-104'].image.path, '/cam104.jpg');
  assert.equal(byId['tallinn-104'].pose.heading, 227.2);
  assert.equal(byId['tallinn-104'].pose.rangeM, 210);
  assert.equal(byId['tallinn-103'].pose.headingConfidence, 'low'); // a rough bearing
  assert.equal(tallinn.filter((c) => c.pose.headingSource === 'curated').length, 230);

  const [w] = parseCameraCatalog(WARENDORF_CAMERAS, src('warendorf'));
  assert.deepEqual(w.image, { feedId: 'warendorf-img', path: '/jpeg.cgi' });
  assert.deepEqual(
    [
      w.pose.heading,
      w.pose.pitch,
      w.pose.fovDeg,
      w.pose.rangeM,
      w.pose.heightM,
      w.pose.groundM,
    ],
    [221, 23, 84, 260, 14, 55],
  );
  assert.match(w.license, /OpenStreetMap contributors \(ODbL\)/);
});

test('a TxDOT still: canonical base64 decoding to a JPEG, nothing else', () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const b64 = Buffer.from(jpeg).toString('base64');
  assert.deepEqual(decodeBase64Jpeg(b64), jpeg);
  assert.deepEqual(decodeBase64Jpeg(`data:image/jpeg;base64,${b64}`), jpeg);
  assert.deepEqual(jpegFromSnapshotJson({ snippet: b64 }), jpeg);
  // Not a JPEG (a PNG header), not canonical, junk, too big, wrong types.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString(
    'base64',
  );
  assert.equal(decodeBase64Jpeg(png), null);
  assert.equal(decodeBase64Jpeg(`${b64.slice(0, -1)}`), null);
  assert.equal(decodeBase64Jpeg(`${b64}AAAA`.replace(/=/g, '') + '=='), null);
  assert.equal(decodeBase64Jpeg('<html>not found</html>'), null);
  assert.equal(decodeBase64Jpeg(b64, 4), null);
  assert.equal(decodeBase64Jpeg(null), null);
  assert.equal(jpegFromSnapshotJson({ error: 'x' }), null);
  assert.equal(jpegFromSnapshotJson('snippet'), null);
});

test('the card: licence and source rows, honest facing, a decodable TxDOT still', () => {
  const proxyClient = {
    buildUrl: (feedId, path, params) =>
      `https://proxy.test/feed/${feedId}${path}${params ? `?${new URLSearchParams(params)}` : ''}`,
  };
  const resolve = (cams) =>
    cams.map((c) => ({
      ...c,
      imageUrl: proxyClient.buildUrl(c.image.feedId, c.image.path, c.image.params),
      imageFormat: c.image.format ?? null,
    }));
  const [tx] = resolve(
    parseCameraCatalog(
      {
        roadwayCctvStatuses: {
          r: [
            {
              icd_Id: 'X1',
              name: 'IH-35 NB @ 6th',
              latitude: 30.27,
              longitude: -97.74,
              statusDescription: 'Device Online',
            },
          ],
        },
      },
      src('txdot-aus'),
    ),
  );
  const card = describeTrafficCam(parseTrafficCams({ cameras: [tx] })[0]);
  assert.deepEqual(card.image, {
    url: 'https://proxy.test/feed/txdot-img/GetCctvSnapshotByIcdId?icdId=X1&districtCode=AUS',
    alt: 'Latest still: IH-35 NB @ 6th',
    format: 'json-base64-jpeg',
    field: 'snippet',
  });
  const row = (c, k) => c.rows.find(([key]) => key === k)?.[1];
  assert.equal(row(card, 'Facing'), 'N (0°)');
  assert.equal(row(card, 'Source'), 'TxDOT (public catalogue, stills via the proxy)');
  assert.equal(row(card, 'Licence'), 'Texas Department of Transportation (courtesy)');
  assert.equal(card.credit, 'Texas Department of Transportation (courtesy)');
  // A JSON still is no use as a link; the licence page is.
  assert.deepEqual(card.links, [
    { label: 'Licence and terms', url: 'https://its.txdot.gov/' },
  ]);

  const [cal] = resolve(
    parseCameraCatalog(
      [
        {
          camera_url: { url: 'http://trafficcam.calgary.ca/loc86.jpg' },
          camera_location: '9 Avenue / 3 Street SE',
          point: { coordinates: [-114.06, 51.04] },
        },
      ],
      src('calgary'),
    ),
  );
  const calCard = describeTrafficCam(parseTrafficCams({ cameras: [cal] })[0]);
  assert.equal(row(calCard, 'Facing'), '—'); // the hashed stand-in is never shown
  assert.equal(calCard.image.url, 'https://proxy.test/feed/calgary-img/loc86.jpg');
  assert.equal(calCard.image.format, undefined);
  assert.equal(calCard.links[0].label, 'Open the latest still');

  const tln = resolve(parseCameraCatalog(TALLINN_CAMERAS, src('tallinn')));
  const t104 = describeTrafficCam(
    parseTrafficCams({ cameras: tln.filter((c) => c.id === 'tallinn-104') })[0],
  );
  assert.equal(row(t104, 'Facing'), 'SW (227°), curated');
  assert.match(row(t104, 'Source'), /curated catalogue/);

  const [bc] = resolve(
    parseCameraCatalog(
      [
        {
          id: 3,
          is_on: true,
          should_appear: true,
          location: { coordinates: [-123.1, 49.28] },
          credit: 'Images courtesy of the City of Vancouver',
        },
      ],
      src('drivebc'),
    ),
  );
  const bcCard = describeTrafficCam(parseTrafficCams({ cameras: [bc] })[0]);
  assert.equal(row(bcCard, 'Image credit'), 'Images courtesy of the City of Vancouver');
  assert.match(row(bcCard, 'Licence'), /Open Government Licence - British Columbia/);
});

test('the source: only networks in view are loaded, curated ones without a fetch', async () => {
  const asked = [];
  const proxyClient = {
    getJson: async (feedId, path, { params } = {}) => {
      asked.push(`${feedId}${path}${params ? `?${new URLSearchParams(params)}` : ''}`);
      return feedId === 'txdot' ? { roadwayCctvStatuses: {} } : { meta: {}, data: [] };
    },
    getText: async (feedId, path) => {
      asked.push(`text:${feedId}${path}`);
      return path.endsWith('Locations') ? LOCATIONS_XML : IMAGES_XML;
    },
    buildUrl: (feedId, path, params) =>
      `https://proxy.test/feed/${feedId}${path}${params ? `?${new URLSearchParams(params)}` : ''}`,
  };
  const source = createTrafficCamSource({ proxyClient });

  const austin = { lamin: 30.15, lamax: 30.45, lomin: -97.95, lomax: -97.55 };
  await source({ bbox: austin });
  assert.deepEqual(asked.sort(), [
    'austin/b4k4-adkb/rows.json?accessType=DOWNLOAD',
    'txdot/GetCctvStatusListByDistrict?districtCode=AUS',
  ]);

  // Finer coverage boxes: San Antonio's district box no longer takes in Austin,
  // and a Tallinn view no longer pulls Norway's or Finland's catalogues (below).
  asked.length = 0;
  await source({ bbox: { lamin: 29.35, lamax: 29.55, lomin: -98.6, lomax: -98.4 } });
  assert.deepEqual(asked, ['txdot/GetCctvStatusListByDistrict?districtCode=SAT']);
  assert.deepEqual(
    sourcesInView({ lamin: 59.8, lamax: 60.4, lomin: 10.5, lomax: 11.0 }).sources.map(
      (s) => s.id,
    ),
    ['vegvesen'],
  );

  asked.length = 0;
  const tallinn = { lamin: 59.38, lamax: 59.5, lomin: 24.6, lomax: 24.9 };
  const r = await source({ bbox: tallinn });
  assert.deepEqual(asked.sort(), [
    'text:tarktee/roadCameraImages',
    'text:tarktee/roadCameraLocations',
  ]);
  const tarktee = r.cameras.find((c) => c.id === 'ee-tarktee-42');
  assert.equal(
    tarktee.imageUrl,
    'https://proxy.test/feed/tarktee-img/42/42_202608251542.jpg',
  );
  assert.ok(r.cameras.filter((c) => c.id.startsWith('tallinn-')).length > 150);
  assert.equal(r.failed, 0);

  // One failing network does not blank the other.
  const flaky = createTrafficCamSource({
    proxyClient: {
      ...proxyClient,
      getText: async () => Promise.reject(new Error('down')),
    },
  });
  const partial = await flaky({ bbox: tallinn });
  assert.equal(partial.failed, 1);
  assert.ok(partial.cameras.length > 150);

  // Warendorf: one bundled camera, no fetch at all.
  asked.length = 0;
  const w = await source({
    bbox: { lamin: 51.94, lamax: 51.96, lomin: 7.98, lomax: 8.0 },
  });
  assert.deepEqual(asked, []);
  assert.equal(w.cameras[0].imageUrl, 'https://proxy.test/feed/warendorf-img/jpeg.cgi');
});

test('caps keep the cameras nearest the view centre and the anchors in view', () => {
  const cams = Array.from({ length: 10 }, (_, i) => ({
    id: `c${i}`,
    lat: 50 + i * 0.1,
    lon: 10,
  }));
  assert.equal(capCameras(cams, 20, [{ lat: 50, lon: 10 }]), cams);
  assert.equal(capCameras(cams, 0, [{ lat: 50, lon: 10 }]), cams);
  assert.deepEqual(ids(capCameras(cams, 3, [{ lat: 50.9, lon: 10 }])), [
    'c9',
    'c8',
    'c7',
  ]);
  assert.deepEqual(
    ids(
      capCameras(cams, 4, [
        { lat: 50, lon: 10 },
        { lat: 50.9, lon: 10 },
      ]),
    ),
    ['c0', 'c9', 'c1', 'c8'],
  );
  const view = { lamin: 43, lamax: 44, lomin: -80, lomax: -79 };
  const anchors = rankingAnchors(view, src('on511').anchors);
  assert.deepEqual(anchors[0], { lat: 43.5, lon: -79.5 });
  // Toronto and Hamilton are in (or near) this view; Ottawa and Windsor are not.
  assert.equal(anchors.length, 3);
  assert.equal(rankingAnchors(null, src('on511').anchors).length, 6);
});
