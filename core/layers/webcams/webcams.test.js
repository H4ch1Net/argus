// The public webcam layer: categories, the per-source parsers (realistic
// payloads shaped per each provider's documentation), the source (keys,
// zoom ceiling, paging, memo, decluttering) and the card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WEBCAM_CATEGORIES,
  CATEGORY_IDS,
  categoryFor,
  categoriesFromText,
  createCategoryFilter,
  createSetFilter,
  categoryInfo,
} from './categories.js';
import {
  parseWindy,
  parseNps,
  parseEpic,
  parseObservatories,
  windyImage,
  npsImage,
  epicImagePaths,
  boundedImageQuery,
} from './parse.js';
import {
  createWebcamSource,
  windyQuery,
  snapBBox,
  thinByGrid,
  windyTooWide,
  NPS_QUERY,
} from './sources.js';
import {
  parseWebcams,
  filterWebcams,
  describeWebcam,
  webcamNote,
  webcamSearchText,
} from './format.js';
import { OBSERVATORY_CAMERAS } from './data/observatories.js';
import { createWebcamMockSource } from './mockSource.js';
import { GLYPH_NAMES } from '../../ui/glyphs.js';

// --- fixtures -------------------------------------------------------------------

const windyCam = (id, over = {}) => ({
  webcamId: id,
  title: `Webcam ${id}`,
  viewCount: 1000,
  status: 'active',
  lastUpdatedOn: '2026-10-08T09:12:00.000Z',
  categories: [{ id: 'city', name: 'City' }],
  images: {
    current: {
      icon: `https://images-webcams.windy.com/35/${id}/current/icon/${id}.jpg`,
      thumbnail: `https://images-webcams.windy.com/35/${id}/current/thumbnail/${id}.jpg`,
      preview: `https://images-webcams.windy.com/35/${id}/current/preview/${id}.jpg`,
    },
    sizes: { preview: { width: 400, height: 224 } },
  },
  location: {
    city: 'Zermatt',
    region: 'Valais',
    region_code: 'CH.VS',
    country: 'Switzerland',
    country_code: 'CH',
    continent: 'Europe',
    latitude: 46.0207,
    longitude: 7.7491,
  },
  player: { day: `https://webcams.windy.com/webcams/public/embed/player/${id}/day` },
  urls: {
    detail: `https://www.windy.com/webcams/${id}`,
    provider: 'https://www.zermatt.ch/en/Webcams',
  },
  ...over,
});

const WINDY = {
  total: 7,
  webcams: [
    windyCam(1179853135, {
      title: 'Zermatt: Matterhorn',
      viewCount: 845123,
      categories: [
        { id: 'mountain', name: 'Mountain' },
        { id: 'landscape', name: 'Landscape' },
      ],
    }),
    windyCam(1600000001, {
      title: 'Bahnhofstrasse',
      categories: [
        { id: 'city', name: 'City' },
        { id: 'traffic', name: 'Traffic' },
      ],
      images: {
        current: {
          preview:
            'https://imgproxy.windy.com/_/preview/plain/current/1600000001/original.jpg?token=abc.DEF-123_x',
        },
      },
    }),
    windyCam(1600000002, { status: 'inactive' }),
    windyCam(1600000003, {
      title: 'Lake cam',
      images: { current: { preview: 'https://evil.example/x.jpg' } },
    }),
    windyCam(1600000004, {
      images: {
        current: {
          preview:
            'https://images-webcams.windy.com/1/2/current/preview/2.jpg?a=1&b=2&c=3&d=4&e=5',
        },
      },
    }),
    windyCam(1600000005, { location: { city: 'Nowhere' } }),
    windyCam(1600000006, {
      title: 'Osprey cam on the lake',
      categories: [{ id: 'lake', name: 'Lake' }],
    }),
    windyCam('not-a-number'),
  ],
};

