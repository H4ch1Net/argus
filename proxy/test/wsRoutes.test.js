import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { attachAisWebsocket } from '../lib/ais.js';
import { attachRisWebsocket } from '../lib/risLive.js';
import { attachCtWebsocket } from '../lib/certStream.js';

// Regression: all three endpoints share ONE http server (as server.js wires
// them). Before the upgrade router, ws aborted every path but the first with 400.

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('unexpected-response', (_req, res) =>
      reject(new Error(`unexpected ${res.statusCode}`)),
    );
    ws.on('error', reject);
  });
}

test('ais, bgp and ct websockets all upgrade on one shared server', async (t) => {
  const server = http.createServer();
  const servers = [
    attachAisWebsocket(server, { apiKey: undefined }),
    // Point the upstreams at a closed local port so no real network is touched.
    attachCtWebsocket(server, { url: 'ws://127.0.0.1:9/' }),
  ];
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  t.after(async () => {
    for (const s of servers) await new Promise((r) => s.close(r));
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  });

  for (const path of ['/ws/ais', '/ws/ct']) {
    const ws = await open(`ws://127.0.0.1:${port}${path}`);
    assert.equal(ws.readyState, WebSocket.OPEN, path);
    ws.terminate();
  }
});

test('an unknown websocket path is refused with 404', async (t) => {
  const server = http.createServer();
  const wss = attachAisWebsocket(server, { apiKey: undefined });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((r) => wss.close(r));
    await new Promise((r) => server.close(r));
  });
  await assert.rejects(open(`ws://127.0.0.1:${port}/ws/nope`), /404/);
});

test('the bgp endpoint is reachable alongside ais', async (t) => {
  const server = http.createServer();
  const servers = [attachAisWebsocket(server, { apiKey: undefined })];
  servers.push(attachRisWebsocket(server, { url: 'ws://127.0.0.1:9/' }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  t.after(async () => {
    for (const s of servers) await new Promise((r) => s.close(r));
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  });
  const ws = await open(`ws://127.0.0.1:${port}/ws/bgp`);
  assert.equal(ws.readyState, WebSocket.OPEN);
  ws.terminate();
});
