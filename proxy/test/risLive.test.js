import { test } from 'node:test';
import assert from 'node:assert/strict';
import { risMessageToEvent } from '../lib/risLive.js';

test('announcement message becomes an A event with origin ASN', () => {
  const ev = risMessageToEvent({
    type: 'ris_message',
    data: {
      type: 'UPDATE',
      host: 'rrc21.ripe.net',
      peer_asn: '3333',
      path: [3333, 1299, 15169],
      announcements: [{ next_hop: '1.2.3.4', prefixes: ['8.8.8.0/24', '8.8.4.0/24'] }],
      withdrawals: [],
    },
  });
  assert.deepEqual(ev, { rrc: 'rrc21', kind: 'A', asn: 15169 });
});

test('withdrawal-only message becomes a W event', () => {
  const ev = risMessageToEvent({
    type: 'ris_message',
    data: {
      type: 'UPDATE',
      host: 'rrc12',
      path: [3356],
      announcements: [],
      withdrawals: ['203.0.113.0/24'],
    },
  });
  assert.equal(ev.kind, 'W');
  assert.equal(ev.rrc, 'rrc12');
});

test('AS_SET origin is unwrapped to a scalar', () => {
  const ev = risMessageToEvent({
    type: 'ris_message',
    data: {
      type: 'UPDATE',
      host: 'rrc00',
      path: [1, 2, [64500, 64501]],
      announcements: [{ prefixes: ['a/24'] }],
    },
  });
  assert.equal(ev.asn, 64500);
});

test('non-UPDATE and empty messages are dropped', () => {
  assert.equal(
    risMessageToEvent({
      type: 'ris_message',
      data: { type: 'KEEPALIVE', host: 'rrc00' },
    }),
    null,
  );
  assert.equal(
    risMessageToEvent({
      type: 'ris_message',
      data: { type: 'UPDATE', host: 'rrc00', announcements: [], withdrawals: [] },
    }),
    null,
  );
  assert.equal(risMessageToEvent({ type: 'pong' }), null);
  assert.equal(risMessageToEvent(null), null);
});

test('unknown host (no rrc token) is dropped', () => {
  assert.equal(
    risMessageToEvent({
      type: 'ris_message',
      data: { type: 'UPDATE', host: 'unknown', announcements: [{ prefixes: ['a/24'] }] },
    }),
    null,
  );
});
