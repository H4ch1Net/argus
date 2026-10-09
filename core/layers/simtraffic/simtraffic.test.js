import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  BANDS,
  bandFor,
  buildNetwork,
  classesFor,
  keepsLeft,
  mergeWays,
  overpassRoadQuery,
  parseMaxspeed,
  parseRoadWays,
  pointAt,
  tilesAround,
} from './roads.js';
import { createSimulation, mulberry32 } from './sim.js';
import {
  congestionLevel,
  flowForNetwork,
  flowQuery,
  flowSegmentPath,
  formatFlowReadout,
  matchSegment,
  parseFlowSegment,
  planFlowSamples,
} from './flow.js';
import { createTrafficModel } from './source.js';
import { demoFlowSegment, demoGridWays } from './mockSource.js';
import { roadLineStyle, simTrafficNote } from './format.js';

// A real Overpass answer: San Francisco around Market St and Van Ness Ave,
// motorway..residential with tags and geometry, fetched 2026-10-09 from the
// maps.mail.ru Overpass mirror and trimmed to the tags the layer reads.
const SF = JSON.parse(
  fs.readFileSync(new URL('./fixtures/overpass-sf.json', import.meta.url), 'utf8'),
);
const ORIGIN = { lat: 37.774, lon: -122.4175 };

// TomTom flowSegmentData, the documented response shape (Traffic API v4).
const TOMTOM_SEGMENT = {
  flowSegmentData: {
    frc: 'FRC2',
    currentSpeed: 21,
    freeFlowSpeed: 42,
    currentTravelTime: 120,
    freeFlowTravelTime: 60,
    confidence: 0.92,
    roadClosure: false,
    coordinates: {
      coordinate: [
        { latitude: 37.7728764, longitude: -122.4204203 },
        { latitude: 37.7723768, longitude: -122.4210569 },
      ],
    },
    '@version': 'traffic-service-flow 1.0.120',
  },
};

// --- roads -----------------------------------------------------------------

test('maxspeed parses km/h and mph, refuses junk', () => {
  assert.equal(parseMaxspeed('50'), 50);
  assert.ok(Math.abs(parseMaxspeed('25 mph') - 40.23) < 0.01);
  assert.equal(parseMaxspeed('30 km/h'), 30);
  assert.equal(parseMaxspeed('walk'), null);
  assert.equal(parseMaxspeed('none'), null);
  assert.equal(parseMaxspeed(undefined), null);
});

test('bands: fewer road classes higher up, nothing above 8 km', () => {
  assert.equal(bandFor(300).id, 'street');
  assert.equal(bandFor(3000).id, 'district');
  assert.equal(bandFor(7999).id, 'city');
  assert.equal(bandFor(8000), null);
  assert.ok(classesFor(BANDS[0]).includes('residential'));
  assert.ok(!classesFor(BANDS[2]).includes('residential'));
  assert.ok(classesFor(BANDS[2]).includes('motorway'));
});

