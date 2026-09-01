import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { attachAisWebsocket, unionBBox, inBBox } from '../lib/ais.js';

test('inBBox includes points inside and excludes outside', () => {
  const b = { lamin: 10, lomin: -20, lamax: 30, lomax: 20 };
  assert.equal(inBBox(b, 20, 0), true);
  assert.equal(inBBox(b, 40, 0), false);
  assert.equal(inBBox(b, 20, 50), false);
});

test('unionBBox spans all boxes, defaults to global when empty', () => {
  const u = unionBBox([
    { lamin: 10, lomin: 0, lamax: 20, lomax: 30 },
    { lamin: -5, lomin: 10, lamax: 15, lomax: 40 },
  ]);
  assert.deepEqual(u, { lamin: -5, lomin: 0, lamax: 20, lomax: 40 });
  assert.deepEqual(unionBBox([]), { lamin: -90, lomin: -180, lamax: 90, lomax: 180 });
});

test('ws server accepts a client and its bbox message (no upstream key)', async (t) => {
  const server = http.createServer();
  const wss = attachAisWebsocket(server, { apiKey: undefined });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  t.after(
    () =>
      new Promise((r) => {
        wss.close(() => server.close(r));
      }),
  );

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/ais`);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.send(
    JSON.stringify({ type: 'bbox', bbox: { lamin: 0, lomin: 0, lamax: 10, lomax: 10 } }),
  );
  // Give the server a tick to process, then close cleanly.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ws.readyState, WebSocket.OPEN);
  await new Promise((r) => {
    ws.on('close', r);
    ws.close();
  });
});
