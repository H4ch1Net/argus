import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { INK, LAYER_INK } from './palette.js';

// Every layer the app registers has its own ink, so its markers, menu tile and
// legend agree; and the palette stays within the ctOS set (no stray hues).
const mainSrc = fs.readFileSync(new URL('../../main.js', import.meta.url), 'utf8');
// Registrations open with `{` then `key:` on the next line (notifications use
// a `key` too, but never right after an opening brace).
const registered = [...mainSrc.matchAll(/\{\n\s{6}key: '([a-z0-9]+)',$/gm)].map(
  (m) => m[1],
);

test('main.js registers layers (the scan below is meaningful)', () => {
  assert.ok(registered.length >= 30, `found ${registered.length}`);
});

test('every registered layer has an ink', () => {
  const missing = registered.filter((k) => !LAYER_INK[k]);
  assert.deepEqual(missing, []);
});

test('layer inks come from the ctOS palette only', () => {
  const allowed = new Set(Object.values(INK));
  for (const [k, v] of Object.entries(LAYER_INK)) assert.ok(allowed.has(v), `${k}: ${v}`);
});
