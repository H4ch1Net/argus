// Key setup from inside the app (the SETUP tab), so a phone or a fresh Kali
// install never needs a text editor: GET /setup/keys lists the keys the feeds
// can use and whether each is set (never a value), POST /setup/keys saves new
// ones to the user's keys file (~/.config/argus/.env, mode 600, or
// ARGUS_KEYS_FILE) and applies them to this process. POST /setup/keys/export
// returns the set keys as a passphrase-encrypted file, and
// POST /setup/keys/import takes that file (or plain .env text) back in, so
// moving keys from a laptop to the phone is two taps and a passphrase.
//
// Keys stay where they always lived: on the machine that runs the proxy. The
// browser only carries what the user just typed, once, to its own proxy, and
// an export only ever leaves encrypted. Writes and exports are refused unless
// the request comes from this machine (loopback), from the app's own origin,
// as JSON with the X-Argus-Setup header (a cross-site page cannot send that
// header without a preflight the proxy does not grant), and only for names
// the feeds actually use. ARGUS_SETUP=off turns all of it off. No value is
// ever logged or sent back.

import crypto from 'node:crypto';
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

// The Host must name this machine by a loopback literal. A page on another
// domain that DNS-rebinds to 127.0.0.1 is same-origin with its own (attacker)
// host, so the loopback socket and same-origin checks would both pass; its Host
// header still carries that domain, which this rejects. A real local WebView or
// browser reaches the proxy as 127.0.0.1 / localhost.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
function loopbackHost(req) {
  const host = String(req.headers.host || '');
  const name = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1) // [::1]:8787 -> [::1]
    : host.split(':')[0];
  return LOOPBACK_HOSTS.has(name);
}

// --------------------------------------------------------- export / import
// The keys move between machines (the laptop's to the phone's proxy) as one
// encrypted file: scrypt turns the passphrase into an AES-256-GCM key, and the
// version and KDF parameters are authenticated with the data, so a changed
// parameter fails like a wrong passphrase. The bundle is
//   { v: 1, kdf: 'scrypt', N, r, p, salt, iv, tag, data }   (base64 fields)
// and its plaintext is { keys: { NAME: value } }. Plain .env text imports too.

export const KDF = Object.freeze({ N: 2 ** 15, r: 8, p: 1 });
export const PASSPHRASE_MIN = 10;
const PASSPHRASE_MAX = 1024;
const BODY_MAX = 64 * 1024;

export class BundleError extends Error {}

const aad = ({ N, r, p }) => Buffer.from(`argus-keys/v1/scrypt/${N}/${r}/${p}`);

function deriveKey(passphrase, salt, { N, r, p }) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(
      String(passphrase).normalize('NFC'),
      salt,
      32,
      { N, r, p, maxmem: 128 * N * r * p + 32 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    ),
  );
}

/** { NAME: value } -> an encrypted bundle (see above). */
export async function encryptKeys(values, passphrase, kdf = KDF) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = await deriveKey(passphrase, salt, kdf);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(kdf));
  const data = Buffer.concat([
    cipher.update(JSON.stringify({ keys: values }), 'utf8'),
    cipher.final(),
  ]);
  const b64 = (b) => b.toString('base64');
  return {
    v: 1,
    kdf: 'scrypt',
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    salt: b64(salt),
    iv: b64(iv),
    tag: b64(cipher.getAuthTag()),
    data: b64(data),
  };
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
function b64Field(bundle, name, min, max) {
  const s = bundle[name];
  if (typeof s !== 'string' || !B64.test(s) || s.length > Math.ceil(max / 3) * 4 + 4)
    throw new BundleError(`not an Argus keys file (${name})`);
  const b = Buffer.from(s, 'base64');
  if (b.length < min || b.length > max)
    throw new BundleError(`not an Argus keys file (${name})`);
  return b;
}

