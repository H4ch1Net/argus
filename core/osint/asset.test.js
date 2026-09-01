import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAsset } from './asset.js';

test('classifies IPv4', () => {
  assert.deepEqual(classifyAsset('8.8.8.8'), { kind: 'ip', value: '8.8.8.8' });
  assert.deepEqual(classifyAsset(' 192.168.0.1 '), { kind: 'ip', value: '192.168.0.1' });
});

test('rejects out-of-range and malformed IPv4', () => {
  assert.equal(classifyAsset('256.0.0.1'), null);
  assert.equal(classifyAsset('1.2.3'), null);
});

test('classifies IPv6', () => {
  assert.deepEqual(classifyAsset('2001:4860:4860::8888'), {
    kind: 'ip',
    value: '2001:4860:4860::8888',
  });
});

test('classifies ASN with or without space', () => {
  assert.deepEqual(classifyAsset('AS15169'), { kind: 'asn', value: 'AS15169' });
  assert.deepEqual(classifyAsset('as 3356'), { kind: 'asn', value: 'AS3356' });
});

test('classifies domains', () => {
  assert.deepEqual(classifyAsset('dns.google'), { kind: 'domain', value: 'dns.google' });
  assert.deepEqual(classifyAsset('Example.COM'), {
    kind: 'domain',
    value: 'example.com',
  });
});

test('non-assets fall through to null', () => {
  assert.equal(classifyAsset('Paris'), null);
  assert.equal(classifyAsset('UAL123'), null);
  assert.equal(classifyAsset(''), null);
  assert.equal(classifyAsset(null), null);
});