const NPS = {
  total: '4',
  limit: '500',
  start: '0',
  data: [
    {
      id: 'A1B2C3D4-0000-1111-2222-333344445555',
      url: 'https://www.nps.gov/media/webcam/view.htm?id=A1B2C3D4-0000-1111-2222-333344445555',
      title: 'Old Faithful Geyser Live Stream',
      description: '<p>Watch Old Faithful &amp; the Upper Geyser Basin.</p>',
      images: [
        {
          url: 'https://www.nps.gov/common/uploads/cropped_image/primary/ABCD-1234.jpg?width=1600&quality=90',
          altText: 'Old Faithful erupting',
          credit: 'NPS / Jane Doe',
        },
      ],
      relatedParks: [
        { fullName: 'Yellowstone National Park', parkCode: 'yell', states: 'ID,MT,WY' },
      ],
      status: 'Active',
      statusMessage: '',
      isStreaming: true,
      latitude: 44.4605,
      longitude: -110.8281,
      credit: '',
    },
    {
      id: 'E5F6A7B8-0000-1111-2222-333344445555',
      url: 'https://explore.org/livecams/brown-bears/brown-bear-salmon-cam-brooks-falls',
      title: 'Brooks Falls Bear Cam',
      description: 'Brown bears fishing for salmon at Brooks Falls.',
      images: [{ url: 'https://explore.org/img/brooks.jpg' }],
      relatedParks: [{ fullName: 'Katmai National Park & Preserve', parkCode: 'katm' }],
      status: 'Active',
      isStreaming: true,
      latitude: '58.5546',
      longitude: '-155.7790',
    },
    {
      id: 'C0FFEE00-0000-1111-2222-333344445555',
      title: 'No coordinates cam',
      status: 'Active',
      latitude: '',
      longitude: '',
    },
    {
      id: 'DEAD0000-0000-1111-2222-333344445555',
      title: 'Retired cam',
      status: 'Inactive',
      latitude: 40,
      longitude: -105,
    },
  ],
};

const EPIC = [
  {
    identifier: '20261007003633',
    caption:
      "This image was taken by NASA's EPIC camera onboard the NOAA DSCOVR spacecraft",
    image: 'epic_1b_20261007003633',
    version: '03',
    centroid_coordinates: { lat: 6.53, lon: 168.44 },
    date: '2026-10-07 00:31:45',
  },
  {
    identifier: '20261007021136',
    image: 'epic_1b_20261007021136',
    centroid_coordinates: { lat: 6.4, lon: 144.1 },
    date: '2026-10-07 02:06:58',
  },
  { image: '../../etc/passwd', centroid_coordinates: { lat: 1, lon: 1 } },
  { image: 'epic_1b_20261007040000', centroid_coordinates: {} },
];

const proxyClient = (answers, asked = []) => ({
  getJson: async (feedId, path, { params } = {}) => {
    asked.push({ feedId, path, params });
    const a = answers[feedId];
    if (a instanceof Error) throw a;
    return typeof a === 'function' ? a(params) : a;
  },
  buildUrl: (feedId, path, params) =>
    `https://proxy.test/feed/${feedId}${path}${params ? `?${new URLSearchParams(params)}` : ''}`,
});

// --- categories -------------------------------------------------------------------

test('categories: every one has a ctOS glyph; Windy ids map, the most specific wins', () => {
  assert.equal(CATEGORY_IDS.length, 15);
  for (const c of WEBCAM_CATEGORIES)
    assert.ok(GLYPH_NAMES.includes(c.glyph), `${c.id} has glyph ${c.glyph}`);
  assert.ok(GLYPH_NAMES.includes('gate'));
  assert.equal(categoryFor({ windy: ['city', 'traffic'] }), 'traffic');
  assert.equal(categoryFor({ windy: ['beach', 'city'] }), 'beach');
  assert.equal(categoryFor({ windy: ['mountain', 'landscape'] }), 'mountain');
  assert.equal(categoryFor({ windy: ['meteo', 'mountain'] }), 'mountain');
  assert.equal(categoryFor({ windy: ['sportarea'] }), 'mountain');
  assert.equal(categoryFor({ windy: ['harbor'] }), 'harbor');
  assert.equal(categoryFor({ windy: ['meteo'] }), 'weather');
  assert.equal(categoryFor({ windy: ['building'] }), 'construction');
  assert.equal(categoryFor({ windy: ['indoor', 'somethingnew'] }), 'other');
  assert.equal(categoryFor({}), 'other');
  assert.equal(categoryFor({ base: ['park'], text: 'Old Faithful' }), 'park');
  assert.equal(categoryInfo('nope').id, 'other');
});

