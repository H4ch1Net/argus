#!/usr/bin/env node
// argus: one entry point for every way to run the project.
//
//   argus web    build (if stale) and serve the globe + its proxy on one origin
//   argus proxy  run just the proxy (for `npm run dev`, or a remote client)
//   argus tui    the full-screen terminal version (Linux / any terminal)
//   argus <cmd>  scriptable passive lookups (query, correlate, quakes, ...)
//
// Cross-platform (Node only), so it is the same on Kali, other Linux, Windows,
// and macOS. GUARDRAIL: every command reads already-public indexes through the
// proxy's allowlist; nothing here scans or sends traffic at a target.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `argus: live public-data globe, passive OSINT console, terminal view

usage: argus <command> [options]

run the app
  web [--https] [--port N] [--host ADDR] [--build] [--no-build] [--open]
                         build the web app if sources changed, then serve it and
                         the proxy together (default https://:8787 with --https).
                         Open the printed LAN URL on the phone; --open launches
                         this machine's browser.
  proxy [--https] [--port N] [--host ADDR]
                         just the proxy (pair with "npm run dev")
  tui [--proxy URL] [--demo] [--ascii] [--no-color] [--at LAT,LON] [--span DEG]
                         full-screen terminal version (press ? inside for keys)

passive lookups (add --json for machine-readable output, --proxy URL to use a
running proxy instead of an embedded one)
  query <ip|domain|asn>        RIPEstat registry/routing/geo enrichment
  correlate <ip|domain|asn>    multi-source correlation (RIPEstat + Shodan host)
  quakes [--min M] [--limit N] [--feed all_day|all_hour|all_week|significant_week]
  flights --near <LAT,LON|place> [--radius NM] [--limit N]
  sats [--group stations|visual|active|starlink|gps-ops|weather] [--limit N]
  fires --near <LAT,LON|place> [--radius KM]
  geocode <place>
  bgp [--count N]              stream sampled RIPE RIS Live BGP updates
  ct [--count N]               stream Certificate Transparency issuance
  health                       which feeds are configured on the proxy

keys and secrets live in .env (repo root) or ~/.config/argus/.env, read only by
the proxy. Inputs are network assets (IP, domain, ASN), never people.
`;

function flag(argv, name) {
  return argv.includes(name);
}
function opt(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

// --- web: build when stale, then serve app + proxy on one origin ------------

const SOURCES = [
  'index.html',
  'main.js',
  'styles.css',
  'core',
  'shell-mobile',
  'shell-desktop',
  'public',
];

function newestMtime(p) {
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.mtimeMs;
  let newest = 0;
  for (const name of fs.readdirSync(p)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    newest = Math.max(newest, newestMtime(path.join(p, name)));
  }
  return newest;
}

function buildIsStale(dist) {
  const built = newestMtime(path.join(dist, 'index.html'));
  if (!built) return true;
  return SOURCES.some((s) => newestMtime(path.join(repoRoot, s)) > built);
}

function runBuild() {
  const viteCli = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(viteCli)) {
    console.error('[argus] vite is not installed. Run "npm install" in the repo first.');
    process.exit(1);
  }
  console.log('[argus] building the web app (vite build)...');
  const r = spawnSync(process.execPath, [viteCli, 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error('[argus] build failed');
    process.exit(r.status ?? 1);
  }
}

async function cmdServe(argv, { serveApp }) {
  const { loadEnvFiles } = await import('../proxy/lib/env.js');
  const { startProxy } = await import('../proxy/lib/start.js');
  const { lanAddresses } = await import('../proxy/lib/createServer.js');
  const envFiles = loadEnvFiles();

  let staticDir;
  if (serveApp) {
    staticDir = path.join(repoRoot, 'dist');
    const force = flag(argv, '--build');
    const skip = flag(argv, '--no-build');
    if (force || (!skip && buildIsStale(staticDir))) runBuild();
    if (!fs.existsSync(path.join(staticDir, 'index.html'))) {
      console.error('[argus] no build found in dist/. Run without --no-build.');
      process.exit(1);
    }
  }

  const opts = {};
  if (flag(argv, '--https')) opts.https = true;
  if (opt(argv, '--port') !== undefined) opts.port = Number(opt(argv, '--port'));
  if (opt(argv, '--host') !== undefined) opts.host = opt(argv, '--host');
  if (staticDir) opts.staticDir = staticDir;
  const proxy = await startProxy(opts);

  const lan = proxy.host ? [] : lanAddresses();
  console.log('');
  console.log(serveApp ? '  ARGUS is up' : '  ARGUS proxy is up');
  console.log(`    this machine : ${proxy.url}`);
  for (const ip of lan)
    console.log(`    LAN / phone  : ${proxy.url.replace('localhost', ip)}`);
  if (serveApp && !proxy.https) {
    console.log('');
    console.log('    The phone needs HTTPS for location, compass and install:');
    console.log(
      '    restart with "npm run start:https" and accept the certificate once.',
    );
  }
  console.log(
    `    keys from    : ${envFiles.length ? envFiles.join(', ') : 'no .env found (keyless feeds only)'}`,
  );
  console.log('');

  if (serveApp && flag(argv, '--open')) openBrowser(proxy.url);

  const shutdown = () => proxy.close().finally(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** Open a URL in the default browser (xdg-open on Linux, start on Windows). */
function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' })
      .on('error', () => console.log(`    open ${url} in a browser`))
      .unref();
  } catch {
    console.log(`    open ${url} in a browser`);
  }
}

// --- dispatch -----------------------------------------------------------------

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === 'web') return cmdServe(argv, { serveApp: true });
  if (cmd === 'proxy') return cmdServe(argv, { serveApp: false });
  if (cmd === 'tui') {
    const { runTui } = await import('../shell-terminal/index.js');
    return runTui(argv);
  }
  const { runCli, CLI_COMMANDS } = await import('../shell-terminal/cli.js');
  if (CLI_COMMANDS.includes(cmd)) {
    process.exitCode = await runCli(cmd, argv);
    return;
  }
  console.error(`argus: unknown command "${cmd}" (try "argus help")`);
  process.exitCode = 2;
}

main().catch((err) => {
  console.error(`[argus] ${err?.message || err}`);
  process.exit(1);
});
