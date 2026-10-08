import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDotEnv, loadEnvFiles } from '../lib/env.js';

test('parseDotEnv handles quotes, export, comments, and blank lines', () => {
  const env = parseDotEnv(
    [
      '# a comment',
      '',
      'PLAIN=value',
      'export EXPORTED=yes',
      'DOUBLE="has spaces"',
      "SINGLE='x=y'",
      'TRAILING=abc # note',
      'EMPTY=',
      'not a line',
    ].join('\n'),
  );
  assert.deepEqual(env, {
    PLAIN: 'value',
    EXPORTED: 'yes',
    DOUBLE: 'has spaces',
    SINGLE: 'x=y',
    TRAILING: 'abc',
    EMPTY: '',
  });
});

test('loadEnvFiles never overrides set values and earlier files win', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-env-'));
  const a = path.join(dir, 'a.env');
  const b = path.join(dir, 'b.env');
  fs.writeFileSync(a, 'KEY_A=from-a\nSHARED=from-a\n');
  fs.writeFileSync(b, 'KEY_B=from-b\nSHARED=from-b\nPRESET=from-b\n');
  const env = { PRESET: 'from-env' };
  const loaded = loadEnvFiles({ env, files: [a, path.join(dir, 'missing.env'), b] });
  assert.deepEqual(loaded, [a, b]);
  assert.equal(env.KEY_A, 'from-a');
  assert.equal(env.KEY_B, 'from-b');
  assert.equal(env.SHARED, 'from-a');
  assert.equal(env.PRESET, 'from-env');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a quoted value followed by a comment keeps only the value', () => {
  assert.deepEqual(parseDotEnv('KEY="abc def" # note\nOTHER=\'x\'   # c'), {
    KEY: 'abc def',
    OTHER: 'x',
  });
});
