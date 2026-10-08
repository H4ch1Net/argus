// .env loading for the proxy (and anything that embeds it, like the terminal
// shell). Feed secrets live in a dotenv file on the machine running the proxy,
// never in the browser. Real environment variables always win over file values,
// and an earlier file wins over a later one, so precedence is:
//
//   process env  >  ARGUS_ENV_FILE  >  <repo>/.env  >  <repo>/proxy/.env  >  ~/.config/argus/.env
//
// The XDG location lets an installed `argus` command (npm link / npm i -g) find
// keys without being run from the repo.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

/** The candidate env files, highest precedence first. */
export function envFileCandidates(env = process.env) {
  const xdg = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return [
    env.ARGUS_ENV_FILE || null,
    path.join(repoRoot, '.env'),
    path.join(repoRoot, 'proxy', '.env'),
    path.join(xdg, 'argus', '.env'),
  ].filter(Boolean);
}

/**
 * Parse dotenv text into a plain object. Only used when the runtime lacks
 * process.loadEnvFile; handles KEY=value, quotes, `export`, and # comments.
 * @param {string} text
 */
export function parseDotEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    // A quoted value may be followed by a comment: KEY="a b" # note
    const quoted = value.match(/^(['"])(.*?)\1\s*(?:#.*)?$/);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, '').trim();
    out[m[1]] = value;
  }
  return out;
}

/**
 * Load every existing candidate file into `env` without overriding values that
 * are already set. Returns the files that were loaded (for a startup log line).
 * @param {{ env?: NodeJS.ProcessEnv, files?: string[] }} [opts]
 */
export function loadEnvFiles({ env = process.env, files = envFileCandidates(env) } = {}) {
  const loaded = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // missing or unreadable: skip silently
    }
    for (const [k, v] of Object.entries(parseDotEnv(text))) {
      if (env[k] === undefined) env[k] = v;
    }
    loaded.push(file);
  }
  return loaded;
}