test('title rules are narrow: a bear cam is wildlife, Big Bear Lake is not', () => {
  assert.deepEqual(categoriesFromText('Brooks Falls Bear Cam'), ['wildlife']);
  assert.deepEqual(categoriesFromText('Big Bear Lake marina'), []);
  assert.deepEqual(categoriesFromText('Osprey nesting platform'), ['wildlife']);
  assert.deepEqual(categoriesFromText('Rail Trail parking'), []);
  assert.deepEqual(categoriesFromText('Main train station platform'), ['rail']);
  assert.deepEqual(categoriesFromText('University of Iowa campus'), ['campus']);
  assert.deepEqual(categoriesFromText('Bridge construction site'), ['construction']);
  // A title can refine a broad provider category, never override a specific one.
  assert.equal(categoryFor({ windy: ['city'], text: 'Train station' }), 'rail');
  assert.equal(categoryFor({ windy: ['traffic'], text: 'Train station' }), 'traffic');
});

test('the set filter: set, toggle, all, none, change notification', () => {
  const f = createCategoryFilter();
  assert.ok(f.isAll);
  const seen = [];
  const off = f.subscribe((s) => seen.push([...s].sort().join(',')));
  f.toggle('traffic');
  assert.equal(f.has('traffic'), false);
  assert.equal(f.isAll, false);
  f.set(['beach', 'harbor', 'bogus']);
  assert.deepEqual([...f.selected()].sort(), ['beach', 'harbor']);
  f.set(['harbor', 'beach']); // unchanged: no notification
  f.none();
  assert.equal(f.size, 0);
  f.all();
  assert.equal(f.size, 15);
  off();
  f.none();
  assert.equal(seen.length, 4);
  assert.equal(seen[1], 'beach,harbor');
  const kinds = createSetFilter(['a', 'b'], ['a']);
  assert.equal(kinds.has('b'), false);
  assert.equal(kinds.isAll, false);
});

// --- parsers ----------------------------------------------------------------------

test('Windy: active webcams with a position; stills pinned to Windy hosts', () => {
  const out = parseWindy(WINDY);
  assert.deepEqual(
    out.map((c) => c.id),
    [
      'windy-1179853135',
      'windy-1600000001',
      'windy-1600000003',
      'windy-1600000004',
      'windy-1600000006',
    ],
  );
  const [zermatt, bahnhof, lake, tooMany, osprey] = out;
  assert.equal(zermatt.category, 'mountain');
  assert.equal(zermatt.place, 'Zermatt, Valais, Switzerland');
  assert.deepEqual(zermatt.image, {
    feedId: 'windy-img',
    path: '/35/1179853135/current/preview/1179853135.jpg',
  });
  assert.equal(zermatt.pageUrl, 'https://www.windy.com/webcams/1179853135');
  assert.equal(zermatt.rank, 845123);
  assert.deepEqual(
    zermatt.extraLinks.map((l) => l.label),
    ['Webcam operator', 'Timelapse on windy.com'],
  );
  // A tokenized v3 still keeps its token, on the image proxy host's feed.
  assert.equal(bahnhof.category, 'traffic');
  assert.deepEqual(bahnhof.image, {
    feedId: 'windy-imgproxy',
    path: '/_/preview/plain/current/1600000001/original.jpg',
    params: { token: 'abc.DEF-123_x' },
  });
  // Foreign hosts and unbounded queries give no still (the webcam stays).
  assert.equal(lake.image, null);
  assert.equal(tooMany.image, null);
  assert.equal(osprey.category, 'wildlife');
  assert.equal(windyImage('http://images-webcams.windy.com/a/b.jpg'), null);
  assert.equal(windyImage('https://images-webcams.windy.com/a/b.html'), null);
  assert.equal(windyImage('https://user:pw@images-webcams.windy.com/a/b.jpg'), null);
  assert.equal(boundedImageQuery(new URLSearchParams('token=a b')), null);
  assert.equal(boundedImageQuery(new URLSearchParams('t=1&t=2')), null);
});

