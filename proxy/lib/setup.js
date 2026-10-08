// Key setup from inside the app (the SETUP tab), so a phone or a fresh Kali
// install never needs a text editor: GET /setup/keys lists the keys the feeds
// can use and whether each is set (never a value), POST /setup/keys saves new
// ones to the user's keys file (~/.config/argus/.env, mode 600, or
// ARGUS_KEYS_FILE) and applies them to this process.
//
// Keys stay where they always lived: on the machine that runs the proxy. The
// browser only carries what the user just typed, once, to its own proxy.
// Writes are refused unless the request comes from this machine (loopback),
// from the app's own origin, as JSON with the X-Argus-Setup header (a
// cross-site page cannot send that header without a preflight the proxy does
// not grant), and only for names the feeds actually use. ARGUS_SETUP=off turns
// writing off entirely.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDotEnv } from './env.js';
import { readBody, sendJson } from './respond.js';

// Keys outside the feed registry: the websocket feeds and the tile broker.
const EXTRA_KEYS = [
  { name: 'AISSTREAM_API_KEY', label: 'AISStream (ships)', restart: true },
  { name: 'GOOGLE_MAPS_API_KEY', label: 'Google Photorealistic 3D Tiles' },
];

/** Every key name the proxy can use, with what it unlocks. */
export function knownKeys(feeds) {
  const keys = new Map();
  const add = (name, label, extra = {}) => {
    if (!name || keys.has(name)) {
      if (name && label && !keys.get(name).feeds.includes(label))
        keys.get(name).feeds.push(label);
      return;
    }
    keys.set(name, { name, feeds: label ? [label] : [], restart: false, ...extra });
  };
  for (const f of feeds) {
    for (const rule of f.inject ?? []) add(rule.secret, f.id);
    if (f.auth?.type === 'oauth2') {
      add(f.auth.clientId, f.id, { restart: true });
      add(f.auth.clientSecret, f.id, { restart: true });
    }
    if (f.baseUrlEnv) add(f.baseUrlEnv, f.id, { kind: 'url' });
  }
  for (const k of EXTRA_KEYS) add(k.name, k.label, { restart: Boolean(k.restart) });
  return [...keys.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** The file new keys are written to. */
export function keysFile(env = process.env) {
  if (env.ARGUS_KEYS_FILE) return env.ARGUS_KEYS_FILE;
  const xdg = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'argus', '.env');
}

const NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
// Printable ASCII, no quotes or whitespace that would break the dotenv line.
const VALUE = /^[\x21\x23-\x26\x28-\x7e]{1,512}$/;

/**
 * Merge new values into dotenv text, keeping every other line (comments
 * included). An empty value removes the key.
 */
export function mergeDotEnv(text, updates) {
  const lines = String(text || '').split(/\r?\n/);
  const done = new Set();
  const out = [];
  for (const line of lines) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && m[1] in updates) {
      if (!done.has(m[1]) && updates[m[1]]) out.push(`${m[1]}=${updates[m[1]]}`);
      done.add(m[1]);
      continue;
    }
    out.push(line);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  for (const [k, v] of Object.entries(updates))
    if (!done.has(k) && v) out.push(`${k}=${v}`);
  return `${out.join('\n')}\n`;
}

function isLoopback(req) {
  const a = String(req.socket?.remoteAddress || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin GET-like fetches may omit it
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/**
 * GET or POST /setup/keys.
 * @param {{ feeds: object[], env?: object, file?: string }} ctx
 */
export async function handleSetup(req, res, { feeds, env = process.env, file } = {}) {
  const keys = knownKeys(feeds);
  if (req.method === 'GET') {
    sendJson(res, 200, {
      writable: env.ARGUS_SETUP !== 'off' && isLoopback(req),
      file: isLoopback(req) ? (file ?? keysFile(env)) : undefined,
      keys: keys.map((k) => ({ ...k, set: Boolean(env[k.name]) })),
    });
    return;
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'GET or POST' });
  if (env.ARGUS_SETUP === 'off')
    return sendJson(res, 403, { error: 'setup is turned off (ARGUS_SETUP=off)' });
  if (!isLoopback(req))
    return sendJson(res, 403, {
      error: 'keys can only be set on the machine running the proxy',
    });
  if (!sameOrigin(req) || req.headers['x-argus-setup'] !== '1')
    return sendJson(res, 403, { error: 'not from the app' });
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || '')))
    return sendJson(res, 415, { error: 'JSON only' });
  let body;
  try {
    body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8'));
  } catch {
    return sendJson(res, 400, { error: 'bad JSON' });
  }
  const allowed = new Map(keys.map((k) => [k.name, k]));
  const updates = {};
  for (const [name, value] of Object.entries(body?.keys ?? {})) {
    if (!NAME.test(name) || !allowed.has(name))
      return sendJson(res, 400, { error: `unknown key ${String(name).slice(0, 64)}` });
    const v = String(value ?? '').trim();
    if (v && !VALUE.test(v))
      return sendJson(res, 400, { error: `bad value for ${name}` });
    updates[name] = v;
  }
  if (!Object.keys(updates).length)
    return sendJson(res, 400, { error: 'nothing to save' });
  const target = file ?? keysFile(env);
  let text = '';
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch {
    // a first key: the file does not exist yet
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, mergeDotEnv(text, updates), { mode: 0o600 });
  fs.chmodSync(target, 0o600);
  // Apply now: relayed feeds read their secret per request. OAuth and the
  // websocket feeds read theirs at start, so those need a restart.
  for (const [k, v] of Object.entries(updates)) {
    if (v) env[k] = v;
    else delete env[k];
  }
  const restart = Object.keys(updates).some((k) => allowed.get(k).restart);
  sendJson(res, 200, {
    saved: Object.keys(updates),
    restartNeeded: restart,
    keys: keys.map((k) => ({ ...k, set: Boolean(env[k.name]) })),
  });
}

export { parseDotEnv };
