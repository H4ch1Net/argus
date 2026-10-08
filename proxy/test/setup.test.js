import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequestHandler } from '../lib/app.js';
import { loadConfig } from '../lib/config.js';
import { knownKeys, mergeDotEnv } from '../lib/setup.js';

const feeds = [
  {
    id: 'a',
    baseUrl: 'https://a.example/api',
    inject: [{ secret: 'A_KEY', as: 'header', name: 'X' }],
  },
  {
    id: 'b',
    baseUrl: 'https://b.example/api',
    auth: {
      type: 'oauth2',
      tokenUrl: 'https://b.example/t',
      clientId: 'B_ID',
      clientSecret: 'B_SECRET',
    },
  },
  { id: 'c', baseUrl: 'https://c.example' },
];

function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

test('known keys come from the feeds plus the websocket and tile keys', () => {
  const names = knownKeys(feeds).map((k) => k.name);
  assert.deepEqual(
    names,
    ['AISSTREAM_API_KEY', 'A_KEY', 'B_ID', 'B_SECRET', 'GOOGLE_MAPS_API_KEY'].sort(),
  );
  assert.equal(knownKeys(feeds).find((k) => k.name === 'B_ID').restart, true);
});

test('merging keeps comments and other keys, replaces and removes', () => {
  const text = '# keys\nA_KEY=old\nOTHER=1\n';
  assert.equal(
    mergeDotEnv(text, { A_KEY: 'new', B_ID: 'x' }),
    '# keys\nA_KEY=new\nOTHER=1\nB_ID=x\n',
  );
  assert.equal(mergeDotEnv(text, { A_KEY: '' }), '# keys\nOTHER=1\n');
});

test('GET lists keys without values; POST saves with the guards', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-setup-'));
  const file = path.join(dir, '.env');
  const config = { ...loadConfig({}), keysFile: file };
  const server = await listen(createRequestHandler({ config, feeds }));
  t.after(() => {
    server.close();
    delete process.env.A_KEY;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const list = await (await fetch(`${base}/setup/keys`)).json();
  assert.equal(list.writable, true);
  assert.ok(list.keys.every((k) => !('value' in k)));

  const post = (body, headers = {}) =>
    fetch(`${base}/setup/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-argus-setup': '1', ...headers },
      body: JSON.stringify(body),
    });
  // Missing the app header, a foreign origin, an unknown name, a bad value: refused.
  assert.equal(
    (await post({ keys: { A_KEY: 'v' } }, { 'x-argus-setup': '' })).status,
    403,
  );
  assert.equal(
    (await post({ keys: { A_KEY: 'v' } }, { origin: 'https://evil.example' })).status,
    403,
  );
  assert.equal((await post({ keys: { PATH: '/tmp' } })).status, 400);
  assert.equal((await post({ keys: { A_KEY: 'a b' } })).status, 400);
  // A good save writes the file (mode 600) and applies to this process.
  const ok = await post({ keys: { A_KEY: 's3cret' } });
  assert.equal(ok.status, 200);
  const r = await ok.json();
  assert.deepEqual(r.saved, ['A_KEY']);
  assert.equal(r.restartNeeded, false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'A_KEY=s3cret\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(process.env.A_KEY, 's3cret');
  assert.ok(!JSON.stringify(r).includes('s3cret'), 'values are never echoed');
});

// A DNS-rebinding page is same-origin with its own (attacker) host and reaches
// the proxy over loopback, so isLoopback + sameOrigin + the app header all pass;
// only the Host header still names the attacker domain. The Host allowlist is
// what closes that path. fetch forbids setting Host, so these use raw http.
test('a non-loopback Host is refused even over a loopback socket', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-setup-'));
  const file = path.join(dir, '.env');
  const config = { ...loadConfig({}), keysFile: file };
  const server = await listen(createRequestHandler({ config, feeds }));
  t.after(() => {
    server.close();
    delete process.env.A_KEY;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { port } = server.address();

  const raw = (method, headers, body) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/setup/keys', method, headers },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode, data }));
        },
      );
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });

  // Host names the attacker's rebound domain: GET says not writable, POST is
  // refused, and nothing is written to disk.
  const spoof = { host: 'attacker.example:' + port };
  const get = await raw('GET', spoof);
  assert.equal(get.status, 200);
  const info = JSON.parse(get.data);
  assert.equal(info.writable, false);
  assert.equal(info.file, undefined);

  const post = await raw(
    'POST',
    { ...spoof, 'content-type': 'application/json', 'x-argus-setup': '1' },
    JSON.stringify({ keys: { A_KEY: 'pwned' } }),
  );
  assert.equal(post.status, 403);
  assert.ok(!fs.existsSync(file), 'no keys file written for a spoofed Host');

  // A loopback Host still works (the regression guard for real local use).
  const okHost = { host: '127.0.0.1:' + port };
  const okGet = JSON.parse((await raw('GET', okHost)).data);
  assert.equal(okGet.writable, true);
});