test('tiles around a focus: nearest first, capped, keyed by band', () => {
  const t = tilesAround(BANDS[0], ORIGIN, 1500, 9);
  assert.equal(t.length, 9);
  assert.ok(t[0].dist <= t[8].dist);
  assert.match(t[0].key, /^street\/-?\d+\/-?\d+$/);
  assert.ok(t[0].lamin <= ORIGIN.lat && ORIGIN.lat <= t[0].lamax);
  const q = overpassRoadQuery(BANDS[1], t[0]);
  assert.match(q, /^\[out:json\]\[timeout:25\];way\["highway"~"\^\(motorway\|/);
  assert.match(q, /out tags geom qt 1500;$/);
  assert.doesNotMatch(q, /residential/);
});

test('parses the real Overpass sample: classes, speeds, lanes, one-way', () => {
  const ways = parseRoadWays(SF);
  assert.equal(ways.length, SF.elements.length);
  const colton = ways.find((w) => w.id === 8915986);
  assert.equal(colton.cls, 'residential');
  assert.equal(colton.oneway, 1);
  assert.equal(colton.coords.length, 4);
  assert.deepEqual(colton.coords[0], [-122.4204203, 37.7728764]);
  const tagged = ways.find((w) => w.maxspeedTagged);
  assert.ok(
    Math.abs(tagged.freeKmh - 40.23) < 0.01 || Math.abs(tagged.freeKmh - 32.19) < 0.01,
  );
  const untagged = ways.find((w) => !w.maxspeedTagged && w.cls === 'secondary');
  if (untagged) assert.equal(untagged.freeKmh, 50);
  assert.ok(ways.some((w) => w.lanes === 3));
  // Unknown classes and broken geometry are skipped.
  assert.deepEqual(
    parseRoadWays({
      elements: [
        {
          type: 'way',
          id: 1,
          tags: { highway: 'footway' },
          geometry: [
            { lat: 0, lon: 0 },
            { lat: 1, lon: 1 },
          ],
        },
        {
          type: 'way',
          id: 2,
          tags: { highway: 'primary' },
          geometry: [{ lat: 0, lon: 0 }],
        },
        { type: 'node', id: 3 },
      ],
    }),
    [],
  );
});

test('the network splits ways at shared vertices and links them', () => {
  const ways = parseRoadWays(SF);
  const net = buildNetwork(ways, ORIGIN);
  assert.ok(net.edges.length > ways.length, 'ways are split at junctions');
  assert.ok(net.edges.every((e) => e.lengthM > 1 && e.from >= 0 && e.to >= 0));
  // Real junctions: several nodes with three or more directed exits.
  const busy = net.out.filter((o) => o.length >= 3).length;
  assert.ok(busy > 10, `junctions with 3+ exits: ${busy}`);
  // One-way edges have lanes in one direction only.
  const ow = net.edges.find((e) => e.oneway === 1);
  assert.equal(ow.lanesBack, 0);
  assert.ok(ow.lanesFwd >= 1);
  assert.ok(net.laneKm > 10);
  // Points along an edge stay on it.
  const e = net.edges[0];
  const p = pointAt(e, e.lengthM / 2, 0, { lon: 0, lat: 0, seg: 0, f: 0 });
  assert.ok(Math.abs(p.lon - e.midLon) < 1e-9 && Math.abs(p.lat - e.midLat) < 1e-9);
});

test('ways from overlapping tiles merge once', () => {
  const ways = parseRoadWays(SF);
  assert.equal(mergeWays([ways, ways.slice(0, 10)]).length, ways.length);
});

test('driving side', () => {
  assert.equal(keepsLeft(51.5, -0.12), true);
  assert.equal(keepsLeft(35.68, 139.69), true);
  assert.equal(keepsLeft(37.77, -122.42), false);
  assert.equal(keepsLeft(52.52, 13.4), false);
});

// --- simulation -------------------------------------------------------------

function sfSim({ cap = 400, seed = 7 } = {}) {
  const net = buildNetwork(parseRoadWays(SF), ORIGIN);
  const sim = createSimulation({ cap, seed });
  sim.setNetwork(net, { focus: ORIGIN, radiusM: 1200, seed });
  return { net, sim };
}

test('the fleet scales with road length and respects the cap', () => {
  const { net, sim } = sfSim({ cap: 1500 });
  assert.ok(sim.count > 50, `vehicles: ${sim.count}`);
  assert.ok(sim.count <= 1500);
  const small = createSimulation({ cap: 150, seed: 7 });
  small.setNetwork(net, { focus: ORIGIN, radiusM: 1200 });
  assert.equal(small.count, 150);
});

test('vehicles never overlap in a lane and stay at sane speeds', () => {
  const { sim } = sfSim({ cap: 600 });
  for (let k = 0; k < 600; k += 1) sim.step(1 / 12);
  const { queues } = sim._lanes();
  for (const q of queues) {
    for (let i = 1; i < q.length; i += 1) {
      const a = sim._state(q[i - 1]);
      const b = sim._state(q[i]);
      assert.ok(a.s - b.s >= 4.5 - 1e-3, `gap ${a.s - b.s}`);
    }
  }
  for (let i = 0; i < sim.count; i += 1) {
    const e = sim.edgeOf(i);
    assert.ok(sim.speed[i] >= 0);
    assert.ok(sim.speed[i] <= (e.freeKmh / 3.6) * 1.2 + 0.5, `speed ${sim.speed[i]}`);
  }
});

test('vehicles move along the roads', () => {
  const { sim } = sfSim({ cap: 200 });
  sim.computePositions();
  const before = Array.from(sim.lon.slice(0, sim.count));
  for (let k = 0; k < 60; k += 1) sim.step(1 / 12);
  const n = sim.computePositions();
  let moved = 0;
  for (let i = 0; i < n; i += 1) if (Math.abs(sim.lon[i] - before[i]) > 1e-6) moved += 1;
  assert.ok(moved > n / 2, `moved ${moved} of ${n}`);
  // Every vehicle sits within a lane width or two of its road.
  for (let i = 0; i < n; i += 1) {
    const e = sim.edgeOf(i);
    let best = Infinity;
    for (let k = 0; k < e.coords.length; k += 2) {
      const dx = (sim.lon[i] - e.coords[k]) * 88_000;
      const dy = (sim.lat[i] - e.coords[k + 1]) * 110_540;
      best = Math.min(best, Math.hypot(dx, dy));
    }
    // Distance to the nearest vertex is bounded by the edge length plus the offset.
    assert.ok(best <= e.lengthM / 2 + 20, `off road by ${best}`);
    assert.ok(Number.isFinite(sim.heading[i]));
  }
});

test('congestion slows the fleet down', () => {
  const free = sfSim({ cap: 300, seed: 3 }).sim;
  const jam = sfSim({ cap: 300, seed: 3 }).sim;
  jam.setFlow(() => ({ ratio: 0.25 }));
  for (let k = 0; k < 360; k += 1) {
    free.step(1 / 12);
    jam.step(1 / 12);
  }
  const mean = (s) => {
    let t = 0;
    for (let i = 0; i < s.count; i += 1) t += s.speed[i];
    return t / s.count;
  };
  assert.ok(mean(jam) < mean(free) * 0.6, `${mean(jam)} vs ${mean(free)}`);
});

test('the same seed and network give the same fleet', () => {
  const a = sfSim({ seed: 42 }).sim;
  const b = sfSim({ seed: 42 }).sim;
  for (let k = 0; k < 100; k += 1) {
    a.step(0.1);
    b.step(0.1);
  }
  a.computePositions();
  b.computePositions();
  assert.equal(a.count, b.count);
  for (let i = 0; i < a.count; i += 1) {
    assert.equal(a.lon[i], b.lon[i]);
    assert.equal(a.lat[i], b.lat[i]);
  }
  const r = mulberry32(1);
  const x = r();
  assert.ok(x >= 0 && x < 1);
});

test('a new network keeps vehicles on surviving lanes', () => {
  const { net, sim } = sfSim({ cap: 300 });
  for (let k = 0; k < 24; k += 1) sim.step(1 / 12);
  sim.computePositions();
  const n0 = sim.count;
  sim.setNetwork(net, { focus: ORIGIN, radiusM: 1200 });
  assert.equal(sim.count, n0);
});

test('a long pause steps at most a second', () => {
  const { sim } = sfSim({ cap: 100 });
  sim.step(3600); // must return promptly and stay sane
  sim.computePositions();
  for (let i = 0; i < sim.count; i += 1) assert.ok(Number.isFinite(sim.lon[i]));
});

// --- flow ---------------------------------------------------------------------

test('parses TomTom flowSegmentData (documented shape)', () => {
  const s = parseFlowSegment(TOMTOM_SEGMENT);
  assert.equal(s.frc, 'FRC2');
  assert.equal(s.currentKmh, 21);
  assert.equal(s.freeKmh, 42);
  assert.equal(s.ratio, 0.5);
  assert.equal(s.closed, false);
  assert.equal(s.coords.length, 2);
  assert.deepEqual(s.coords[0], [-122.4204203, 37.7728764]);
  const closed = parseFlowSegment({
    flowSegmentData: { ...TOMTOM_SEGMENT.flowSegmentData, roadClosure: true },
  });
  assert.equal(closed.ratio, 0);
  assert.equal(congestionLevel(closed.ratio), 'closed');
  assert.equal(parseFlowSegment({}), null);
  assert.equal(parseFlowSegment({ flowSegmentData: { currentSpeed: 3 } }), null);
  assert.equal(formatFlowReadout(s), '21 / 42 KM/H (50%)');
  assert.equal(formatFlowReadout(s, 'imperial'), '13 / 26 MPH (50%)');
});

test('flow requests are pinned to a point and a zoom', () => {
  assert.equal(flowSegmentPath(0), '/flowSegmentData/absolute/12/json');
  assert.equal(flowSegmentPath(3), '/flowSegmentData/absolute/14/json');
  assert.equal(flowSegmentPath(6), '/flowSegmentData/absolute/16/json');
  assert.deepEqual(flowQuery(37.7740001, -122.41751), {
    point: '37.77400,-122.41751',
    unit: 'KMPH',
  });
});

test('sample plan: bigger roads first, spread out, within budget', () => {
  const net = buildNetwork(parseRoadWays(SF), ORIGIN);
  const plan = planFlowSamples(net, { focus: ORIGIN, radiusM: 1500, budget: 5 });
  assert.equal(plan.length, 5);
  assert.ok(plan.every((p) => p.rank <= 4));
  assert.ok(plan[0].rank <= plan[4].rank);
  for (let i = 0; i < plan.length; i += 1)
    for (let j = i + 1; j < plan.length; j += 1) {
      const d = Math.hypot(
        (plan[i].lat - plan[j].lat) * 110_540,
        (plan[i].lon - plan[j].lon) * 88_000,
      );
      assert.ok(d >= 290, `samples ${d} m apart`);
    }
  assert.deepEqual(planFlowSamples(net, { focus: ORIGIN, radiusM: 1500, budget: 0 }), []);
  // Covered roads are not sampled again.
  const none = planFlowSamples(net, {
    focus: ORIGIN,
    radiusM: 1500,
    budget: 5,
    covered: () => true,
  });
  assert.deepEqual(none, []);
});

test('a segment matches the edges it runs along, never cross streets', () => {
  const net = buildNetwork(parseRoadWays(SF), ORIGIN);
  const seg = parseFlowSegment(TOMTOM_SEGMENT); // Colton Street, way 8915986
  const hit = matchSegment(net, seg).map((i) => net.edges[i]);
  assert.ok(hit.length >= 1);
  assert.ok(
    hit.every((e) => e.wayId === 8915986),
    hit.map((e) => e.name).join(),
  );
  const flow = flowForNetwork(net, [{ seg, edges: hit.map((e) => e.index) }]);
  assert.equal(flow.measured, hit.length);
  const m = flow.byEdge.get(hit[0].id);
  assert.equal(m.measured, true);
  assert.equal(m.ratio, 0.5);
  // Other residential roads inherit the median, marked inferred.
  const other = net.edges.find((e) => e.rank === 6 && e.wayId !== 8915986);
  assert.equal(flow.byEdge.get(other.id).measured, false);
  // Big roads have no measurement in their group: nothing inferred for them.
  const trunk = net.edges.find((e) => e.cls === 'trunk');
  assert.equal(flow.byEdge.get(trunk.id), undefined);
});

test('road lines: congested roads only, small roads only when measured', () => {
  assert.equal(roadLineStyle({ rank: 2 }, null), null);
  assert.equal(roadLineStyle({ rank: 6 }, { ratio: 0.3, measured: false }), null);
  assert.equal(roadLineStyle({ rank: 6 }, { ratio: 0.3, measured: true }).level, 'jam');
  const a = roadLineStyle({ rank: 2 }, { ratio: 0.6, measured: false });
  assert.equal(a.level, 'slow');
  assert.ok(a.alpha < roadLineStyle({ rank: 2 }, { ratio: 0.6, measured: true }).alpha);
  assert.equal(
    roadLineStyle({ rank: 0 }, { ratio: 0.9, measured: true }).color,
    '#00fa9a',
  );
});

// --- the model -------------------------------------------------------------------

function fakeModel({ flow = true, failFlow = null } = {}) {
  const calls = { ways: 0, flow: 0 };
  const model = createTrafficModel({
    tier: 'minimal',
    fetchWays: async () => {
      calls.ways += 1;
      return SF;
    },
    fetchFlow: flow
      ? async (s) => {
          calls.flow += 1;
          if (failFlow) {
            const err = new Error('proxy tomtom-flowseg responded ' + failFlow);
            err.status = failFlow;
            throw err;
          }
          return demoFlowSegment(s);
        }
      : null,
  });
  return { model, calls };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

test('the model loads the roads around a view, caches tiles, samples flow', async () => {
  const { model, calls } = fakeModel();
  await model.update({ ...ORIGIN, heightM: 900 });
  await settle();
  assert.equal(model.active, true);
  assert.equal(model.band.id, 'street');
  assert.ok(model.network.edges.length > 50);
  assert.equal(calls.ways, 4); // minimal tier: four tiles
  assert.ok(calls.flow >= 1 && calls.flow <= 3); // minimal budget: three points
  assert.equal(model.flowState, 'live');
  assert.ok(model.measured >= 1);
  assert.match(model.note(), /^SIMULATED, TomTom flow at \d+ pts/);
  // Same view again: no new requests.
  await model.update({ ...ORIGIN, heightM: 900 });
  await settle();
  assert.equal(calls.ways, 4);
});

test('the model idles above 8 km and says why', async () => {
  const { model, calls } = fakeModel();
  await model.update({ ...ORIGIN, heightM: 20_000 });
  assert.equal(model.active, false);
  assert.equal(calls.ways, 0);
  assert.equal(model.note(), 'below 8 km only');
});

test('without a TomTom key the model runs free-flow and says SIMULATED', async () => {
  const { model, calls } = fakeModel({ flow: false });
  await model.update({ ...ORIGIN, heightM: 900 });
  await settle();
  assert.equal(calls.flow, 0);
  assert.equal(model.flowState, 'off');
  assert.equal(model.note(), 'SIMULATED, free-flow (no TomTom key)');
  const budget = fakeModel({ failFlow: 429 });
  await budget.model.update({ ...ORIGIN, heightM: 900 });
  await settle();
  assert.equal(budget.model.flowState, 'budget');
  assert.equal(budget.calls.flow, 1); // stops at the first refusal
  assert.match(
    simTrafficNote(budget.model, 12),
    /^12 veh, SIMULATED, TomTom budget spent/,
  );
});

// --- the demo grid ------------------------------------------------------------------

test('the demo grid connects across tiles and feeds the simulation', () => {
  const band = BANDS[0];
  const tiles = tilesAround(band, ORIGIN, 900, 4);
  const ways = mergeWays(tiles.map((t) => parseRoadWays(demoGridWays(band, t))));
  const net = buildNetwork(ways, ORIGIN);
  const junctions = net.out.filter((o) => o.length >= 3).length;
  assert.ok(junctions > 20);
  const sim = createSimulation({ cap: 150, seed: 1 });
  sim.setNetwork(net, { focus: ORIGIN, radiusM: 900 });
  for (let k = 0; k < 120; k += 1) sim.step(1 / 12);
  assert.equal(sim.count, 150);
});
