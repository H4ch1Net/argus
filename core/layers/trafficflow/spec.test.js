import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  trafficFlowSpec,
  TRAFFIC_FLOW_REFRESH_MS,
  TRAFFIC_FLOW_STYLES,
  TRAFFIC_FLOW_CREDIT,
} from './spec.js';
import { trafficFlowDefinition } from './definition.js';

function buildUrl(feedId, path = '/') {
  return new URL(`https://proxy.test/feed/${feedId}${path}`).toString();
}

test('an xyz spec through the tomtom-flow feed, with literal placeholders', () => {
  const s = trafficFlowSpec(buildUrl, { now: 0 });
  assert.equal(s.kind, 'xyz');
  assert.equal(s.url, 'https://proxy.test/feed/tomtom-flow/relative0/{z}/{x}/{y}.png');
  assert.equal(s.credit, 'Traffic flow data © TomTom');
  assert.equal(s.credit, TRAFFIC_FLOW_CREDIT);
  assert.ok(s.maximumLevel <= 18);
  // No key anywhere in what the browser gets: the proxy injects it.
  assert.doesNotMatch(JSON.stringify(s), /key=/i);
});

test('the key changes once per refresh interval; the URL never does', () => {
  const a = trafficFlowSpec(buildUrl, { now: TRAFFIC_FLOW_REFRESH_MS * 5 + 1 });
  const b = trafficFlowSpec(buildUrl, { now: TRAFFIC_FLOW_REFRESH_MS * 6 - 1 });
  const c = trafficFlowSpec(buildUrl, { now: TRAFFIC_FLOW_REFRESH_MS * 6 });
  assert.equal(a.key, b.key);
  assert.notEqual(b.key, c.key);
  assert.equal(a.url, c.url);
});

test('styles are pinned', () => {
  for (const style of TRAFFIC_FLOW_STYLES) {
    assert.match(trafficFlowSpec(buildUrl, { style }).url, new RegExp(`/${style}/`));
  }
  assert.throws(() => trafficFlowSpec(buildUrl, { style: '../incidents' }));
});

test('the definition is a raster layer refreshed on the same interval', () => {
  assert.equal(trafficFlowDefinition.render.renderType, 'raster');
  assert.equal(trafficFlowDefinition.fetch.intervalMs, TRAFFIC_FLOW_REFRESH_MS);
});
