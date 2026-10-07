#!/usr/bin/env node
// Run every *.test.js under the given directories with the built-in test runner.
//
// `node --test <dir>` behaves differently across Node versions: Node 20 searches
// the directory for test files, while Node 22 treats the argument as a module and
// runs the directory's index.js instead (which imports Cesium and CSS and fails).
// Listing the files explicitly works the same everywhere.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function findTests(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // a missing directory simply contributes no tests
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findTests(full, out);
    else if (e.isFile() && e.name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const dirs = args.filter((a) => !a.startsWith('--'));
const files = dirs.flatMap((d) => findTests(d)).sort();

if (!files.length) {
  console.error(
    `no test files found under: ${dirs.join(', ') || '(no directories given)'}`,
  );
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...flags, ...files], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
