// The public camera networks in proxy/feeds/cameras.js: keyless, path- and
// query-pinned, and in agreement with the still paths core's parsers produce.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { feeds as cameraFeeds } from '../feeds/cameras.js';
import { validateFeeds, loadConfig } from '../lib/config.js';
import { buildUpstreamUrl } from '../lib/relay.js';
import { createRequestHandler } from '../lib/app.js';

const feed = (id) => cameraFeeds.find((f) => f.id === id);

/** Would the relay forward this sub-path (with its query) on this feed? */
function allowed(id, subpath, search = '') {
  const f = feed(id);
  let target;
  try {
    target = buildUpstreamUrl(f, subpath, search);
  } catch {
    return false;
  }
  const pathOk = (f.allowPaths || []).some((re) => re.test(target.pathname));
  return pathOk && (!f.allowQuery || f.allowQuery(target.searchParams));
}

test('every camera feed is keyless, named, path- and query-pinned', async () => {
  const { feeds } = await import('../feeds.js');
  assert.equal(validateFeeds(feeds), feeds);
  for (const id of [
    'on511',
    'drivebc',
    'calgary',
    'fintraffic',
    'txdot',
    'austin',
    'tarktee',
  ]) {
    assert.ok(
      feeds.some((f) => f.id === id),
      `${id} is registered`,
    );
    assert.ok(
      feeds.some((f) => f.id === `${id}-img`),
      `${id} has an image-only feed`,
    );
  }
  for (const f of cameraFeeds) {
    assert.ok(f.allowPaths?.length, `${f.id} has a path allowlist`);
    assert.equal(typeof f.allowQuery, 'function', `${f.id} pins its query`);
    assert.equal(f.inject, undefined, `${f.id} needs no key`);
    assert.equal(f.auth, undefined);
    assert.match(f.headers['user-agent'], /^Argus\/.+github\.com/);
    assert.ok(f.governor?.ratePerMinute > 0, `${f.id} is rate-governed`);
    assert.deepEqual(f.methods, ['GET']);
    // Catalogues are cached 15 minutes; stills are never cached here.
    if (f.id.endsWith('-img')) assert.equal(f.cache, undefined);
    else assert.equal(f.cache.ttlMs, 15 * 60_000);
  }
  assert.equal(feed('fintraffic').headers['digitraffic-user'], 'H4ch1Net/Argus');
  assert.equal(feed('fintraffic-img').headers['digitraffic-user'], 'H4ch1Net/Argus');
  assert.match(feed('tarktee').headers.accept, /application\/xml/);
  // Only Warendorf's own still is plain http (the proxy terminates HTTPS for it).
  const plain = cameraFeeds.filter((f) => f.baseUrl.startsWith('http:')).map((f) => f.id);
  assert.deepEqual(plain, ['warendorf-img']);
});

test('catalogue feeds reach their one document with its one query', () => {
  assert.ok(allowed('on511', '/cameras', '?format=json&lang=en'));
  assert.equal(allowed('on511', '/cameras', '?format=xml&lang=en'), false);
  assert.equal(allowed('on511', '/cameras', '?format=json&lang=en&lang=fr'), false);
  assert.equal(allowed('on511', '/events', '?format=json&lang=en'), false);
  assert.ok(allowed('drivebc', '/webcams/'));
  assert.equal(allowed('drivebc', '/webcams/', '?x=1'), false);
  assert.equal(allowed('drivebc', '/events/'), false);
  // The client sends $limit percent-encoded; the pin judges the decoded key.
  assert.ok(allowed('calgary', '/k7p9-kppz.json', '?%24limit=500'));
  assert.equal(allowed('calgary', '/k7p9-kppz.json', '?$limit=5000'), false);
  assert.equal(allowed('calgary', '/k7p9-kppz.json', '?$limit=500&$where=1'), false);
  assert.equal(allowed('calgary', '/other.json', '?$limit=500'), false);
  assert.ok(allowed('fintraffic', '/stations'));
  assert.equal(allowed('fintraffic', '/stations/C01503'), false);
  assert.ok(allowed('txdot', '/GetCctvStatusListByDistrict', '?districtCode=AUS'));
  assert.equal(
    allowed('txdot', '/GetCctvStatusListByDistrict', '?districtCode=XXX'),
    false,
  );
  assert.equal(allowed('txdot', '/GetCctvSnapshotByIcdId', '?districtCode=AUS'), false);
  assert.ok(allowed('austin', '/b4k4-adkb/rows.json', '?accessType=DOWNLOAD'));
  assert.equal(allowed('austin', '/b4k4-adkb/rows.json'), false);
  assert.equal(allowed('austin', '/other/rows.json', '?accessType=DOWNLOAD'), false);
  assert.ok(allowed('tarktee', '/roadCameraLocations'));
  assert.ok(allowed('tarktee', '/roadCameraImages'));
  assert.equal(allowed('tarktee', '/roadWeather'), false);
});

