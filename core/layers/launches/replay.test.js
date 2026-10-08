import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLaunchDetail, launchDetailPath, parseIsoDuration } from './parse.js';
import {
  REPLAY,
  REPLAY_LABEL,
  ORBIT_ALTITUDE_M,
  insertionOffsetSeconds,
  orbitAltitudeM,
  orbitPeriodSeconds,
  launchAzimuthDeg,
  estimatedOrbitPath,
  reconstructedAscentPath,
  pathLengthM,
  nearestIndex,
  rotateRing,
  samplePath,
  ascentReplaySeconds,
  normalizeReplaySpeed,
  replaySchedule,
  replayStartAfterPause,
  rebaseForSpeed,
  replayState,
  formatMissionClock,
  buildReplay,
} from './replay.js';

const ID = 'f059f0e5-7b8e-4e5a-a0d7-8f1c3c5e2a10';
const detail = (extra = {}) => ({
  id: ID,
  name: 'Falcon 9 Block 5 | Starlink Group 10-1',
  net: '2026-10-01T12:00:00Z',
  status: { name: 'Launch Successful', abbrev: 'Success' },
  launch_service_provider: { name: 'SpaceX' },
  rocket: { configuration: { full_name: 'Falcon 9 Block 5' } },
  mission: {
    name: 'Starlink Group 10-1',
    orbit: { name: 'Low Earth Orbit', abbrev: 'LEO' },
  },
  pad: { name: 'SLC-40', latitude: '28.5618571', longitude: '-80.577366' },
  timeline: [
    { type: { abbrev: 'Liftoff' }, relative_time: 'PT0S' },
    { type: { abbrev: 'MECO' }, relative_time: 'PT2M28S' },
    { type: { abbrev: 'SECO-1' }, relative_time: 'PT8M47S' },
    { type: { abbrev: 'Payload Deploy' }, relative_time: 'PT1H2M' },
    { type: { abbrev: 'Prop load' }, relative_time: '-PT35M' },
    { type: { abbrev: 'junk' }, relative_time: 'soon' },
  ],
  ...extra,
});

test('detail path and ISO durations', () => {
  assert.equal(launchDetailPath(ID), `/launches/${ID}/`);
  assert.equal(launchDetailPath('../agencies'), null);
  assert.equal(parseIsoDuration('PT8M47S'), 527);
  assert.equal(parseIsoDuration('-PT35M'), -2100);
  assert.equal(parseIsoDuration('P1DT2H'), 93600);
  assert.equal(parseIsoDuration('PT1.5S'), 1.5);
  assert.equal(parseIsoDuration('P'), null);
  assert.equal(parseIsoDuration(null), null);
});

test('parses one launch in detail: pad, orbit, sorted timeline, failure flag', () => {
  const l = parseLaunchDetail(detail());
  assert.equal(l.id, ID);
  assert.equal(l.orbit, 'Low Earth Orbit');
  assert.ok(Math.abs(l.pad.latitude - 28.5619) < 1e-3);
  assert.deepEqual(
    l.timeline.map((e) => e.name),
    ['Prop load', 'Liftoff', 'MECO', 'SECO-1', 'Payload Deploy'],
  );
  assert.equal(l.failed, false);
  assert.equal(
    parseLaunchDetail(detail({ status: { name: 'Launch Failure', abbrev: 'Failure' } }))
      .failed,
    true,
  );
  assert.equal(parseLaunchDetail(null), null);
});

test('insertion offset: deploy beats SECO beats the latest event', () => {
  const t = parseLaunchDetail(detail()).timeline;
  assert.equal(insertionOffsetSeconds(t), 3720);
  assert.equal(insertionOffsetSeconds(t.filter((e) => e.name !== 'Payload Deploy')), 527);
  assert.equal(insertionOffsetSeconds([{ name: 'MECO', offsetSeconds: 150 }]), 150);
  assert.equal(
    insertionOffsetSeconds([{ name: 'Payload Sep', relative_time: 'PT9M' }]),
    540,
  );
  assert.equal(insertionOffsetSeconds([{ name: 'Prop load', offsetSeconds: -60 }]), null);
  assert.equal(insertionOffsetSeconds(null), null);
});

