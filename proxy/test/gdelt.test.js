import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { crc32, readSingleEntry, ZipError } from '../lib/zip.js';
import {
  createGdeltEventsProducer,
  gdeltTheme,
  mergeGdeltEvents,
  parseExportTsv,
  parseLastUpdate,
  slotStamps,
  stampMs,
} from '../lib/gdelt.js';
import { createRequestHandler } from '../lib/app.js';
import { loadConfig, validateFeeds } from '../lib/config.js';
import { feeds as registry } from '../feeds.js';
import { exactPath } from '../feeds/common.js';

// Real data, trimmed: the GDELT export of 2026-10-09 06:00 UTC (42 of its
// 1,025 rows, actor names blanked), zipped by Python's zipfile (an independent
// writer), and the lastupdate.txt that listed it.
const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const ZIP = fixture('gdelt-sample.export.CSV.zip');
const CSV = fixture('gdelt-sample.export.CSV');
const LASTUPDATE = fixture('gdelt-lastupdate.txt').toString('utf8');

/** A minimal zip writer for the cases Python's would not produce. */
function makeZip(entries, { method = 8 } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const n = Buffer.from(name);
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(method, 8);
    head.writeUInt32LE(crc32(data), 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(n.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc32(data), 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(n.length, 28);
    cd.writeUInt32LE(offset, 42);
    locals.push(head, n, body);
    centrals.push(cd, n);
    offset += head.length + n.length + body.length;
  }
  const cdBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('the zip reader inflates the real single-entry export', async () => {
  const { name, data } = await readSingleEntry(ZIP, { name: /^\d{14}\.export\.CSV$/ });
  assert.equal(name, '20261009060000.export.CSV');
  assert.ok(data.equals(CSV));
  // Stored (method 0) entries read too.
  const stored = await readSingleEntry(
    makeZip([{ name: 'a.txt', data: Buffer.from('hello') }], { method: 0 }),
  );
  assert.equal(stored.data.toString(), 'hello');
});

test('the zip reader refuses what it should not trust', async () => {
  const two = makeZip([
    { name: 'a', data: Buffer.from('1') },
    { name: 'b', data: Buffer.from('2') },
  ]);
  await assert.rejects(readSingleEntry(two), /expected one entry/);
  await assert.rejects(readSingleEntry(Buffer.from('not a zip at all, no')), ZipError);
  await assert.rejects(readSingleEntry(ZIP, { name: /^x$/ }), /unexpected entry name/);
  await assert.rejects(readSingleEntry(ZIP, { maxBytes: 1000 }), /too large/);
  // A flipped byte in the compressed data: corrupt deflate or a CRC mismatch.
  const bad = Buffer.from(ZIP);
  bad[200] ^= 0xff;
  await assert.rejects(readSingleEntry(bad), ZipError);
  // A wrong CRC in the directory with intact data.
  const z = makeZip([{ name: 'a', data: Buffer.from('payload') }]);
  const cd = z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  z.writeUInt32LE(1, cd + 16);
  await assert.rejects(readSingleEntry(z), /CRC mismatch/);
  // Cut short: the end record is gone.
  await assert.rejects(readSingleEntry(ZIP.subarray(0, ZIP.length - 30)), ZipError);
  // Encrypted.
  const enc = makeZip([{ name: 'a', data: Buffer.from('x') }]);
  enc.writeUInt16LE(1, enc.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 8);
  await assert.rejects(readSingleEntry(enc), /encrypted/);
});

test('CAMEO codes map onto the themes; the rest is dropped', () => {
  assert.equal(gdeltTheme('141'), 'unrest');
  assert.equal(gdeltTheme('145'), 'unrest');
  assert.equal(gdeltTheme('190'), 'conflict');
  assert.equal(gdeltTheme('1823'), 'conflict');
  assert.equal(gdeltTheme('2042'), 'conflict');
  assert.equal(gdeltTheme('073'), 'aid');
  assert.equal(gdeltTheme('0233'), 'aid');
  assert.equal(gdeltTheme('0333'), 'aid');
  for (const c of ['010', '042', '051', '112', '173', '0234', '074', '', 'x14', null])
    assert.equal(gdeltTheme(c), null, String(c));
});

test('lastupdate.txt names the latest export, over any scheme, by file name only', () => {
  assert.deepEqual(parseLastUpdate(LASTUPDATE), {
    stamp: '20261009060000',
    size: 67077,
    md5: '73003d91186492caafea95b354bc6410',
  });
  assert.equal(parseLastUpdate(''), null);
  assert.equal(
    parseLastUpdate(
      '1 73003d91186492caafea95b354bc6410 https://evil.example/gdeltv2/20261009060000.export.CSV.zip',
    ),
    null,
  );
  assert.equal(
    parseLastUpdate(
      '1 73003d91186492caafea95b354bc6410 http://data.gdeltproject.org/gdeltv2/../x.export.CSV.zip',
    ),
    null,
  );
  assert.deepEqual(slotStamps('20261009060000', 3), [
    '20261009060000',
    '20261009054500',
    '20261009053000',
  ]);
  assert.deepEqual(slotStamps('20261001000000', 2), ['20261001000000', '20260930234500']);
  assert.ok(Number.isNaN(stampMs('20261332000000')));
});

test('the export parses into themed events with a place; actors never appear', () => {
  const events = parseExportTsv(CSV.toString('utf8'));
  assert.equal(events.length, 37, 'other codes and placeless rows are dropped');
  assert.deepEqual([...new Set(events.map((e) => e.theme))].sort(), [
    'aid',
    'conflict',
    'unrest',
  ]);
  for (const e of events) {
    assert.ok(e.geo >= 1 && e.geo <= 5);
    assert.ok(Math.abs(e.lat) <= 90 && Math.abs(e.lon) <= 180);
    assert.ok(e.url === null || /^https?:\/\//.test(e.url));
    assert.equal(e.added, '2026-10-09T06:00:00Z');
    assert.deepEqual(Object.keys(e).sort(), [
      'added',
      'articles',
      'cc',
      'code',
      'geo',
      'goldstein',
      'lat',
      'lon',
      'mentions',
      'place',
      'quad',
      'sources',
      'theme',
      'tone',
      'url',
    ]);
  }
  const canberra = events.find((e) => e.place.startsWith('Canberra'));
  assert.equal(canberra.code, '190');
  assert.equal(canberra.quad, 4);
  assert.equal(canberra.goldstein, -10);
  // A javascript: link or a malformed row is never passed on.
  const row = CSV.toString('utf8').split('\n')[0].split('\t');
  row[60] = 'javascript:alert(1)';
  row[26] = '141';
  row[28] = '14';
  assert.equal(parseExportTsv(row.join('\t'))[0].url, null);
  assert.deepEqual(parseExportTsv('a\tb\tc'), []);
  row[56] = 'NaN';
  assert.deepEqual(parseExportTsv(row.join('\t')), []);
});

test('repeats at one place merge, the most reported first, capped', () => {
  const a = {
    theme: 'conflict',
    code: '190',
    quad: 4,
    goldstein: -10,
    sources: 1,
    articles: 1,
    geo: 4,
    place: 'X',
    cc: 'XX',
    lat: 10,
    lon: 20,
  };
  const merged = mergeGdeltEvents([
    {
      ...a,
      mentions: 2,
      tone: -2,
      added: '2026-10-09T05:00:00Z',
      url: 'https://a.example/1',
    },
    {
      ...a,
      mentions: 6,
      tone: -6,
      added: '2026-10-09T06:00:00Z',
      url: 'https://a.example/2',
    },
    { ...a, mentions: 1, tone: 0, added: null, url: 'https://a.example/2' },
    { ...a, code: '141', theme: 'unrest', mentions: 1, tone: 1, added: null, url: null },
  ]);
  assert.equal(merged.length, 2);
  const [fight, protest] = merged;
  assert.equal(fight.n, 3);
  assert.equal(fight.mentions, 9);
  assert.equal(fight.added, '2026-10-09T06:00:00Z');
  assert.deepEqual(fight.urls, ['https://a.example/2', 'https://a.example/1']);
  assert.equal(fight.tone, -4.44); // (-6*6 + -2*2 + 0*1) / 9
  assert.equal(protest.code, '141');
  assert.equal(mergeGdeltEvents(merged.concat(merged), { max: 1 }).length, 1);
  const real = mergeGdeltEvents(parseExportTsv(CSV.toString('utf8')));
  assert.equal(real.length, 31);
  assert.ok(real.every((e, i) => i === 0 || real[i - 1].mentions >= e.mentions));
});

/** A pinned-fetch stand-in serving lastupdate.txt and some exports. */
function fakeFetch(files, log = []) {
  return async (path) => {
    log.push(path);
    const body = files[path];
    if (!body) throw Object.assign(new Error(`404 ${path}`), { status: 404 });
    return body;
  };
}
const listing = (zip, stamp = '20261009060000') =>
  Buffer.from(
    `${zip.length} ${crypto.createHash('md5').update(zip).digest('hex')} http://data.gdeltproject.org/gdeltv2/${stamp}.export.CSV.zip\n`,
  );

test('the producer keeps the last hour, fetching each export once', async () => {
  const produce = createGdeltEventsProducer();
  const log = [];
  const files = {
    '/gdeltv2/lastupdate.txt': listing(ZIP),
    '/gdeltv2/20261009060000.export.CSV.zip': ZIP,
    '/gdeltv2/20261009054500.export.CSV.zip': ZIP,
    // 05:30 is missing (GDELT skips one now and then); 05:15 is there.
    '/gdeltv2/20261009051500.export.CSV.zip': ZIP,
  };
  const out = JSON.parse((await produce({ fetch: fakeFetch(files, log) })).body);
  assert.equal(out.v, 1);
  assert.equal(out.updated, '2026-10-09T06:00:00Z');
  assert.equal(out.exports, 3);
  assert.equal(out.windowMinutes, 45);
  assert.equal(out.events.length, 31, 'the same rows thrice merge into one set');
  assert.equal(out.events.find((e) => e.place.startsWith('Canberra')).n, 3);
  assert.equal(log.length, 5);

  // Fifteen minutes on: only the list and the new export are fetched (and the
  // slot that failed before is tried again).
  log.length = 0;
  files['/gdeltv2/lastupdate.txt'] = listing(ZIP, '20261009061500');
  files['/gdeltv2/20261009061500.export.CSV.zip'] = ZIP;
  const next = JSON.parse((await produce({ fetch: fakeFetch(files, log) })).body);
  assert.deepEqual(log, [
    '/gdeltv2/lastupdate.txt',
    '/gdeltv2/20261009061500.export.CSV.zip',
    '/gdeltv2/20261009053000.export.CSV.zip',
  ]);
  assert.equal(next.exports, 3);
});

test('the producer fails when the latest export is missing or does not match', async () => {
  const files = { '/gdeltv2/lastupdate.txt': listing(Buffer.from('other bytes')) };
  files['/gdeltv2/20261009060000.export.CSV.zip'] = ZIP;
  await assert.rejects(
    createGdeltEventsProducer()({ fetch: fakeFetch(files) }),
    /does not match/,
  );
  await assert.rejects(
    createGdeltEventsProducer()({
      fetch: fakeFetch({ '/gdeltv2/lastupdate.txt': listing(ZIP) }),
    }),
    /404/,
  );
  await assert.rejects(
    createGdeltEventsProducer()({
      fetch: fakeFetch({ '/gdeltv2/lastupdate.txt': Buffer.from('nothing') }),
    }),
    /lists no export/,
  );
});

function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

test('the gdelt-events feed is produced, cached, pinned and served stale', async (t) => {
  const seen = [];
  let up = true;
  const upstream = await listen((req, res) => {
    seen.push(req.url);
    const files = {
      '/gdeltv2/lastupdate.txt': listing(ZIP),
      '/gdeltv2/20261009060000.export.CSV.zip': ZIP,
    };
    const body = up ? files[req.url] : null;
    res.writeHead(body ? 200 : 503);
    res.end(body ?? '');
  });
  t.after(() => upstream.close());
  const real = registry.find((f) => f.id === 'gdelt-events');
  const feed = {
    ...real,
    baseUrl: `http://127.0.0.1:${upstream.address().port}/gdeltv2`,
    produce: createGdeltEventsProducer(),
  };
  const proxy = await listen(
    createRequestHandler({ config: loadConfig({}), feeds: [feed] }),
  );
  t.after(() => proxy.close());
  const base = `http://127.0.0.1:${proxy.address().port}/feed/gdelt-events`;

  const r = await fetch(`${base}/events.json`, {
    headers: { accept: 'application/json' },
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /json/);
  assert.equal(r.headers.get('x-argus-cache'), 'miss');
  assert.equal((await r.json()).events.length, 31);
  assert.ok(
    seen.every((p) => /^\/gdeltv2\/(lastupdate\.txt|\d{14}\.export\.CSV\.zip)$/.test(p)),
  );

  const again = await fetch(`${base}/events.json`, {
    headers: { accept: 'application/json' },
  });
  assert.equal(again.headers.get('x-argus-cache'), 'hit');

  // Only the one path and no query reach the producer.
  assert.equal((await fetch(`${base}/lastupdate.txt`)).status, 403);
  assert.equal((await fetch(`${base}/events.json?q=x`)).status, 403);

  // GDELT down after the cache expired: the last good document, marked stale.
  up = false;
  const proxyStale = await listen(
    createRequestHandler({
      config: loadConfig({}),
      feeds: [{ ...feed, cache: { ttlMs: 0, staleMs: 60_000 } }],
    }),
  );
  t.after(() => proxyStale.close());
  const sbase = `http://127.0.0.1:${proxyStale.address().port}/feed/gdelt-events/events.json`;
  up = true;
  assert.equal((await fetch(sbase)).status, 200);
  up = false;
  const stale = await fetch(sbase);
  assert.equal(stale.status, 200);
  assert.equal(stale.headers.get('x-argus-cache'), 'stale');
  assert.match(stale.headers.get('x-argus-stale'), /^\d+$/);
});

test('the registry entry: pinned upstream paths, no query, a produce function', () => {
  const feed = registry.find((f) => f.id === 'gdelt-events');
  assert.ok(feed && typeof feed.produce === 'function');
  assert.equal(new URL(feed.baseUrl).protocol, 'https:');
  assert.equal(new URL(feed.baseUrl).hostname, 'data.gdeltproject.org');
  assert.equal(
    registry.find((f) => f.id === 'gdelt-geo'),
    undefined,
    'the dead API is gone',
  );
  const ok = (p) => feed.upstreamPaths.some((re) => re.test(p));
  assert.ok(ok('/gdeltv2/lastupdate.txt'));
  assert.ok(ok('/gdeltv2/20261009060000.export.CSV.zip'));
  assert.equal(ok('/gdeltv2/20261009060000.gkg.csv.zip'), false);
  assert.equal(ok('/gdeltv2/20261009060000.mentions.CSV.zip'), false);
  assert.equal(ok('/gdeltv2/../etc'), false);
  assert.deepEqual(validateFeeds([feed]), [feed]);
  assert.throws(() => validateFeeds([{ ...feed, methods: ['GET', 'POST'] }]), /produce/);
  assert.ok(exactPath('/x').test('/x'));
});