test('image feeds reach stills only, never a catalogue or a traversal', () => {
  assert.ok(allowed('on511-img', '/101'));
  assert.equal(allowed('on511-img', '/..%2F..%2Fapi'), false);
  assert.ok(allowed('drivebc-img', '/5.jpg'));
  assert.equal(allowed('drivebc-img', '/../api/webcams/'), false);
  assert.ok(allowed('calgary-img', '/loc142.jpg'));
  assert.equal(allowed('calgary-img', '/a/b.jpg'), false);
  assert.ok(allowed('fintraffic-img', '/C0150301.jpg'));
  assert.equal(allowed('fintraffic-img', '/C015030.jpg'), false);
  assert.ok(
    allowed(
      'txdot-img',
      '/GetCctvSnapshotByIcdId',
      `?${new URLSearchParams({ icdId: 'FM-734 @ US-290 EB', districtCode: 'AUS' })}`,
    ),
  );
  assert.equal(
    allowed('txdot-img', '/GetCctvSnapshotByIcdId', '?icdId=a&districtCode=AUS&x=1'),
    false,
  );
  assert.equal(
    allowed('txdot-img', '/GetCctvStatusListByDistrict', '?districtCode=AUS'),
    false,
  );
  assert.ok(allowed('austin-img', '/42.jpg'));
  assert.equal(allowed('austin-img', '/x.jpg'), false);
  assert.ok(allowed('tarktee-img', '/42/42_202608251542.jpg'));
  assert.equal(allowed('tarktee-img', '/42/../../api/v1/datex/roadCameraImages'), false);
  assert.ok(allowed('warendorf-img', '/jpeg.cgi'));
  assert.equal(allowed('warendorf-img', '/jpeg.cgi', '?action=reboot'), false);
  assert.equal(allowed('warendorf-img', '/config.cgi'), false);
});

test("core's still paths are exactly what the image feeds allow", async () => {
  const { TALLINN_CAMERAS } =
    await import('../../core/layers/trafficcams/data/tallinn.js');
  const { WARENDORF_CAMERAS } =
    await import('../../core/layers/trafficcams/data/warendorf.js');
  const { CAMERA_SOURCES, parseCameraCatalog } =
    await import('../../core/layers/trafficcams/sources.js');
  const src = (id) => CAMERA_SOURCES.find((s) => s.id === id);
  const stills = [
    ...parseCameraCatalog(TALLINN_CAMERAS, src('tallinn')),
    ...parseCameraCatalog(WARENDORF_CAMERAS, src('warendorf')),
    ...parseCameraCatalog(
      {
        roadwayCctvStatuses: {
          r: [
            {
              icd_Id: 'IH-35 @ 6th (NB) #2',
              latitude: 30.27,
              longitude: -97.74,
              statusDescription: 'Device Online',
            },
          ],
        },
      },
      src('txdot-aus'),
    ),
  ].map((c) => c.image);
  assert.equal(stills.length, 257);
  for (const img of stills) {
    const search = img.params ? `?${new URLSearchParams(img.params)}` : '';
    assert.ok(allowed(img.feedId, img.path, search), `${img.feedId}${img.path}${search}`);
  }
  // Every source the client fetches is a registered, allowed catalogue request.
  for (const s of CAMERA_SOURCES.filter((x) => x.feedId && feed(x.feedId))) {
    for (const p of s.paths ?? [s.path]) {
      const search = s.params ? `?${new URLSearchParams(s.params)}` : '';
      assert.ok(allowed(s.feedId, p, search), `${s.id}: ${s.feedId}${p}${search}`);
    }
  }
});

test('through the relay: pinned queries, the Digitraffic name, XML for Tarktee', async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  // The real feed configs, re-pointed at the local upstream (same base paths).
  const local = ['calgary', 'fintraffic', 'tarktee', 'txdot-img'].map((id) => {
    const f = feed(id);
    return { ...f, baseUrl: origin + new URL(f.baseUrl).pathname };
  });
  const proxy = http.createServer(
    createRequestHandler({ config: loadConfig({}), feeds: local }),
  );
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  t.after(() => {
    proxy.close();
    upstream.close();
  });
  const base = `http://127.0.0.1:${proxy.address().port}`;
  const get = (p, accept = 'application/json') =>
    fetch(`${base}${p}`, { headers: { accept } }).then((r) => r.status);

  assert.equal(await get('/feed/calgary/k7p9-kppz.json?%24limit=500'), 200);
  assert.equal(seen.at(-1).url, '/resource/k7p9-kppz.json?%24limit=500');
  assert.equal(await get('/feed/calgary/k7p9-kppz.json?%24limit=500&%24where=x'), 403);

  assert.equal(await get('/feed/fintraffic/stations'), 200);
  assert.equal(seen.at(-1).headers['digitraffic-user'], 'H4ch1Net/Argus');
  assert.match(seen.at(-1).headers['user-agent'], /^Argus\//);

  assert.equal(await get('/feed/tarktee/roadCameraLocations', 'text/plain'), 200);
  assert.match(seen.at(-1).headers.accept, /^application\/xml/);

  const q = new URLSearchParams({ icdId: 'FM-734 @ US-290 EB', districtCode: 'AUS' });
  assert.equal(await get(`/feed/txdot-img/GetCctvSnapshotByIcdId?${q}`), 200);
  assert.equal(
    new URL(seen.at(-1).url, origin).searchParams.get('icdId'),
    'FM-734 @ US-290 EB',
  );
  assert.equal(
    await get('/feed/txdot-img/GetCctvSnapshotByIcdId?icdId=a&districtCode=ZZZ'),
    403,
  );
  assert.equal(seen.length, 4); // refused requests never reached the upstream
});
