// The Android app runs this proxy on nodejs-mobile: Node 18.20, built without
// ICU (no Intl, no Unicode property data). A module that uses something newer
// fails on the phone only, and the whole proxy with it (a /\p{Cc}/ regex did,
// Oct 2026: "Invalid property name" at load). This walks every module the
// app's entry and the proxy can load and refuses what Node 18 without ICU
// cannot run. Desktop Node is newer, so nothing else would catch it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRIES = ['android/node/main.js', 'proxy/server.js'];

// Static, re-exported and literal dynamic imports of relative modules.
const IMPORT =
  /(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm;

function reachable() {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file) || !fs.existsSync(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec.startsWith('.')) walk(path.resolve(path.dirname(file), spec));
    }
  };
  for (const e of ENTRIES) walk(path.join(repo, e));
  return [...seen];
}

// What Node 18.20 without ICU lacks (each a load-time SyntaxError or a
// runtime TypeError / ReferenceError on the phone).
const RULES = [
  [/\\[pP]\{/, 'Unicode property escape: no ICU data (spell the range out)'],
  [/\bIntl\./, 'Intl: not built in'],
  [/import\.meta\.(dirname|filename)/, 'import.meta.dirname / filename: Node 20.11'],
  [/AbortSignal\.any\b/, 'AbortSignal.any: Node 20.3'],
  [/Promise\.withResolvers/, 'Promise.withResolvers: Node 22'],
  [/\b(Object|Map)\.groupBy/, 'Object / Map.groupBy: Node 21'],
  [/Array\.fromAsync/, 'Array.fromAsync: Node 22'],
  [/\.(toSorted|toReversed|toSpliced)\(/, 'change-array-by-copy: Node 20'],
  [/\.(isWellFormed|toWellFormed)\(/, 'well-formed strings: Node 20'],
  [/\bcrypto\.hash\(/, 'crypto.hash: Node 21.7'],
  [/process\.loadEnvFile/, 'process.loadEnvFile: Node 21.7'],
  [
    /zlib\.crc32|\{[^}]*\bcrc32\b[^}]*\}\s*from\s*['"](node:)?zlib/,
    'zlib.crc32: Node 22.2',
  ],
  [/\bstyleText\b/, 'util.styleText: Node 21.7'],
  [/\bfs\.(glob|globSync)\b/, 'fs.glob: Node 22'],
  [
    /\.(symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\(/,
    'Set methods: Node 22',
  ],
  [/\bRegExp\.escape\b/, 'RegExp.escape: Node 24'],
];

test('every module the Android proxy loads runs on Node 18 without ICU', () => {
  const files = reachable();
  assert.ok(files.length > 20, `walked ${files.length} modules`);
  assert.ok(files.some((f) => f.endsWith(path.join('proxy', 'lib', 'relay.js'))));
  const problems = [];
  for (const f of files) {
    fs.readFileSync(f, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return; // comments may name them
        for (const [re, why] of RULES) {
          if (re.test(line)) problems.push(`${path.relative(repo, f)}:${i + 1}: ${why}`);
        }
      });
  }
  assert.deepEqual(problems, []);
});

test('the rules catch what broke the phone', () => {
  const hit = (src) => RULES.some(([re]) => re.test(src));
  assert.equal(hit(String.raw`.replace(/\p{Cc}/gu, ' ')`), true);
  assert.equal(hit(String.raw`.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')`), false);
  assert.equal(hit('const d = import.meta.dirname;'), true);
  assert.equal(hit("import { crc32 } from 'node:zlib';"), true);
  assert.equal(hit('export function crc32(buf) {'), false, 'an own implementation');
});
