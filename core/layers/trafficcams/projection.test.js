import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  camPose,
  normalizePose,
  enuToLonLat,
  projectionGeometry,
  stillSourceKind,
} from './projectionGeometry.js';
import { loadStill } from './still.js';
import { DEFAULT_POSE } from '../cctv/pose.js';
import { posePrior, fallbackHeading } from './pose.js';

const near = (a, b, eps, msg) =>
  assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} vs ${b} (eps ${eps})`);

// Metres per degree of latitude and longitude at a latitude: the standard
// WGS84 series, independent of the code under test.
const degLat = (lat) => {
  const r = (lat * Math.PI) / 180;
  return 111_132.954 - 559.822 * Math.cos(2 * r) + 1.175 * Math.cos(4 * r);
};
const degLon = (lat) => {
  const r = (lat * Math.PI) / 180;
  return 111_412.84 * Math.cos(r) - 93.5 * Math.cos(3 * r) + 0.118 * Math.cos(5 * r);
};
// Metres between two lon/lat points on a small local patch (east, north).
const offsetM = (from, to) => ({
  e: (to.lon - from.lon) * degLon(from.lat),
  n: (to.lat - from.lat) * degLat(from.lat),
});

test('enuToLonLat: metres to degrees on the WGS84 tangent plane', () => {
  // At the equator: one degree of longitude is 111.32 km, of latitude 110.57 km.
  const p = enuToLonLat(0, 0, 1000, 1000);
  near(p.lon * degLon(0), 1000, 0.01, 'east 1 km');
  near(p.lat * degLat(0), 1000, 0.01, 'north 1 km');
  // At 60 N a degree of longitude is about half as long.
  const q = enuToLonLat(24.75, 60, 1000, -1000);
  near((q.lon - 24.75) * degLon(60), 1000, 0.01, 'east 1 km');
  near((q.lat - 60) * degLat(60), -1000, 0.01, 'south 1 km');
});

test('a level camera looking north: centre straight ahead, corners left/right, up/down', () => {
  const at = { lon: -0.1246, lat: 51.5007, groundM: 15 };
  const pose = { heading: 0, pitch: 0, fovDeg: 20, rangeM: 50, heightM: 8 };
  const g = projectionGeometry(at, pose, { aspect: 16 / 9 });
  const halfW = 50 * Math.tan((10 * Math.PI) / 180);
  near(g.halfW, halfW, 1e-9);
  near(g.halfH, halfW / (16 / 9), 1e-9);
  assert.equal(g.liftM, 0, 'the bottom edge is already above the ground');
  assert.deepEqual(g.mount, { lon: at.lon, lat: at.lat, height: 23 });
  const c = offsetM(g.mount, g.center);
  near(c.e, 0, 0.01);
  near(c.n, 50, 0.05);
  near(g.center.height, 23, 1e-9);
  const [tl, tr, br, bl] = g.corners.map((p) => ({
    ...offsetM(g.mount, p),
    h: p.height,
  }));
  near(tl.e, -halfW, 0.01, 'TL is west');
  near(tr.e, halfW, 0.01, 'TR is east');
  near(br.e, halfW, 0.01);
  near(bl.e, -halfW, 0.01);
  for (const k of [tl, tr, br, bl]) near(k.n, 50, 0.05);
  near(tl.h, 23 + g.halfH, 1e-9);
  near(bl.h, 23 - g.halfH, 1e-9);
  // Frame: looking north, right is east, up is up.
  near(g.axes.dir.n, 1, 1e-12);
  near(g.axes.right.e, 1, 1e-12);
  near(g.axes.up.u, 1, 1e-12);
});

test('heading 90 looks east; the frame stays right-handed and orthonormal', () => {
  const at = { lon: 2.2945, lat: 48.8584 };
  const g = projectionGeometry(at, { heading: 90, pitch: 10, fovDeg: 40, rangeM: 120 });
  const c = offsetM(g.mount, g.center);
  near(c.e, 120 * Math.cos((10 * Math.PI) / 180), 0.1);
  near(c.n, 0, 0.1);
  const { dir, right, up } = g.axes;
  const dot = (a, b) => a.e * b.e + a.n * b.n + a.u * b.u;
  for (const v of [dir, right, up]) near(dot(v, v), 1, 1e-12);
  near(dot(dir, right), 0, 1e-12);
  near(dot(dir, up), 0, 1e-12);
  near(dot(right, up), 0, 1e-12);
  // right x up = -dir (the quad's normal faces back at the camera).
  const n = {
    e: right.n * up.u - right.u * up.n,
    n: right.u * up.e - right.e * up.u,
    u: right.e * up.n - right.n * up.e,
  };
  near(n.e, -dir.e, 1e-12);
  near(n.n, -dir.n, 1e-12);
  near(n.u, -dir.u, 1e-12);
  // Looking east, the far plane's right edge is to the south.
  assert.ok(g.corners[1].lat < g.corners[0].lat, 'TR south of TL');
});

test('a pitched-down frustum is lifted as one rigid rectangle above the ground', () => {
  const at = { lon: -97.7403, lat: 30.2747, groundM: 150 };
  const pose = { heading: 180, pitch: 25, fovDeg: 55, rangeM: 250, heightM: 8 };
  const flat = projectionGeometry(at, pose, { clearanceM: -1e9 }); // no lift
  const g = projectionGeometry(at, pose);
  assert.equal(flat.liftM, 0);
  assert.ok(g.liftM > 100, `lift ${g.liftM}`);
  const lowest = Math.min(...g.corners.map((p) => p.height));
  near(lowest, 150 + 2, 1e-9, 'lowest corner 2 m above the ground');
  near(g.mount.height, 158, 1e-9, 'the mount does not move');
  // Rigid: every corner and the centre rise by the same amount, lon/lat unchanged.
  for (const [i, p] of g.corners.entries()) {
    near(p.height - flat.corners[i].height, g.liftM, 1e-9);
    assert.equal(p.lon, flat.corners[i].lon);
    assert.equal(p.lat, flat.corners[i].lat);
  }
  near(g.center.height - flat.center.height, g.liftM, 1e-9);
  // Unlifted, every corner is the frustum's slant distance from the mount.
  const slant = Math.hypot(250, flat.halfW, flat.halfH);
  for (const p of flat.corners) {
    const o = offsetM(flat.mount, p);
    near(Math.hypot(o.e, o.n, p.height - flat.mount.height), slant, 0.3);
  }
});

test('the still sets the aspect; nonsense aspects are clamped', () => {
  const at = { lon: 0, lat: 0 };
  const pose = { heading: 0, pitch: 0, fovDeg: 60, rangeM: 100 };
  const four3 = projectionGeometry(at, pose, { aspect: 4 / 3 });
  near(four3.halfH, four3.halfW * 0.75, 1e-9);
  assert.equal(projectionGeometry(at, pose, { aspect: 0 }).aspect, 16 / 9);
  assert.equal(projectionGeometry(at, pose, { aspect: 99 }).aspect, 4);
});

test('normalizePose: defaults fill gaps, values are clamped, heading wraps', () => {
  assert.deepEqual(normalizePose(null), { ...DEFAULT_POSE, groundM: null });
  const p = normalizePose({
    heading: -90,
    pitch: 200,
    fovDeg: 'wide',
    rangeM: 1,
    heightM: 12,
    groundM: 42,
  });
  assert.deepEqual(p, {
    heading: 270,
    pitch: 89,
    fovDeg: DEFAULT_POSE.fovDeg,
    rangeM: 10,
    heightM: 12,
    groundM: 42,
  });
});

test('camPose: the edited pose beats the prior, the prior beats DEFAULT_POSE', () => {
  const prior = posePrior({ id: 'tfl-1', headingDeg: 270, groundM: 15 });
  const record = { id: 'cam:tfl-1', meta: { pose: prior, direction: 'West' } };
  const p = camPose(record);
  assert.equal(p.heading, 270);
  assert.equal(p.pitch, prior.pitch);
  assert.equal(p.fovDeg, prior.fovDeg);
  assert.equal(p.rangeM, prior.rangeM);
  assert.equal(p.heightM, prior.heightM);
  assert.equal(p.groundM, 15);
  // The gizmo's shape ({ heading, pitch, fovDeg, rangeM }) wins field by field.
  const edited = camPose(record, { heading: 300, rangeM: 400 });
  assert.equal(edited.heading, 300);
  assert.equal(edited.rangeM, 400);
  assert.equal(edited.pitch, prior.pitch);
});

test('camPose: no prior (demo cameras) uses direction text, then the hashed heading', () => {
  const demo = { id: 'cam:demo-1', meta: { pose: null, direction: 'South' } };
  assert.deepEqual(camPose(demo), { ...DEFAULT_POSE, heading: 180, groundM: null });
  const blank = { id: 'cam:demo-2', meta: { pose: null, direction: null } };
  assert.equal(camPose(blank).heading, fallbackHeading('cam:demo-2'));
  assert.equal(camPose(blank).heightM, 8, 'the default mount is 8 m');
  // A catalogue record works too.
  assert.equal(camPose({ id: 'x', direction: 'Eastbound' }).heading, 90);
});

test('stillSourceKind: blob, data:image, same origin and the proxy only', () => {
  const origin = 'https://argus.local:8787';
  const opts = { origin, proxyBase: 'https://proxy.lan:8787' };
  assert.equal(stillSourceKind('blob:https://argus.local:8787/abc-123', opts), 'blob');
  assert.equal(stillSourceKind('data:image/jpeg;base64,/9j/4AAQ', opts), 'data');
  assert.equal(
    stillSourceKind('https://argus.local:8787/feed/tfl-img/1.jpg', opts),
    'same-origin',
  );
  assert.equal(stillSourceKind('/feed/caltrans-img/d4/x.jpg', opts), 'same-origin');
  assert.equal(
    stillSourceKind('https://proxy.lan:8787/feed/tfl-img/1.jpg', opts),
    'proxy',
  );
  const sub = { origin, proxyBase: 'https://proxy.lan/argus' };
  assert.equal(stillSourceKind('https://proxy.lan/argus/feed/a.jpg', sub), 'proxy');
  assert.equal(stillSourceKind('https://proxy.lan/elsewhere/a.jpg', sub), null);
  // Never a third-party host, a script or a page.
  assert.equal(stillSourceKind('https://cwwp2.dot.ca.gov/data/d4/x.jpg', opts), null);
  assert.equal(stillSourceKind('javascript:alert(1)', opts), null);
  assert.equal(stillSourceKind('data:text/html;base64,PGI+', opts), null);
  assert.equal(stillSourceKind('https://user:pw@argus.local:8787/a.jpg', opts), null);
  assert.equal(stillSourceKind(null, opts), null);
  assert.equal(stillSourceKind({}, opts), null);
});

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const reply = (body, type, status = 200) =>
  new Response(body, { status, headers: { 'content-type': type } });

test('loadStill: a plain proxy still becomes a blob: URL', async () => {
  const asked = [];
  const fetchImpl = async (url, init) => {
    asked.push([url, init.headers.accept]);
    return reply(JPEG, 'image/jpeg');
  };
  const s = await loadStill({ url: 'https://p/feed/tfl-img/1.jpg' }, { fetchImpl });
  assert.deepEqual(asked, [['https://p/feed/tfl-img/1.jpg', 'image/*']]);
  assert.match(s.url, /^blob:/);
  assert.equal(s.blob.type, 'image/jpeg');
  assert.deepEqual(new Uint8Array(await s.blob.arrayBuffer()), JPEG);
  s.revoke();
  s.revoke(); // idempotent
});

test('loadStill: a TxDOT JSON snapshot is decoded to a JPEG blob', async () => {
  const snippet = Buffer.from(JPEG).toString('base64');
  const fetchImpl = async () => reply(JSON.stringify({ snippet }), 'application/json');
  const s = await loadStill(
    { url: 'https://p/feed/txdot-img/x', format: 'json-base64-jpeg', field: 'snippet' },
    { fetchImpl },
  );
  assert.equal(s.blob.type, 'image/jpeg');
  assert.deepEqual(new Uint8Array(await s.blob.arrayBuffer()), JPEG);
  s.revoke();
});

test('loadStill: refuses errors, non-images, bad snapshots and unknown formats', async () => {
  const f = (body, type, status) => async () => reply(body, type, status);
  await assert.rejects(loadStill(null), /no still/);
  await assert.rejects(
    loadStill({ url: 'u' }, { fetchImpl: f('x', 'image/jpeg', 502) }),
    /HTTP 502/,
  );
  await assert.rejects(
    loadStill({ url: 'u' }, { fetchImpl: f('<html>', 'text/html') }),
    /not an image/,
  );
  await assert.rejects(
    loadStill(
      { url: 'u', format: 'json-base64-jpeg' },
      { fetchImpl: f('{"error":"x"}', 'application/json') },
    ),
    /no JPEG/,
  );
  await assert.rejects(loadStill({ url: 'u', format: 'mjpeg' }), /unknown still format/);
});
