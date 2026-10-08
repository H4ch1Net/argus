import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConstellationSource, mergeGroups, groupInfo } from './groups.js';

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
  assert.equal(asked.length, 4);
  assert.ok(asked.every((a) => a.startsWith('celestrak/gp.php?')));
  assert.deepEqual(
    out.map((r) => r.group),
    ['gps-ops', 'galileo', 'geo'],
  );

  const down = { getText: async () => Promise.reject(new Error('offline')) };
  await assert.rejects(createConstellationSource({ proxyClient: down })({}), /offline/);
});
