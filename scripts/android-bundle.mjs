#!/usr/bin/env node
// Stage the Node project the Android app runs (android/, docs/ANDROID.md): the
// built globe (dist/), the proxy with its runtime dependencies, the app's Node
// entry (android/node/main.js), and argus-manifest.json listing every file, so
// the app unpacks them without a slow listing of its assets.
//
//   npm run build
//   node scripts/android-bundle.mjs [--out DIR] [--skip-install]
//
// Default output: android/app/src/main/assets/nodejs-project/ (gitignored).
// Nothing secret is ever staged: .env files, keys and certificates are
// skipped wherever they are, and the result is checked for them at the end.

import { spawnSync } from 'node:child_process';
import console from 'node:console';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const out = path.resolve(
  opt('--out') ??
    path.join(repo, 'android', 'app', 'src', 'main', 'assets', 'nodejs-project'),
);
const MANIFEST = 'argus-manifest.json';

function fail(message) {
  console.error(`[android-bundle] ${message}`);
  process.exit(1);
}

/** Files that must never ship in the APK. */
const isSecret = (name) =>
  name === '.env' ||
  name.startsWith('.env.') ||
  /\.(pem|key|crt|p12|pfx|jks|keystore)$/i.test(name);

/** Copy a tree, skipping secrets, the given directory names and symlinks. */
function copyTree(src, dst, skipDirs = new Set()) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (isSecret(e.name)) continue;
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) {
      if (!skipDirs.has(e.name)) copyTree(from, to, skipDirs);
    } else if (e.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

/** Every file under dir, as sorted POSIX paths relative to it. */
function walk(dir, base = dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, acc);
    else if (e.isFile()) acc.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return acc.sort();
}

/**
 * Offline fallback for the proxy's dependencies: copy them (and what they
 * depend on) from the repo's own node_modules, as npm installed them there.
 */
function copyInstalledDeps(pkgDir) {
  const deps = Object.keys(
    JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).dependencies ??
      {},
  );
  const seen = new Set();
  const queue = [...deps];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const src = path.join(repo, 'node_modules', name);
    if (!fs.existsSync(path.join(src, 'package.json'))) return false;
    copyTree(src, path.join(pkgDir, 'node_modules', name), new Set(['node_modules']));
    const meta = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
    queue.push(...Object.keys(meta.dependencies ?? {}));
  }
  return true;
}

// ------------------------------------------------------------------ inputs
const dist = path.join(repo, 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  fail('no build in dist/: run "npm run build" first');
}

// ------------------------------------------------------------------- stage
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

copyTree(dist, path.join(out, 'dist'));
copyTree(
  path.join(repo, 'proxy'),
  path.join(out, 'proxy'),
  new Set(['node_modules', 'test']),
);
fs.copyFileSync(path.join(repo, 'android', 'node', 'main.js'), path.join(out, 'main.js'));
// The keys template for the app's settings screen (no dot: aapt skips dotfiles).
fs.copyFileSync(path.join(repo, '.env.example'), path.join(out, 'env.example'));
const rootPkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
fs.writeFileSync(
  path.join(out, 'package.json'),
  `${JSON.stringify(
    {
      name: 'argus-android-node',
      version: rootPkg.version,
      private: true,
      type: 'module',
      description: 'The Argus proxy and globe as run by the Android app (generated).',
    },
    null,
    2,
  )}\n`,
);

// The proxy's runtime dependencies (ws; selfsigned only for HTTPS), from its
// own lockfile. No install scripts: nothing native is built.
const proxyOut = path.join(out, 'proxy');
if (!argv.includes('--skip-install')) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(
    npm,
    ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: proxyOut, stdio: 'inherit', shell: process.platform === 'win32' },
  );
  if (r.status !== 0) {
    console.warn(
      '[android-bundle] npm ci failed; copying the installed packages instead',
    );
    fs.rmSync(path.join(proxyOut, 'node_modules'), { recursive: true, force: true });
    if (!copyInstalledDeps(proxyOut)) {
      fail(
        'could not install the proxy dependencies (npm ci failed, none installed locally)',
      );
    }
  }
  // Type definitions are never loaded at run time.
  fs.rmSync(path.join(proxyOut, 'node_modules', '@types'), {
    recursive: true,
    force: true,
  });
  fs.rmSync(path.join(proxyOut, 'node_modules', '.package-lock.json'), { force: true });
}

// ---------------------------------------------------------------- manifest
const files = walk(out).filter((f) => f !== MANIFEST);
const leaked = files.filter((f) => isSecret(f.split('/').pop()));
if (leaked.length) fail(`refusing to stage secrets: ${leaked.join(', ')}`);

const hash = crypto.createHash('sha256');
let bytes = 0;
for (const f of files) {
  const data = fs.readFileSync(path.join(out, f));
  bytes += data.length;
  hash.update(f).update('\0').update(data);
}
const build = hash.digest('hex').slice(0, 16);
fs.writeFileSync(
  path.join(out, MANIFEST),
  `${JSON.stringify({ version: 1, build, files })}\n`,
);

console.log(
  `[android-bundle] staged ${files.length} files (${(bytes / 1048576).toFixed(1)} MiB), build ${build}`,
);
console.log(`[android-bundle]   -> ${path.relative(repo, out) || out}`);
