// Terminal shell entry: binds the app (app.js) to a real TTY. This is the third
// shell beside shell-mobile and shell-desktop: same core data engine, same
// proxy, same command language, rendered as a braille world map in any terminal
// (Kali's default terminal, a Linux console over SSH, Windows Terminal).
//
// Usage: argus tui [--proxy URL] [--demo] [--ascii] [--no-color]
//                  [--at LAT,LON] [--span DEG] [--layers a,b,c] [--sats GROUP]

import { createTuiApp } from './app.js';
import { connectBackend } from './backend.js';
import { parseKeys } from './keys.js';
import { seq, detectColorMode, detectUnicode } from './ansi.js';

function opt(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/** "33.7,-116.3" -> { lat, lon } or null. */
export function parseLatLon(s) {
  const m = String(s ?? '').match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

export function parseTuiArgs(argv, env = process.env) {
  const at = parseLatLon(opt(argv, '--at') ?? env.ARGUS_HOME);
  const span = Number(opt(argv, '--span'));
  return {
    proxyUrl: opt(argv, '--proxy') ?? null,
    demo: argv.includes('--demo'),
    ascii: argv.includes('--ascii'),
    noColor: argv.includes('--no-color'),
    at: at ? { ...at, span: Number.isFinite(span) && span > 0 ? span : undefined } : null,
    layers:
      opt(argv, '--layers')
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean) ?? null,
    satGroup: opt(argv, '--sats') ?? 'stations',
  };
}

export async function runTui(argv = []) {
  // .env first, so settings like ARGUS_HOME can live there next to the keys.
  if (!argv.includes('--demo')) (await import('../proxy/lib/env.js')).loadEnvFiles();
  const args = parseTuiArgs(argv);
  const { stdin, stdout } = process;
  if (!stdout.isTTY || !stdin.isTTY) {
    console.error(
      'argus tui needs an interactive terminal. For scripts use: argus query|quakes|flights ... --json',
    );
    process.exitCode = 2;
    return;
  }

  const warnings = [];
  const backend = await connectBackend({
    proxyUrl: args.proxyUrl,
    demo: args.demo,
    warn: (m) => warnings.push(m),
  });

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try {
      stdout.write(
        seq.mouseOff + '\x1b[?1002l' + seq.reset + seq.showCursor + seq.altScreenOff,
      );
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
    } catch {
      // terminal already gone
    }
  };

  let app;
  const finish = async (code = 0) => {
    app?.stop();
    restore();
    await backend.close().catch(() => {});
    process.exit(code);
  };

  app = createTuiApp({
    backend,
    write: (s) => stdout.write(s),
    size: () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 }),
    unicode: !args.ascii && detectUnicode(),
    colorMode: detectColorMode(process.env, { noColor: args.noColor }),
    at: args.at,
    satGroup: args.satGroup,
    onQuit: () => finish(0),
  });

  // Take over the terminal; always give it back, even on a crash.
  stdout.write(
    seq.altScreenOn + seq.hideCursor + seq.clear + seq.mouseOn + '\x1b[?1002h',
  );
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  process.on('exit', restore);
  process.on('SIGTERM', () => finish(0));
  process.on('SIGHUP', () => finish(0));
  // Ctrl-C arrives as a key in raw mode; this covers `kill -INT` from outside.
  process.on('SIGINT', () => finish(130));
  process.on('uncaughtException', (err) => {
    restore();
    console.error('[argus tui] crashed:', err);
    process.exit(1);
  });

  stdin.on('data', (chunk) => app.handleKeys(parseKeys(chunk)));
  stdout.on('resize', () => app.forceRedraw());

  for (const w of warnings) app.log(w, 'warn');
  await app.start({ layers: args.layers });
}
