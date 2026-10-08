import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aircraftPath,
  callsignPath,
  isAirlineCallsign,
  parseAdsbdbAircraft,
  parseAdsbdbRoute,
  enrichKeys,
  createAdsbdbFetcher,
  enrichmentRows,
} from './enrich.js';
import { createEnrichQueue } from './enrichQueue.js';

// Shaped like adsbdb's answers, including the owner fields that must be dropped.
const AIRCRAFT = {
  response: {
    aircraft: {
      type: 'CRJ 200LR',
      icao_type: 'CRJ2',
      manufacturer: 'Bombardier',
      mode_s: 'A44F3B',
      registration: 'N37XXX',
      registered_owner_country_iso_name: 'US',
      registered_owner_country_name: 'United States',
      registered_owner_operator_flag_code: 'SKW',
      registered_owner: 'Jane Q Private',
      url_photo: 'https://example.invalid/photo.jpg',
      url_photo_thumbnail: 'https://example.invalid/thumb.jpg',
    },
  },
};
const airportOf = (iata, icao, name, city, lat, lon) => ({
  country_iso_name: 'CA',
  country_name: 'Canada',
  elevation: 100,
  iata_code: iata,
  icao_code: icao,
  latitude: lat,
  longitude: lon,
  municipality: city,
  name,
});
const ROUTE = {
  response: {
    flightroute: {
      callsign: 'ACA959',
      callsign_icao: 'ACA959',
      callsign_iata: 'AC959',
      airline: {
        name: 'Air Canada',
        icao: 'ACA',
        iata: 'AC',
        country: 'Canada',
        callsign: 'AIR CANADA',
      },
      origin: airportOf(
        'YUL',
        'CYUL',
        'Montreal Trudeau International',
        'Montreal',
        45.47,
        -73.74,
      ),
      destination: airportOf(
        'YYZ',
        'CYYZ',
        'Toronto Pearson International',
        'Toronto',
        43.68,
        -79.63,
      ),
    },
  },
};

test('lookup paths are pinned to addresses and callsigns', () => {
  assert.equal(aircraftPath('A44F3B'), '/v0/aircraft/a44f3b');
  assert.equal(aircraftPath('~a44f3b'), null);
  assert.equal(aircraftPath('a44f3'), null);
  assert.equal(callsignPath(' aca959 '), '/v0/callsign/ACA959');
  assert.equal(callsignPath('AC 959'), null);
  assert.equal(isAirlineCallsign('BAW123'), true);
  assert.equal(isAirlineCallsign('N123AB'), false);
  assert.deepEqual(enrichKeys({ id: 'a44f3b', callsign: 'ACA959 ' }), {
    aircraft: 'a:a44f3b',
    route: 'c:ACA959',
  });
  assert.deepEqual(enrichKeys({ id: '~a44f3b', callsign: 'N123AB' }), {
    aircraft: null,
    route: null,
  });
});

test('aircraft answers keep the type and registration and DROP every owner field', () => {
  const a = parseAdsbdbAircraft(AIRCRAFT);
  assert.deepEqual(a, {
    typeCode: 'CRJ2',
    icaoType: 'CRJ2',
    manufacturer: 'Bombardier',
    model: 'CRJ 200LR',
    typeName: 'Bombardier CRJ 200LR',
    registration: 'N37XXX',
  });
  const s = JSON.stringify(a);
  assert.equal(/owner/i.test(s), false);
  assert.equal(s.includes('Jane Q Private'), false);
  assert.equal(s.includes('SKW'), false);
  assert.equal(s.includes('photo'), false);
  assert.equal(parseAdsbdbAircraft({ response: 'unknown aircraft' }), null);
  assert.equal(parseAdsbdbAircraft(null), null);
});

test('route answers keep the airline name and the airports', () => {
  const r = parseAdsbdbRoute(ROUTE);
  assert.equal(r.airline, 'Air Canada');
  assert.equal(r.origin.iata, 'YUL');
  assert.equal(r.destination.icao, 'CYYZ');
  assert.equal(r.destination.latitude, 43.68);
  assert.equal(r.midpoint, null);
  assert.equal(parseAdsbdbRoute({ response: 'unknown callsign' }), null);
  const rows = enrichmentRows(
    { registration: 'N37XXX' },
    { aircraft: parseAdsbdbAircraft(AIRCRAFT), route: r },
  );
  assert.deepEqual(rows, [
    ['Aircraft', 'Bombardier CRJ 200LR'],
    ['Type', 'CRJ2'],
    ['Airline', 'Air Canada'],
    ['Route', 'YUL → YYZ'],
    ['Enrichment', 'adsbdb (route data: D. Taylor, J. Mason)'],
  ]);
  assert.deepEqual(enrichmentRows({}, {}), []);
});

