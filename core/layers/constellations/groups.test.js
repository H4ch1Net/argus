import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createConstellationSource,
  mergeGroups,
  groupInfo,
  constellationGroups,
  denseAllowedForTier,
  STARLINK_DENSE,
  CONSTELLATION_GROUPS,
} from './groups.js';
import { INK } from '../../ui/palette.js';

// A stand-in for tleToNormalized: one entity per "id" line.
const fake = (text) =>
  text
    .split(',')
    .map((id) => ({ id, type: 'satellite', position: {}, meta: { name: `S${id}` } }));

test('merges groups in priority order, first group wins a shared satellite', () => {
  const out = mergeGroups(
    [
      { group: 'geo', text: '9,1' },
      { group: 'gps-ops', text: '1,2' },
    ],
    fake,
  );
  assert.deepEqual(
    out.map((n) => [n.id, n.meta.groupLabel]),
    [
      ['1', 'GPS'],
      ['2', 'GPS'],
      ['9', 'Geostationary'],
    ],
  );
  assert.equal(groupInfo('unknown').label, 'unknown');
});

test('the visual group loses to specific groups and never redraws a station', () => {
  const out = mergeGroups(
    [
      { group: 'visual', text: '25544,7,8' },
      { group: 'gps-ops', text: '7' },
    ],
    fake,
  );
  assert.deepEqual(
    out.map((n) => [n.id, n.meta.klass, n.meta.classLabel]),
    [
      ['7', 'nav', 'NAV · GPS'],
      ['8', 'visual', 'VISUAL'],
    ],
  );
  assert.ok(out.every((n) => n.meta.dense === false));
});

test('dense mode adds Starlink last, as small COMMS points', () => {
  const out = mergeGroups(
    [
      { group: 'starlink', text: '50000,7' },
      { group: 'geo', text: '7' },
    ],
    fake,
  );
  assert.deepEqual(
    out.map((n) => [n.id, n.meta.group, n.meta.dense]),
    [
      ['7', 'geo', false],
      ['50000', 'starlink', true],
    ],
  );
  assert.equal(out[1].meta.classLabel, 'COMMS · Starlink');
  assert.equal(groupInfo('starlink').color, INK.slate);
});

test('dense mode is gated to the full tier only (never a phone)', () => {
  assert.equal(STARLINK_DENSE.defaultOn, false);
  assert.equal(denseAllowedForTier('full'), true);
  assert.equal(denseAllowedForTier('balanced'), false);
  assert.equal(denseAllowedForTier('minimal'), false);
  assert.equal(denseAllowedForTier(undefined), false);
  assert.equal(constellationGroups().length, CONSTELLATION_GROUPS.length);
  assert.equal(constellationGroups({ dense: true }).at(-1).group, 'starlink');
});

test('every group colour is a palette ink', () => {
  const inks = new Set(Object.values(INK));
  for (const g of constellationGroups({ dense: true }))
    assert.ok(inks.has(g.color), g.group);
});

test('the source asks CelesTrak for each group and survives one failure', async () => {
  const asked = [];
  const proxyClient = {
    async getText(feed, path, { params }) {
      asked.push(`${feed}${path}?${params.GROUP}`);
      if (params.GROUP === 'glo-ops') throw new Error('proxy celestrak responded 403');
      return `tle-${params.GROUP}`;
    },
  };
  const out = await createConstellationSource({ proxyClient })({});
  assert.equal(asked.length, 5);
  assert.ok(asked.every((a) => a.startsWith('celestrak/gp.php?')));
  assert.deepEqual(
    out.map((r) => r.group),
    ['gps-ops', 'galileo', 'geo', 'visual'],
  );

  const down = { getText: async () => Promise.reject(new Error('offline')) };
  await assert.rejects(createConstellationSource({ proxyClient: down })({}), /offline/);
});

test('the dense flag is read on every fetch', async () => {
  let dense = false;
  const asked = [];
  const proxyClient = {
    async getText(_f, _p, { params }) {
      asked.push(params.GROUP);
      return '';
    },
  };
  const source = createConstellationSource({ proxyClient, dense: () => dense });
  await source({});
  assert.equal(asked.includes('starlink'), false);
  dense = true;
  asked.length = 0;
  await source({});
  assert.equal(asked.includes('starlink'), true);
});
