import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequestHandler } from '../lib/app.js';
import { loadConfig } from '../lib/config.js';
import { knownKeys, mergeDotEnv, encryptKeys, decryptKeys, KDF } from '../lib/setup.js';

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

  // Export and import are refused the same way: a rebound page cannot read the
  // keys out (even encrypted) or push its own in.
  for (const route of ['/setup/keys/export', '/setup/keys/import']) {
    process.env.A_KEY = 'kept';
    const r = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: route,
          method: 'POST',
          headers: { ...spoof, 'content-type': 'application/json', 'x-argus-setup': '1' },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode, data }));
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify({ passphrase: 'a long passphrase', env: 'A_KEY=pwned' }));
    });
    assert.equal(r.status, 403, route);
    assert.ok(!r.data.includes('kept') && !r.data.includes('bundle'), route);
    assert.equal(process.env.A_KEY, 'kept');
  }
  assert.ok(!fs.existsSync(file));
});

// ------------------------------------------------------ export and import

async function setupServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-setup-'));
  const file = path.join(dir, '.env');
  const config = { ...loadConfig({}), keysFile: file };
  const server = await listen(createRequestHandler({ config, feeds }));
  const saved = { A_KEY: process.env.A_KEY, B_ID: process.env.B_ID };
  t.after(() => {
    server.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete process.env.ARGUS_SETUP;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, headers = {}) =>
    fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-argus-setup': '1', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { file, base, post };
}

const PASS = 'correct horse battery';