test('orbit altitude, period and launch azimuth by orbit name and pad', () => {
  assert.equal(orbitAltitudeM('Low Earth Orbit'), ORBIT_ALTITUDE_M.LEO);
  assert.equal(orbitAltitudeM('Medium Earth Orbit'), ORBIT_ALTITUDE_M.MEO);
  assert.equal(orbitAltitudeM('Geostationary Transfer Orbit'), ORBIT_ALTITUDE_M.GEO);
  assert.equal(orbitAltitudeM('Suborbital'), null);
  assert.equal(orbitAltitudeM(null), null);
  assert.ok(Math.abs(orbitPeriodSeconds(ORBIT_ALTITUDE_M.GEO) - 86164) < 60); // a sidereal day
  assert.ok(Math.abs(orbitPeriodSeconds(550_000) / 60 - 95.6) < 0.5);
  assert.equal(
    launchAzimuthDeg({ latitude: 28.5, longitude: -80.6, orbitName: 'LEO' }),
    90,
  );
  assert.equal(
    launchAzimuthDeg({ latitude: 34.6, longitude: -120.6, orbitName: 'LEO' }),
    190,
  );
  assert.equal(
    launchAzimuthDeg({
      latitude: 34.6,
      longitude: -120.6,
      orbitName: 'Sun-Synchronous Orbit',
    }),
    180,
  );
  assert.equal(
    launchAzimuthDeg({ latitude: -39.3, longitude: 177.9, orbitName: 'Polar Orbit' }),
    0,
  );
});

test('the estimated orbit is a closed ring at altitude, starting downrange of the pad', () => {
  const pad = { latitude: 28.56, longitude: -80.58 };
  const est = estimatedOrbitPath({ ...pad, orbitName: 'Low Earth Orbit' });
  assert.equal(est.points.length, 97);
  assert.deepEqual(est.points[0], est.points.at(-1));
  assert.ok(est.points.every((p) => p.altitude === 550_000));
  // Insertion is ~12 deg due east of the pad.
  const ins = est.points[0];
  assert.ok(Math.abs(ins.latitude - pad.latitude) < 1.5, `lat ${ins.latitude}`);
  assert.ok(ins.longitude - pad.longitude > 10 && ins.longitude - pad.longitude < 15);
  // A launch due east from 28.6 N makes an orbit inclined ~28.6 deg.
  const maxLat = Math.max(...est.points.map((p) => p.latitude));
  assert.ok(Math.abs(maxLat - 28.6) < 1.5, `max lat ${maxLat}`);
  assert.equal(estimatedOrbitPath({ ...pad, orbitName: 'Suborbital' }), null);
});

test('the reconstructed ascent climbs from the pad to the insertion point', () => {
  const pad = { latitude: 28.56, longitude: -80.58, altitude: 0 };
  const ins = { latitude: 29.5, longitude: -68.5, altitude: 550_000 };
  const path = reconstructedAscentPath(pad, ins, 128);
  assert.equal(path.length, 129);
  assert.deepEqual(path[0], pad);
  assert.deepEqual(path.at(-1), ins);
  // Near-vertical liftoff: half way through, most of the climb is done but
  // under a fifth of the downrange distance (Earth-rotation lead included).
  const mid = path[64];
  assert.ok(mid.altitude > 0.65 * 550_000);
  const downrange = (mid.longitude - pad.longitude) / (ins.longitude - pad.longitude);
  assert.ok(downrange > 0 && downrange < 0.2, `mid downrange ${downrange}`);
  for (let i = 1; i < path.length; i++)
    assert.ok(path[i].altitude >= path[i - 1].altitude);
  assert.ok(pathLengthM(path) > 550_000);
});

test('paths: nearest point, rotation, sampling by length', () => {
  const ring = estimatedOrbitPath({ latitude: 0, longitude: 0, orbitName: 'LEO' }).points;
  const k = nearestIndex(ring, ring[30]);
  assert.equal(k, 30);
  const r = rotateRing(ring, 30);
  assert.equal(r.length, ring.length);
  assert.deepEqual(r[0], ring[30]);
  assert.deepEqual(r.at(-1), r[0]);
  const line = [
    { longitude: 179, latitude: 0, altitude: 0 },
    { longitude: -179, latitude: 0, altitude: 1000 },
  ];
  const half = samplePath(line, 0.5);
  assert.ok(
    Math.abs(Math.abs(half.longitude) - 180) < 1e-6,
    `crosses the antimeridian: ${half.longitude}`,
  );
  assert.equal(half.altitude, 500);
  assert.deepEqual(samplePath(line, 2), line[1]);
  assert.equal(samplePath([], 0.5), null);
});

