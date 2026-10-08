import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CREDITS,
  GROUP_LABELS,
  creditById,
  creditsForLayer,
  creditsByLayer,
  creditsForFeed,
  creditsForHost,
  creditText,
} from './credits.js';

const root = new URL('../', import.meta.url);

// The live feed registry, read at test time: proxy/feeds.js plus every area
// module in proxy/feeds/ (including ones not yet spread into the registry), so
// a feed added by anyone, under any id, must come with a credit.
async function allFeeds() {
  const byId = new Map();
  const { feeds } = await import(new URL('proxy/feeds.js', root));
  for (const f of feeds) byId.set(f.id, f);
  const dir = new URL('proxy/feeds/', root);
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.js') || name.endsWith('.test.js')) continue;
    const mod = await import(new URL(name, dir));
    for (const f of mod.feeds ?? []) if (!byId.has(f.id)) byId.set(f.id, f);
  }
  return [...byId.values()];
}

test('every feed in the proxy registry has a credit', async () => {
  const feeds = await allFeeds();
  assert.ok(feeds.length > 30, 'the registry loaded');
  const missing = feeds.filter((f) => creditsForFeed(f).length === 0).map((f) => f.id);
  assert.deepEqual(missing, [], `feeds with no credit in core/credits.js: ${missing}`);
});

test('every upstream the scene or proxy reaches directly has a credit', () => {
  const files = [
    'core/scene/imagery.js',
    'core/scene/labels.js',
    'core/scene/terrain.js',
    'proxy/lib/ais.js',
    'proxy/lib/tiles.js',
    'proxy/lib/risLive.js',
    'proxy/lib/certStream.js',
  ];
  const hosts = new Set();
  for (const rel of files) {
    const path = fileURLToPath(new URL(rel, root));
    if (!fs.existsSync(path)) continue;
    const text = fs.readFileSync(path, 'utf8');
    for (const m of text.matchAll(/\b(?:https|wss):\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
      hosts.add(m[1].toLowerCase());
    }
  }
  assert.ok(hosts.size >= 5, 'found the direct upstreams');
  const missing = [...hosts].filter((h) => creditsForHost(h).length === 0);
  assert.deepEqual(missing, [], `hosts with no credit: ${missing}`);
});

test('each credit is complete, linked, and uses no em dashes', () => {
  const ids = new Set();
  for (const c of CREDITS) {
    assert.ok(!ids.has(c.id), `duplicate credit id ${c.id}`);
    ids.add(c.id);
    assert.ok(c.name && c.terms, `${c.id} has a name and terms`);
    assert.ok(c.layers.length, `${c.id} belongs to a layer or area`);
    assert.ok(['required', 'courtesy', 'none'].includes(c.attribution), c.id);
    if (c.attribution !== 'none') assert.match(c.url, /^https:\/\//, `${c.id} links out`);
    assert.ok(c.feeds?.length || c.hosts?.length, `${c.id} is matched by a feed or host`);
    for (const s of [c.name, c.terms, c.url ?? '']) {
      assert.equal(s.includes('\u2014'), false, `${c.id} contains an em dash`);
    }
  }
});

test('layer grouping and lookups for the popover', () => {
  const flow = creditsForLayer('trafficflow');
  assert.deepEqual(
    flow.map((c) => c.id),
    ['tomtom'],
  );
  assert.match(flow[0].terms, /Traffic flow data © TomTom/);
  assert.deepEqual(
    creditsForLayer('imagery').map((c) => c.id),
    ['nasa-gibs', 'nasa-hls'],
  );
  assert.deepEqual(
    creditsForLayer('cockpit')
      .map((c) => c.id)
      .sort(),
    ['gdelt', 'google-news', 'nominatim', 'open-meteo', 'openstreetmap'],
  );
  assert.equal(creditById('google-news').nonCommercial, true);
  assert.equal(creditById('nope'), null);
  // Demo-only layers have nothing to credit and drop out of the popover.
  assert.deepEqual(creditsForLayer('threats'), []);
  const groups = creditsByLayer(['flights', 'threats', 'basemap']);
  assert.deepEqual(
    groups.map((g) => g.layer),
    ['flights', 'basemap'],
  );
  assert.equal(groups[1].label, GROUP_LABELS.basemap);
  assert.equal(groups[0].label, null);
  // With no list: every group once, each with at least one credit.
  const all = creditsByLayer();
  assert.equal(new Set(all.map((g) => g.layer)).size, all.length);
  assert.ok(all.every((g) => g.credits.length));
  assert.match(
    creditText(creditById('usgs')),
    /^U\.S\. Geological Survey: Public domain/,
  );
  assert.equal(creditText(null), '');
});

test('feeds match by id, id pattern, host, or local equipment', () => {
  assert.deepEqual(
    creditsForFeed('gbfs-bluebikes').map((c) => c.id),
    ['gbfs'],
  );
  assert.deepEqual(
    creditsForFeed('overpass').map((c) => c.id),
    ['openstreetmap', 'overpass'],
  );
  // An unknown id on a known host still finds its credit.
  assert.deepEqual(
    creditsForFeed({ id: 'photon-v2', baseUrl: 'https://photon.komoot.io/api' }).map(
      (c) => c.id,
    ),
    ['photon'],
  );
  assert.deepEqual(
    creditsForFeed({
      id: 'my-sdr',
      baseUrl: 'http://localhost:1234',
      localOnly: true,
    }).map((c) => c.id),
    ['own-receivers'],
  );
  assert.deepEqual(creditsForFeed({ id: 'x', baseUrl: 'https://unknown.example' }), []);
  assert.deepEqual(creditsForFeed(null), []);
});