test('keys export encrypted and import back (round trip), values never echoed', async (t) => {
  const { file, base, post } = await setupServer(t);
  process.env.A_KEY = 's3cret-a';
  process.env.B_ID = 'client-b';
  const list = await fetch(`${base}/setup/keys`);
  assert.equal((await list.clone().json()).transfer, true);
  assert.equal(list.headers.get('cache-control'), 'no-store');

  const ex = await post('/setup/keys/export', { passphrase: PASS });
  assert.equal(ex.status, 200);
  assert.equal(ex.headers.get('cache-control'), 'no-store');
  const text = await ex.text();
  assert.ok(!text.includes('s3cret-a') && !text.includes('client-b'), 'only ciphertext');
  const { bundle, names } = JSON.parse(text);
  assert.deepEqual(names.sort(), ['A_KEY', 'B_ID']);
  assert.deepEqual(Object.keys(bundle).sort(), [
    'N',
    'data',
    'iv',
    'kdf',
    'p',
    'r',
    'salt',
    'tag',
    'v',
  ]);
  assert.equal(bundle.v, 1);
  assert.equal(bundle.kdf, 'scrypt');
  assert.deepEqual([bundle.N, bundle.r, bundle.p], [KDF.N, KDF.r, KDF.p]);
  assert.equal(Buffer.from(bundle.iv, 'base64').length, 12);
  assert.equal(Buffer.from(bundle.tag, 'base64').length, 16);

  // On another machine (here: the same one, emptied), the file brings them back.
  delete process.env.A_KEY;
  delete process.env.B_ID;
  const im = await post('/setup/keys/import', { bundle, passphrase: PASS });
  assert.equal(im.status, 200);
  const r = await im.json();
  assert.deepEqual(r.saved.sort(), ['A_KEY', 'B_ID']);
  assert.equal(r.restartNeeded, true, 'B_ID is an OAuth credential');
  assert.ok(!JSON.stringify(r).includes('s3cret-a'), 'values are never echoed');
  assert.equal(process.env.A_KEY, 's3cret-a');
  assert.equal(process.env.B_ID, 'client-b');
  assert.equal(fs.readFileSync(file, 'utf8'), 'A_KEY=s3cret-a\nB_ID=client-b\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a wrong passphrase or a changed file imports nothing', async (t) => {
  const { file, post } = await setupServer(t);
  const bundle = await encryptKeys({ A_KEY: 'v1' }, PASS);
  const tries = [
    { bundle, passphrase: 'not the passphrase' },
    {
      bundle: { ...bundle, tag: Buffer.alloc(16, 1).toString('base64') },
      passphrase: PASS,
    },
    {
      bundle: {
        ...bundle,
        data: Buffer.from(Buffer.from(bundle.data, 'base64').map((b) => b ^ 1)).toString(
          'base64',
        ),
      },
      passphrase: PASS,
    },
    { bundle: { ...bundle, N: KDF.N * 2 }, passphrase: PASS },
  ];
  for (const body of tries) {
    const r = await post('/setup/keys/import', body);
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /wrong passphrase, or the file was changed/);
  }
  // Settings no file may ask for: refused before any work is done.
  for (const bad of [
    { N: 2 ** 22 },
    { N: 1000 },
    { r: 64 },
    { p: 9 },
    { v: 2 },
    { kdf: 'pbkdf2' },
    { iv: 'AAAA' },
    { salt: '!!' },
  ]) {
    const r = await post('/setup/keys/import', {
      bundle: { ...bundle, ...bad },
      passphrase: PASS,
    });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  await assert.rejects(decryptKeys(null, PASS), /not an Argus keys file/);
  assert.ok(!fs.existsSync(file), 'nothing written');
  assert.equal(process.env.A_KEY, undefined);
});

test('a short passphrase is refused for export and import', async (t) => {
  const { post } = await setupServer(t);
  process.env.A_KEY = 'x';
  const ex = await post('/setup/keys/export', { passphrase: 'short' });
  assert.equal(ex.status, 400);
  assert.match((await ex.json()).error, /at least 10 characters/);
  const bundle = await encryptKeys({ A_KEY: 'v' }, 'short');
  assert.equal(
    (await post('/setup/keys/import', { bundle, passphrase: 'short' })).status,
    400,
  );
  delete process.env.A_KEY;
  const none = await post('/setup/keys/export', { passphrase: PASS });
  assert.match((await none.json()).error, /nothing to export/);
});

test('.env text imports the keys Argus uses and leaves the rest', async (t) => {
  const { file, post } = await setupServer(t);
  process.env.B_ID = 'keep-me';
  const r = await post('/setup/keys/import', {
    env: '# my keys\nexport A_KEY="from-env"\nPROXY_PORT=9999\nB_ID=\nPATH=/tmp\n',
  });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.deepEqual(out.saved, ['A_KEY']);
  assert.deepEqual(out.ignored.sort(), ['PATH', 'PROXY_PORT']);
  assert.equal(process.env.B_ID, 'keep-me', 'an empty value never removes a key');
  assert.equal(fs.readFileSync(file, 'utf8'), 'A_KEY=from-env\n');
  assert.notEqual(process.env.PROXY_PORT, '9999');
  // Values are checked exactly as a save checks them.
  const bad = await post('/setup/keys/import', { env: 'A_KEY=has space' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /bad value for A_KEY/);
  const nothing = await post('/setup/keys/import', { env: 'PROXY_PORT=1' });
  assert.equal(nothing.status, 400);
  assert.equal((await post('/setup/keys/import', { other: 1 })).status, 400);
});

test('export and import keep the gates of a save', async (t) => {
  const { file, base, post } = await setupServer(t);
  process.env.A_KEY = 'secret-value';
  const body = { passphrase: PASS, env: 'A_KEY=changed' };
  for (const route of ['/setup/keys/export', '/setup/keys/import']) {
    assert.equal((await post(route, body, { 'x-argus-setup': '' })).status, 403, route);
    assert.equal(
      (await post(route, body, { origin: 'https://evil.example' })).status,
      403,
      route,
    );
    assert.equal(
      (await post(route, JSON.stringify(body), { 'content-type': 'text/plain' })).status,
      415,
      route,
    );
    assert.equal((await fetch(`${base}${route}`)).status, 405, `${route} GET`);
    process.env.ARGUS_SETUP = 'off';
    const off = await post(route, body);
    assert.equal(off.status, 403, `${route} off`);
    assert.match((await off.json()).error, /ARGUS_SETUP=off/);
    delete process.env.ARGUS_SETUP;
  }
  assert.equal(process.env.A_KEY, 'secret-value');
  assert.ok(!fs.existsSync(file));
});