/**
 * An encrypted bundle + passphrase -> { NAME: value }. The KDF parameters are
 * bounded (no file can make this machine spend more than ~64 MB or a few
 * seconds), and any failure to authenticate reads as one error, so a wrong
 * passphrase and a changed file cannot be told apart.
 */
export async function decryptKeys(bundle, passphrase) {
  if (!bundle || typeof bundle !== 'object' || bundle.v !== 1 || bundle.kdf !== 'scrypt')
    throw new BundleError('not an Argus keys file');
  const { N, r, p } = bundle;
  const pow2 = Number.isInteger(N) && N >= 2 ** 14 && N <= 2 ** 18 && (N & (N - 1)) === 0;
  if (
    !pow2 ||
    !Number.isInteger(r) ||
    r < 1 ||
    r > 16 ||
    !Number.isInteger(p) ||
    p < 1 ||
    p > 4 ||
    128 * N * r * p > 64 * 1024 * 1024
  )
    throw new BundleError('unsupported key derivation settings');
  const salt = b64Field(bundle, 'salt', 16, 64);
  const iv = b64Field(bundle, 'iv', 12, 12);
  const tag = b64Field(bundle, 'tag', 16, 16);
  const data = b64Field(bundle, 'data', 1, 48 * 1024);
  let text;
  try {
    const key = await deriveKey(passphrase, salt, { N, r, p });
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad({ N, r, p }));
    decipher.setAuthTag(tag);
    text = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    throw new BundleError('wrong passphrase, or the file was changed');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BundleError('not an Argus keys file');
  }
  const keys = parsed?.keys;
  if (!keys || typeof keys !== 'object' || Array.isArray(keys))
    throw new BundleError('not an Argus keys file');
  return keys;
}

// ------------------------------------------------------------------ gates

/**
 * Why a write (or an export) is refused, or null. Local means the connection
 * came in on loopback AND the Host names a loopback literal (so a rebound
 * public domain, whose Host carries that domain, is not treated as local);
 * then the app's own origin, its header, and a JSON body.
 */
function refusal(req, env) {
  if (env.ARGUS_SETUP === 'off') return [403, 'setup is turned off (ARGUS_SETUP=off)'];
  if (!(isLoopback(req) && loopbackHost(req)))
    return [403, 'keys can only be set on the machine running the proxy'];
  if (!sameOrigin(req) || req.headers['x-argus-setup'] !== '1')
    return [403, 'not from the app'];
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || '')))
    return [415, 'JSON only'];
  return null;
}

// Nothing here may be cached or kept by a browser: lists, bundles, results.
const NO_STORE = { 'cache-control': 'no-store' };

/** Validate { NAME: value } against the known keys. */
function checkUpdates(input, allowed, { skipUnknown = false, skipEmpty = false } = {}) {
  const updates = {};
  const ignored = [];
  for (const [name, value] of Object.entries(input ?? {})) {
    if (!NAME.test(name) || !allowed.has(name)) {
      if (skipUnknown) {
        if (ignored.length < 50) ignored.push(String(name).slice(0, 64));
        continue;
      }
      return { error: `unknown key ${String(name).slice(0, 64)}` };
    }
    const v = String(value ?? '').trim();
    if (!v && skipEmpty) continue;
    if (v && !VALUE.test(v)) return { error: `bad value for ${name}` };
    updates[name] = v;
  }
  return { updates, ignored };
}

/** Write updates to the keys file (mode 600) and apply them to this process. */
function saveUpdates(updates, { env, target, allowed }) {
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
  return Object.keys(updates).some((k) => allowed.get(k).restart);
}

/**
 * GET or POST /setup/keys, POST /setup/keys/export, POST /setup/keys/import.
 * @param {{ feeds: object[], env?: object, file?: string }} ctx
 */
