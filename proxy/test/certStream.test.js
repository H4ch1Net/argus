import { test } from 'node:test';
import assert from 'node:assert/strict';
import { certMessageToEvent } from '../lib/certStream.js';

test('certificate_update becomes an event with primary domain, count, CA', () => {
  const ev = certMessageToEvent({
    message_type: 'certificate_update',
    data: {
      leaf_cert: {
        all_domains: ['example.com', 'www.example.com', '*.example.com'],
        issuer: { O: "Let's Encrypt", CN: 'R3' },
      },
    },
  });
  assert.deepEqual(ev, { domain: 'example.com', domains: 3, ca: "Let's Encrypt" });
});

test('falls back to issuer CN when O is missing', () => {
  const ev = certMessageToEvent({
    message_type: 'certificate_update',
    data: { leaf_cert: { all_domains: ['a.test'], issuer: { CN: 'Some CA' } } },
  });
  assert.equal(ev.ca, 'Some CA');
});

test('drops heartbeats, empty domain lists, and junk', () => {
  assert.equal(certMessageToEvent({ message_type: 'heartbeat' }), null);
  assert.equal(
    certMessageToEvent({
      message_type: 'certificate_update',
      data: { leaf_cert: { all_domains: [] } },
    }),
    null,
  );
  assert.equal(certMessageToEvent(null), null);
});