test('replay timing: ascent clamps, speed snapping, pause and speed rebasing', () => {
  assert.equal(ascentReplaySeconds(600), 12);
  assert.equal(ascentReplaySeconds(120), REPLAY.ascentMinSec);
  assert.equal(ascentReplaySeconds(7200), REPLAY.ascentMaxSec);
  // No timeline: estimated from the path at ~9 km/s (300 s real -> 6 s -> clamped to 8).
  assert.equal(ascentReplaySeconds(null, 9000 * 300), REPLAY.ascentMinSec);
  assert.equal(ascentReplaySeconds(null, 9000 * 1500), 30);
  assert.equal(ascentReplaySeconds(null, 0), 12);
  assert.equal(normalizeReplaySpeed(3.1), 3);
  assert.equal(normalizeReplaySpeed(10), 4);
  assert.equal(normalizeReplaySpeed(0), 0.25);
  assert.equal(normalizeReplaySpeed('x'), 1);
  const sched = replaySchedule(1000);
  assert.deepEqual(sched, { countdownAt: 6000, liftoffAt: 16000 });
  assert.equal(replayStartAfterPause(16000, 20000, 25000), 21000);
  assert.equal(replayStartAfterPause(16000, NaN, 25000), 16000);
  // At 2x for 10 s = 20 s of replay; switching to 1x keeps those 20 s.
  const start = rebaseForSpeed(0, 10_000, 2, 1);
  assert.equal(start, -10_000);
  assert.equal(rebaseForSpeed(50, 10, 2, 1), 50); // not started yet
});

test('replay state: settle, countdown, ascent, orbit, looping, mission clock', () => {
  const base = {
    liftoffAt: 100_000,
    ascentSec: 12,
    orbitSec: 28,
    orbitPeriodSec: 5700,
    insertionOffsetSec: 540,
    launchEpochMs: Date.parse('2026-10-01T12:00:00Z'),
  };
  assert.equal(replayState({ ...base, nowMs: 85_000 }).phase, 'settle');
  const cd = replayState({ ...base, nowMs: 96_500 });
  assert.equal(cd.phase, 'countdown');
  assert.equal(cd.countdownSeconds, 4);
  const asc = replayState({ ...base, nowMs: 106_000 });
  assert.equal(asc.phase, 'ascent');
  assert.equal(asc.progress, 0.5);
  assert.equal(asc.missionOffsetSec, 270);
  assert.equal(asc.eventTimeMs, base.launchEpochMs + 270_000);
  const orb = replayState({ ...base, nowMs: 100_000 + 26_000 });
  assert.equal(orb.phase, 'orbit');
  assert.equal(orb.progress, 0.5);
  assert.equal(orb.missionOffsetSec, 540 + 2850);
  // Looping wraps back to the ascent; without loop it holds at the end.
  assert.equal(replayState({ ...base, nowMs: 100_000 + 41_000 }).phase, 'ascent');
  const held = replayState({ ...base, nowMs: 100_000 + 99_000, loop: false });
  assert.equal(held.phase, 'orbit');
  assert.ok(held.progress > 0.999);
  // Speed doubles the run.
  assert.equal(replayState({ ...base, nowMs: 103_000, speed: 2 }).progress, 0.5);
  // No timeline: no mission clock.
  assert.equal(
    replayState({ ...base, insertionOffsetSec: null, nowMs: 106_000 }).eventTimeMs,
    null,
  );
  assert.equal(formatMissionClock(527), 'T+08:47');
  assert.equal(formatMissionClock(-5), 'T-00:05');
  assert.equal(formatMissionClock(3730), 'T+1:02:10');
  assert.equal(formatMissionClock(NaN), 'T+--:--');
});

test('buildReplay labels the estimate; failed and suborbital launches get none', () => {
  const r = buildReplay(parseLaunchDetail(detail()));
  assert.equal(r.ok, true);
  assert.equal(r.estimate, true);
  assert.equal(r.label, REPLAY_LABEL);
  assert.equal(r.label, 'RECONSTRUCTED ESTIMATE');
  assert.deepEqual(r.ascent.at(-1), r.orbit[0]);
  assert.equal(r.insertionOffsetSec, 3720);
  assert.equal(r.ascentSec, REPLAY.ascentMaxSec);
  assert.equal(r.orbitSec, 28);
  const failed = buildReplay(
    parseLaunchDetail(detail({ status: { abbrev: 'Failure', name: 'Launch Failure' } })),
  );
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /failed/);
  const sub = buildReplay(
    parseLaunchDetail(
      detail({ mission: { name: 'Hop', orbit: { name: 'Suborbital' } } }),
    ),
  );
  assert.equal(sub.ok, false);
  assert.equal(buildReplay(parseLaunchDetail(detail({ pad: { name: 'x' } }))).ok, false);
  assert.equal(buildReplay(null).ok, false);
  // A supplied real orbit is joined at the point nearest the estimated insertion.
  const real = estimatedOrbitPath({
    latitude: 0,
    longitude: -60,
    orbitName: 'LEO',
  }).points.map((p) => ({
    ...p,
    altitude: 420_000,
  }));
  const joined = buildReplay(parseLaunchDetail(detail()), { orbitPath: real });
  assert.equal(joined.orbitAltitudeM, 420_000);
  assert.deepEqual(joined.ascent.at(-1), joined.orbit[0]);
});