test('NPS: active, located listings; images pinned to nps.gov uploads; wildlife titles', () => {
  const out = parseNps(NPS);
  assert.deepEqual(
    out.map((c) => c.id),
    [
      'nps-a1b2c3d4-0000-1111-2222-333344445555',
      'nps-e5f6a7b8-0000-1111-2222-333344445555',
    ],
  );
  const [geyser, bears] = out;
  assert.equal(geyser.category, 'park');
  assert.deepEqual(geyser.image, {
    feedId: 'nps-img',
    path: '/common/uploads/cropped_image/primary/ABCD-1234.jpg',
  });
  assert.equal(geyser.imageKind, 'reference');
  assert.equal(geyser.description, 'Watch Old Faithful & the Upper Geyser Basin.');
  assert.equal(geyser.place, 'Yellowstone National Park');
  assert.equal(geyser.credit, 'NPS / Jane Doe');
  assert.equal(geyser.streaming, true);
  assert.equal(bears.category, 'wildlife');
  assert.equal(bears.image, null); // explore.org is not an NPS still host
  assert.equal(bears.lat, 58.5546);
  assert.equal(npsImage('https://www.nps.gov/common/uploads/../../admin/x.jpg'), null);
  assert.equal(npsImage('https://nps.gov/common/uploads/x.jpg'), null);
});

test('EPIC: latest images at their centroid, thumbnail still, full-size link', () => {
  const out = parseEpic(EPIC);
  assert.equal(out.length, 2);
  const [a] = out;
  assert.equal(a.id, 'epic-20261007003633');
  assert.equal(a.category, 'space');
  assert.equal(a.lat, 6.53);
  assert.equal(a.lon, 168.44);
  assert.deepEqual(a.image, {
    feedId: 'epic-img',
    path: '/archive/natural/2026/10/07/thumbs/epic_1b_20261007003633.jpg',
  });
  assert.equal(
    a.fullImage.path,
    '/archive/natural/2026/10/07/jpg/epic_1b_20261007003633.jpg',
  );
  assert.equal(a.updated, '2026-10-07T00:31:45Z');
  assert.equal(epicImagePaths('epic_RGB_20261007003633'), null);
  assert.deepEqual(parseEpic({ not: 'a list' }), []);
});

test('observatories: the bundled catalogue parses onto its image feeds', () => {
  const out = parseObservatories(OBSERVATORY_CAMERAS);
  assert.equal(out.length, OBSERVATORY_CAMERAS.length);
  assert.ok(out.length >= 1 && out.length <= 5, 'kept deliberately small');
  for (const c of out) {
    assert.equal(c.category, 'observatory');
    assert.match(c.image.feedId, /^(sdo|soho)-img$/);
    assert.ok(c.credit, `${c.id} carries its credit`);
  }
  // A row pointing anywhere else is refused.
  assert.deepEqual(
    parseObservatories([{ ...OBSERVATORY_CAMERAS[0], path: '/assets/other.jpg' }]),
    [],
  );
});

// --- the source --------------------------------------------------------------------

const ZERMATT = { lamin: 45.9, lamax: 46.1, lomin: 7.6, lomax: 7.9 };

