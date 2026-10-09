import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  cpeText,
  createInternetDbLookup,
  internetDbRows,
  internetDbSection,
  ipOf,
  isIp,
  parseInternetDb,
  sortCves,
} from './internetdb.js';
import { createLookup } from './lookup.js';

// Real InternetDB answers, fetched 2026-10-09 from internetdb.shodan.io:
// 8.8.8.8, 1.1.1.1, 45.33.32.156 (scanme.nmap.org) and an IP it has nothing on.
const FIX = JSON.parse(
  fs.readFileSync(new URL('./fixtures/internetdb.json', import.meta.url), 'utf8'),
);

test('parses real answers', () => {
  const g = parseInternetDb(FIX['8.8.8.8']);
  assert.equal(g.ip, '8.8.8.8');
  assert.deepEqual(g.ports, [53, 443]);
  assert.deepEqual(g.vulns, []);
  assert.ok(g.hostnames.includes('dns.google'));
  const cf = parseInternetDb(FIX['1.1.1.1']);
  assert.equal(cf.ports.length, 11);
  assert.deepEqual(cf.cpes, ['cpe:/a:cloudflare:cloudflare']);
  const scanme = parseInternetDb(FIX['45.33.32.156']);
  assert.deepEqual(scanme.ports, [22, 80, 123, 31337]);
  assert.deepEqual(scanme.tags, ['self-signed', 'cloud']);
  assert.ok(scanme.vulns.length > 100);
  assert.ok(scanme.vulns.every((v) => /^CVE-\d{4}-\d+$/.test(v)));
  // "No information available" is not an answer.
  assert.equal(parseInternetDb(FIX['3.33.33.33']), null);
  assert.equal(parseInternetDb(null), null);
  assert.equal(parseInternetDb({ ip: 'nope' }), null);
});

test('card rows: ports, CVE count with the newest, tags, hostnames, software', () => {
  const rows = Object.fromEntries(internetDbRows(parseInternetDb(FIX['45.33.32.156'])));
  assert.equal(rows['Open ports'], '22, 80, 123, 31337');
  assert.match(
    rows['Known CVEs'],
    /^\d{3} \(CVE-2026-\d+, CVE-2026-\d+, CVE-2026-\d+ \+\d+\)$/,
  );
  assert.equal(rows.Tags, 'self-signed, cloud');
  assert.equal(rows.Hostnames, 'scanme.nmap.org');
  assert.match(
    rows.Software,
    /^canonical ubuntu_linux, ntp ntp 3, apache http_server 2\.4\.7 \+1$/,
  );
  const g = Object.fromEntries(internetDbRows(parseInternetDb(FIX['8.8.8.8'])));
  assert.equal(g['Known CVEs'], 'none listed');
  assert.deepEqual(internetDbRows(null), [['InternetDB', 'nothing indexed for this IP']]);
  assert.equal(internetDbSection(null).title, 'Exposure (InternetDB)');
});

test('helpers', () => {
  assert.deepEqual(sortCves(['CVE-2018-1', 'CVE-2026-2', 'CVE-2026-10']), [
    'CVE-2026-10',
    'CVE-2026-2',
    'CVE-2018-1',
  ]);
  assert.equal(cpeText('cpe:/a:openbsd:openssh:6.6.1p1'), 'openbsd openssh 6.6.1p1');
  assert.equal(isIp('2001:4860:4860::8888'), true);
  assert.equal(isIp('example.com'), false);
  assert.equal(ipOf({ ip_str: '1.1.1.1' }), '1.1.1.1');
  assert.equal(ipOf({ name: 'x' }), null);
});

test('the lookup goes through the pinned feed, caches, and maps 404 to null', async () => {
  const calls = [];
  const proxyClient = {
    async getJson(feed, path) {
      calls.push(`${feed}${path}`);
      const ip = path.slice(1);
      if (FIX[ip]?.detail) throw Object.assign(new Error('404'), { status: 404 });
      return FIX[ip];
    },
  };
  const lookup = createInternetDbLookup(proxyClient);
  assert.equal(lookup.peek('8.8.8.8'), undefined);
  const a = await lookup('8.8.8.8');
  assert.deepEqual(a.ports, [53, 443]);
  await lookup('8.8.8.8');
  assert.deepEqual(calls, ['internetdb/8.8.8.8']);
  assert.deepEqual(lookup.peek('8.8.8.8').ports, [53, 443]);
  assert.equal(await lookup('3.33.33.33'), null);
  assert.equal(lookup.peek('3.33.33.33'), null);
  await assert.rejects(lookup('not-an-ip'));
  const down = createInternetDbLookup({
    async getJson() {
      throw Object.assign(new Error('502'), { status: 502 });
    },
  });
  await assert.rejects(down('8.8.8.8'));
});

test('the OSINT lookup adds an InternetDB section for an IP', async () => {
  const proxyClient = {
    async getJson(feed, path, { params } = {}) {
      if (feed === 'internetdb') return FIX[path.slice(1)];
      const call = path.split('/')[1];
      if (call === 'network-info')
        return { data: { asns: ['13335'], prefix: '1.1.1.0/24' } };
      if (call === 'as-overview')
        return { data: { holder: 'CLOUDFLARENET', announced: true } };
      return params ? null : null;
    },
  };
  const r = await createLookup(proxyClient)({ kind: 'ip', value: '1.1.1.1' });
  assert.deepEqual(r.sources, ['RIPEstat', 'InternetDB']);
  const sec = r.card.sections.find((s) => s.title === 'Exposure (InternetDB)');
  assert.match(Object.fromEntries(sec.rows)['Open ports'], /^53, 80, 443, 2052/);
});