test('the fetcher maps keys to adsbdb paths; a 404 is a miss, other errors throw', async () => {
  const asked = [];
  const client = {
    async getJson(feed, path) {
      asked.push(`${feed}${path}`);
      if (path.endsWith('ffffff')) {
        const e = new Error('proxy adsbdb responded 404');
        e.status = 404;
        throw e;
      }
      if (path.endsWith('eeeeee')) throw new Error('proxy adsbdb responded 429');
      return path.startsWith('/v0/aircraft/') ? AIRCRAFT : ROUTE;
    },
  };
  const f = createAdsbdbFetcher(client);
  assert.equal((await f('a:a44f3b')).typeCode, 'CRJ2');
  assert.equal((await f('c:ACA959')).airline, 'Air Canada');
  assert.equal(await f('a:ffffff'), null);
  await assert.rejects(f('a:eeeeee'), /429/);
  assert.equal(await f('x:junk'), null);
  assert.deepEqual(asked, [
    'adsbdb/v0/aircraft/a44f3b',
    'adsbdb/v0/callsign/ACA959',
    'adsbdb/v0/aircraft/ffffff',
    'adsbdb/v0/aircraft/eeeeee',
  ]);
});

// --- the queue -------------------------------------------------------------

const tick = () => new Promise((r) => setImmediate(r));

function deferredFetch() {
  const calls = [];
  const fetch = (key) =>
    new Promise((resolve, reject) => {
      calls.push({ key, resolve, reject });
    });
  return { calls, fetch };
}

test('at most 4 in flight, nearest first, priority jumps the queue', async () => {
  const { calls, fetch } = deferredFetch();
  const q = createEnrichQueue({ fetch, minGapMs: 0 });
  const results = {};
  const ask = (key, o) => q.request(key, o).then((v) => (results[key] = v));
  ask('far', { distance: 900 });
  ask('mid', { distance: 500 });
  ask('near', { distance: 10 });
  ask('nearer', { distance: 5 });
  ask('nearest', { distance: 1 });
  ask('tracked', { distance: 5000, priority: true });
  await tick();
  // The first dispatch happened synchronously on the first request ('far');
  // the rest are picked by rank as slots free up.
  assert.equal(calls.length, 4);
  assert.deepEqual(
    calls.map((c) => c.key),
    ['far', 'mid', 'near', 'nearer'],
  );
  assert.equal(q.stats.active, 4);
  calls[0].resolve({ ok: 1 });
  await tick();
  assert.equal(calls[4].key, 'tracked');
  calls[1].resolve(null);
  await tick();
  assert.equal(calls[5].key, 'nearest');
  assert.deepEqual(results.far, { ok: 1 });
  assert.equal(results.mid, null);
});

test('answers and misses are cached; failures are not; duplicates share one request', async () => {
  let t = 0;
  const { calls, fetch } = deferredFetch();
  const q = createEnrichQueue({ fetch, minGapMs: 0, ttlMs: 1000, now: () => t });
  const a1 = q.request('a');
  const a2 = q.request('a');
  assert.equal(a1, a2);
  await tick();
  calls[0].resolve(null); // a known miss
  assert.equal(await a1, null);
  assert.deepEqual(q.peek('a'), { value: null });
  assert.equal(await q.request('a'), null);
  assert.equal(calls.length, 1); // the miss was cached
  q.request('b');
  await tick();
  calls[1].reject(new Error('503'));
  await tick();
  assert.equal(q.peek('b'), undefined); // failure: not cached
  q.request('b');
  await tick();
  assert.equal(calls.length, 3); // asked again
  t = 2000; // past the TTL
  assert.equal(q.peek('a'), undefined);
});

test('dispatches are dripped by minGapMs', async () => {
  let t = 0;
  const timers = [];
  const { calls, fetch } = deferredFetch();
  const q = createEnrichQueue({
    fetch,
    minGapMs: 200,
    now: () => t,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
  });
  q.request('a');
  q.request('b');
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 200);
  t = 200;
  timers[0].fn();
  await tick();
  assert.equal(calls.length, 2);
});

test('clear drops the waiting requests and aborts the ones in flight', async () => {
  const seen = [];
  const q = createEnrichQueue({
    minGapMs: 0,
    concurrency: 1,
    fetch: (key, signal) =>
      new Promise((resolve, reject) => {
        seen.push(key);
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  });
  const a = q.request('a');
  const b = q.request('b');
  await tick();
  q.clear();
  assert.equal(await a, null);
  assert.equal(await b, null);
  assert.deepEqual(seen, ['a']);
  await tick();
  assert.deepEqual(q.stats, { queued: 0, active: 0, cached: 0 });
});

test('distanceOf follows the camera at dispatch time', async () => {
  const { calls, fetch } = deferredFetch();
  const dist = { x: 1, y: 2, z: 3 };
  const q = createEnrichQueue({
    fetch,
    minGapMs: 0,
    concurrency: 1,
    distanceOf: (k) => dist[k],
  });
  q.request('x');
  q.request('y');
  q.request('z');
  await tick();
  dist.z = 0; // the camera moved: z is now nearest
  calls[0].resolve(1);
  await tick();
  assert.equal(calls[1].key, 'z');
});