test('keyless by default: EPIC and the observatories, no Windy or NPS request', async () => {
  const asked = [];
  const src = createWebcamSource({ proxyClient: proxyClient({ epic: EPIC }, asked) });
  const r = await src({ bbox: { lamin: -90, lamax: 90, lomin: -180, lomax: 180 } });
  assert.deepEqual(
    asked.map((a) => a.feedId),
    ['epic'],
  );
  assert.deepEqual(r.offered, ['epic', 'observatory']);
  assert.equal(r.tooWide, false);
  assert.equal(r.webcams.filter((c) => c.source === 'epic').length, 2);
  assert.equal(r.webcams.filter((c) => c.source === 'observatory').length, 3);
  const epic = r.webcams.find((c) => c.source === 'epic');
  assert.match(
    epic.imageUrl,
    /^https:\/\/proxy\.test\/feed\/epic-img\/archive\/natural\//,
  );
  assert.match(epic.fullImageUrl, /\/jpg\/epic_1b_/);
});

test('with keys: Windy pages the view (snapped), NPS once; memo; zoom ceiling', async () => {
  const asked = [];
  let t = 0;
  const pages = (params) => ({
    total: 73,
    webcams: params.offset === 0 ? WINDY.webcams : [windyCam(1700000000)],
  });
  const src = createWebcamSource({
    proxyClient: proxyClient({ epic: EPIC, 'nps-webcams': NPS, windy: pages }, asked),
    isConfigured: (id) => id === 'windy' || id === 'nps-webcams',
    now: () => t,
  });
  const r = await src({ bbox: ZERMATT });
  const windyAsks = asked.filter((a) => a.feedId === 'windy');
  assert.equal(windyAsks.length, 2, 'total 73: a second page of 50');
  assert.deepEqual(windyAsks[0].params, windyQuery(snapBBox(ZERMATT), 0));
  assert.equal(windyAsks[0].params.bbox, '46.125,8,45.875,7.5');
  assert.equal(windyAsks[1].params.offset, 50);
  assert.deepEqual(asked.find((a) => a.feedId === 'nps-webcams').params, NPS_QUERY);
  assert.deepEqual(r.offered, ['epic', 'observatory', 'nps', 'windy']);
  assert.equal(r.windyTotal, 73);
  const bahn = r.webcams.find((c) => c.id === 'windy-1600000001');
  assert.equal(
    bahn.imageUrl,
    'https://proxy.test/feed/windy-imgproxy/_/preview/plain/current/1600000001/original.jpg?token=abc.DEF-123_x',
  );
  // NPS webcams outside the view are left out; EPIC centroids too.
  assert.equal(r.webcams.filter((c) => c.source === 'nps').length, 0);
  assert.equal(r.webcams.filter((c) => c.source === 'epic').length, 0);

  // Same view within the memo window: nothing is asked again.
  const before = asked.length;
  t += 60_000;
  await src({ bbox: ZERMATT });
  assert.equal(asked.length, before);
  // Past Windy's 4-minute memo: Windy again, the national lists still memoized.
  t += 4 * 60_000;
  await src({ bbox: ZERMATT });
  assert.deepEqual(
    asked.slice(before).map((a) => a.feedId),
    ['windy', 'windy'],
  );

  // Zoomed out past the ceiling: no Windy request, and the note says why.
  asked.length = 0;
  const wide = await src({ bbox: { lamin: 30, lamax: 50, lomin: -10, lomax: 20 } });
  assert.equal(wide.tooWide, true);
  assert.equal(asked.filter((a) => a.feedId === 'windy').length, 0);
  assert.equal(webcamNote(wide), 'zoom in to load webcams');
  assert.ok(windyTooWide({ lamin: 0, lamax: 1, lomin: 179, lomax: 180, wrap: {} }));
});

test('one failing source does not blank the others; all failing throws', async () => {
  const src = createWebcamSource({
    proxyClient: proxyClient({ epic: EPIC, windy: new Error('429') }),
    isConfigured: (id) => id === 'windy',
  });
  const r = await src({ bbox: ZERMATT });
  assert.equal(r.failed, 1);
  assert.match(webcamNote(r), /1 source\(s\) failed/);
  const broken = createWebcamSource({
    proxyClient: proxyClient({ epic: new Error('down') }),
    loadObservatories: async () => {
      throw new Error('gone');
    },
  });
  await assert.rejects(broken({ bbox: ZERMATT }), /down/);
});