export async function handleSetup(req, res, { feeds, env = process.env, file } = {}) {
  const keys = knownKeys(feeds);
  const local = isLoopback(req) && loopbackHost(req);
  const route = new URL(req.url, 'http://proxy.local').pathname;
  const listed = () => keys.map((k) => ({ ...k, set: Boolean(env[k.name]) }));
  if (req.method === 'GET' && route === '/setup/keys') {
    sendJson(
      res,
      200,
      {
        writable: env.ARGUS_SETUP !== 'off' && local,
        // The file path and key names are shown only to a local request.
        file: local ? (file ?? keysFile(env)) : undefined,
        // This proxy can export and import an encrypted keys file.
        transfer: true,
        keys: listed(),
      },
      NO_STORE,
    );
    return;
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'GET or POST' });
  const refused = refusal(req, env);
  if (refused) return sendJson(res, refused[0], { error: refused[1] }, NO_STORE);
  let body;
  try {
    body = JSON.parse((await readBody(req, BODY_MAX)).toString('utf8'));
  } catch {
    return sendJson(res, 400, { error: 'bad JSON' }, NO_STORE);
  }
  const allowed = new Map(keys.map((k) => [k.name, k]));
  const target = file ?? keysFile(env);

  if (route === '/setup/keys') {
    const { updates, error } = checkUpdates(body?.keys, allowed);
    if (error) return sendJson(res, 400, { error }, NO_STORE);
    if (!Object.keys(updates).length)
      return sendJson(res, 400, { error: 'nothing to save' }, NO_STORE);
    const restart = saveUpdates(updates, { env, target, allowed });
    return sendJson(
      res,
      200,
      { saved: Object.keys(updates), restartNeeded: restart, keys: listed() },
      NO_STORE,
    );
  }

  const passphrase = typeof body?.passphrase === 'string' ? body.passphrase : '';
  const passphraseOk =
    [...passphrase].length >= PASSPHRASE_MIN && passphrase.length <= PASSPHRASE_MAX;

  if (route === '/setup/keys/export') {
    if (!passphraseOk)
      return sendJson(
        res,
        400,
        { error: `the passphrase needs at least ${PASSPHRASE_MIN} characters` },
        NO_STORE,
      );
    const values = {};
    for (const k of keys) if (env[k.name]) values[k.name] = env[k.name];
    const names = Object.keys(values);
    if (!names.length)
      return sendJson(
        res,
        400,
        { error: 'no keys are set: nothing to export' },
        NO_STORE,
      );
    const bundle = await encryptKeys(values, passphrase);
    return sendJson(res, 200, { bundle, names }, NO_STORE);
  }

  // /setup/keys/import: { bundle, passphrase } or { env: '<.env text>' }.
  let input;
  if (body?.bundle != null) {
    if (!passphraseOk)
      return sendJson(
        res,
        400,
        { error: `the passphrase needs at least ${PASSPHRASE_MIN} characters` },
        NO_STORE,
      );
    try {
      input = await decryptKeys(body.bundle, passphrase);
    } catch (err) {
      const msg = err instanceof BundleError ? err.message : 'could not read the file';
      return sendJson(res, 400, { error: msg }, NO_STORE);
    }
  } else if (typeof body?.env === 'string') {
    input = parseDotEnv(body.env);
  } else {
    return sendJson(res, 400, { error: 'send a keys file or .env text' }, NO_STORE);
  }
  // Same rules as a save, except that settings Argus does not use are left
  // out (named in the answer) and an empty value never removes a key, so a
  // template full of empty lines cannot wipe what is set.
  const { updates, ignored, error } = checkUpdates(input, allowed, {
    skipUnknown: true,
    skipEmpty: true,
  });
  if (error) return sendJson(res, 400, { error }, NO_STORE);
  if (!Object.keys(updates).length)
    return sendJson(
      res,
      400,
      { error: 'no key Argus uses was found in it', ignored },
      NO_STORE,
    );
  const restart = saveUpdates(updates, { env, target, allowed });
  sendJson(
    res,
    200,
    { saved: Object.keys(updates), ignored, restartNeeded: restart, keys: listed() },
    NO_STORE,
  );
}

export { parseDotEnv };