test('decluttering keeps the highest-ranked few per grid cell', () => {
  const bbox = { lamin: 0, lamax: 1, lomin: 0, lomax: 1 };
  const cams = Array.from({ length: 10 }, (_, i) => ({
    id: `c${i}`,
    lat: 0.01,
    lon: 0.01,
    rank: i,
  }));
  const far = { id: 'far', lat: 0.9, lon: 0.9, rank: 0 };
  const kept = thinByGrid([...cams, far], bbox, { cells: 4, perCell: 3 });
  assert.deepEqual(
    kept.map((c) => c.id),
    ['c7', 'c8', 'c9', 'far'],
  );
});

// --- entities and the card -------------------------------------------------------

test('the card: still via the proxy, link back to windy.com, credit, category', () => {
  const [n] = parseWebcams({
    webcams: parseWindy(WINDY)
      .slice(0, 1)
      .map((c) => ({ ...c, imageUrl: 'https://proxy.test/feed/windy-img/x.jpg' })),
  });
  assert.equal(n.id, 'wc:windy-1179853135');
  assert.equal(n.type, 'webcam');
  const card = describeWebcam(n);
  assert.equal(card.title, 'Zermatt: Matterhorn');
  assert.equal(card.subtitle, 'Mountain & ski · Zermatt, Valais, Switzerland');
  assert.equal(card.image.url, 'https://proxy.test/feed/windy-img/x.jpg');
  assert.equal(card.links[0].url, 'https://www.windy.com/webcams/1179853135');
  assert.equal(card.credit, 'Webcams provided by windy.com');
  const row = (k) => card.rows.find(([key]) => key === k)?.[1];
  assert.equal(row('Category'), 'Mountain & ski');
  assert.equal(row('Updated'), '2026-10-08 09:12 UTC');
  assert.match(row('Note'), /nothing here analyses it/);
  assert.match(webcamSearchText(n), /Matterhorn.*Mountain & ski.*mountain/);

  const [nps] = parseWebcams({ webcams: parseNps(NPS).slice(0, 1) });
  const npsCard = describeWebcam(nps);
  assert.equal(npsCard.image, null); // no imageUrl resolved: nothing to load
  assert.match(npsCard.rows.find(([k]) => k === 'Image')[1], /reference photo/);
  assert.equal(npsCard.rows.find(([k]) => k === 'Live stream')[1], 'on the webcam page');
  assert.equal(npsCard.rows.find(([k]) => k === 'Image credit')[1], 'NPS / Jane Doe');
});

test('the category filter hides without refetching, and the note counts it', () => {
  const result = {
    webcams: [
      ...parseWindy(WINDY),
      ...parseEpic(EPIC).map((c) => ({ ...c, imageUrl: null })),
    ],
  };
  const all = parseWebcams(result);
  const f = createCategoryFilter(['space', 'wildlife']);
  const shown = filterWebcams(all, f);
  assert.deepEqual(shown.map((n) => n.meta.category).sort(), [
    'space',
    'space',
    'wildlife',
  ]);
  assert.equal(webcamNote(result, f), '4 hidden by filter');
  assert.equal(filterWebcams(all, null).length, all.length);
});

test('the demo source puts one simulated webcam per category in view', async () => {
  const bbox = { lamin: 10, lamax: 11, lomin: 20, lomax: 21 };
  const r = await createWebcamMockSource({ viewer: null })({ bbox });
  assert.equal(r.webcams.length, 15);
  for (const c of r.webcams) {
    assert.ok(c.lat >= 10 && c.lat <= 11 && c.lon >= 20 && c.lon <= 21);
    assert.ok(c.demo);
  }
  const card = describeWebcam(parseWebcams(r)[0]);
  assert.ok(card.rows.some(([k, v]) => k === 'Source' && v === 'demo (simulated)'));
  assert.equal(card.credit, null);
});
