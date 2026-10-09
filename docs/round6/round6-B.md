# Round 6, worker B: logs, feed reliability, CHP, news, key transfer

Owner's asks covered: feed-failure popups moved to a LOGS section out of
sight; CHP and the news layer made to work; easy, secure import and export of
API keys; the same on every target (desktop, Linux, Android app, Android
Auto: all of it lives in core, main.js and the proxy the Android app embeds).

## What was built

### 1. LOGS instead of error popups

- `core/ui/logs.js` (new): `createLogStore({ capacity = 300, now })` ->
  `add({ level, source, title, body?, t? })`, `list({ level? })` (newest
  first, copies), `clear()`, `subscribe(fn)` (batched per microtask),
  plus `counts({ since })`, `seq`, `size`, `toText()`. A repeat of the same
  source + title folds into one entry (`count`, `first`, `t` = latest). Text
  is sanitized and capped (title 160, body 600). Nothing is persisted.
- Same file: `isFailureNotice(n)` (a notice about something that could not be
  reached: FAILED / ERROR / UNREACHABLE / TIMED OUT / NOT SAVED / NO STILL /
  STALE in the title, or "responded 5xx", "upstream", "did not answer",
  "timed out", "needs the live proxy"... in the body; never `level:
'critical'`), `copyText(text)` (clipboard API, else a selected textarea for
  older WebViews), and `createLogsPanel(store)`: the LOGS section, collapsed
  by default, `[+]`/`[-]` caret, a count badge of warnings and errors not yet
  seen (red when any error), ALL / ERR / WARN / INFO, CLEAR, COPY ALL. It
  builds no rows while closed, re-renders at most every 250 ms while open
  (150 rows max), and repaints the badge at most once a second.
- `core/ui/hud/notify.js`: `createNotifier({ log })`. With a `log`, any
  `push()` that `isFailureNotice` matches goes to the log instead of a card.
  `kind: 'failure'` forces the log, `kind: 'notice'` forces a card. Critical
  notices always show.
- `core/ui/setupTab.js`: LOGS is the last section of SETUP (`logs` option).

### 2. Feed reliability in the proxy (`proxy/lib/relay.js`)

- New Feed fields (documented in `proxy/feeds.js`): `timeoutMs` (per attempt;
  default stays `PROXY_UPSTREAM_TIMEOUT_MS` / 15 s), `mirrors` (other https
  instances of the same API, no secrets allowed, checked in `validateFeeds`),
  `retries` (extra attempts on the same base), `freshConnection` (sends
  `Connection: close`; if a fetch refuses that header, as an older undici
  may, the request goes again without it), `validate(body, headers)` (false =
  a 200 that is not an answer: tried elsewhere, never cached), `produce` +
  `upstreamPaths` (the proxy builds the body itself from pinned upstream
  files), `cache.maxBytes` (a per-feed byte cap in the response cache).
- Order of attempts: OVERPASS_URL-style override (or the feed's base), the
  feed's own base when overridden, then mirrors; one client request tries
  each instance at most once. 429, 5xx, a network error or a timeout cools
  that base down for 5 minutes: it is skipped meanwhile, and when every base
  is cooling a request makes one try only (at the first to recover), so an
  outage is never multiplied across instances (`createRelayRuntime()` per
  request handler in `lib/app.js`).
- `queue: { concurrency, maxWaitMs, maxQueued }` (new Feed field): at most
  `concurrency` requests upstream at once, the rest wait in order (FIFO
  `createLimiter`), and a governor rate refusal waits for room in the minute
  (`retryAfterMs`, new in `lib/governor.js`) within maxWaitMs instead of a 429. A client that hangs up while waiting is dropped before anything is
  sent. Identical cached requests in flight share one upstream call (the
  others wait and get it as a cache hit; if it failed, they get the stale
  copy or an error, never a repeat).
- Stale-if-error: when every attempt fails, a cached feed answers with its
  last good body plus `x-argus-cache: stale` and `x-argus-stale: <age s>`.
  A validated-bad body with nothing better is passed on uncached with
  `x-argus-invalid: 1`. A mirror's answer carries `x-argus-upstream: <host>`.
  Errors now say "upstream timed out after 15 s" or the network error code.
- The governor still counts one per client request (however many mirrors are
  tried) and refunds as before.
- Overpass (`proxy/feeds.js`): mirrors `maps.mail.ru/osm/tools/overpass/api`
  then `overpass.kumi.systems/api` (its data was months old here, so last);
  35 s per attempt (queries ask `[timeout:25]`); `validate: overpassAnswered`
  (a 200 whose remark is a "runtime error" moves on); cache 12 h, stale a
  week, 2,000 entries / 24 MB for this feed. Budget (reviewed after E1's 0.1
  degree tiles): queue of 2 at a time (overpass-api.de gives an address two
  slots), up to 500 waiting 3 minutes each, 60 a minute (was 20, refused),
  6,000 a day (the main instance's guidance is "safe below 10,000 a day").
  The response cache's global entry cap went from 200 to 3,000 (still 48 MB
  in all).
- Longer timeouts: celestrak 30 s, firms 30 s, gdelt-events 60 s.
- Client side: `core/net/proxyClient.js` gained `onMeta` per request and
  `client.tracked(onMeta)` (the same client with the hook on every request),
  `readMeta()` -> `{ feedId, stale, cache, upstream, partial }`.
  `core/scene/layerManager.js` `register(key, { ..., decorateStatus })`
  applies a status transform before anyone sees it. `core/ui/layerMenu.js`
  shows `STALE <count>` (dim, dashed bracket, `.is-stale`) when
  `status.stale != null`.

### 3. CHP ("most of the time" it did not work)

Found with the live feed (curl, Oct 9 2026):

- The live document writes every attribute as `ID = "..."` (spaces around
  `=`), with CRLF lines. The parser's regexes required `ID="..."`, so it read
  **zero incidents** from the real feed (old parser: 0 on two live samples;
  new: 146 and 148). Only the demo document parsed.
- `Center` is a division (`LAHB`, `SAHB`...); the communications centre is
  the `Dispatch` inside it (`LACC`). The parser now uses Dispatch (Center as
  a fallback). `CHP_CENTERS` fixed: `STCC` Stockton (was a bad `SKCCSTCC`
  key), added `SUCC` Susanville and `BICC` Bishop.
- About one plain request in three (new connection each time) came from a
  server holding an hour-old copy cut off at exactly 163,840 bytes mid-element
  (the current file is ~247 KB ending in `</State>`); gzip requests and the
  other servers were current. The feed now `validate`s `</State>` at the end,
  retries twice on a fresh connection, never caches a cut copy, falls back to
  the last good copy (stale up to an hour), and only then passes the cut copy
  (the parser reads its complete logs).
- `LogDetails` (sometimes self-closing) is now cut off from the log body
  before anything is read; `"0:0"` positions are dropped as before.
- GUARDRAIL addition: person alerts (Silver / Amber / Blue / Feather,
  missing persons, welfare checks...) are dropped (`chpPersonAlert`).
- Fixture: `core/layers/chp/fixtures/sa-sample.xml` (9 real logs from 4
  centres, narratives replaced). Size limits, timing (~1.4 s), content type
  (`text/xml`) and entities were fine.

### 4. News: GDELT GEO (dead) -> GDELT 2.0 Events

- `proxy/lib/zip.js` (new): single-entry zip reader on `zlib.inflateRaw`
  (central directory, refuses several entries / encryption / zip64 /
  multi-disk / other methods, caps the inflated size, checks length and a
  table CRC-32; `zlib.crc32` is not in the Node 18 the Android app embeds).
- `proxy/lib/gdelt.js` (new): reads `lastupdate.txt` (only the file name is
  taken; fetched over HTTPS), checks the latest export's size and MD5, unzips,
  parses the 61-column TSV (EventCode, EventRootCode, QuadClass,
  GoldsteinScale, NumMentions, NumSources, NumArticles, AvgTone, ActionGeo
  type / full name / country / lat / lon, DATEADDED, SOURCEURL; never the
  actor columns), maps CAMEO: `unrest` = root 14, `conflict` = roots 18, 19,
  20, `aid` = 0233, 0333, 073 (CAMEO has no natural-disaster code; the old
  "Natural disaster" theme became "Humanitarian aid"), drops the rest, merges
  repeats by place + code (n, summed mentions, mention-weighted tone, latest
  time, up to 3 links), caps at 1,500, keeps the last hour (4 exports; older
  slots fetched once each, a missing one skipped), and serves
  `{ v: 1, updated, windowMinutes, exports, events }`.
- Feed `gdelt-events` (`proxy/feeds/context.js`, replaces `gdelt-geo`):
  client path `/feed/gdelt-events/events.json` only, no query; upstream pinned
  to `/gdeltv2/lastupdate.txt` and `/gdeltv2/<14 digits>.export.CSV.zip`;
  cache 15 min, stale 12 h; governor 6/min.
- Core: `core/layers/gdelt/parse.js` (`GDELT_FEED`, `GDELT_EVENTS_PATH`,
  `GDELT_THEMES`, `CAMEO`, `cameoLabel`, `articleTitle` (from the URL slug;
  the export has no titles), `parseGdeltEvents`, `gdeltStatusNote`),
  `source.js` (one getJson), `format.js` (card: event label + CAMEO code,
  place, precision, mentions / events, tone, Goldstein, added; links http(s)
  only), `definition.js` (statusNote "GDELT 06:00Z, 1 h"). Terminal:
  `shell-terminal/layers.js` uses the same parse/format and a new legend.
- Credits: `core/credits.js` gdelt entry feeds `['gdelt', 'gdelt-events']`,
  hosts + `data.gdeltproject.org`.
- Fixtures: `proxy/test/fixtures/gdelt-sample.export.CSV(.zip)` (42 real rows,
  actor names blanked, zipped by Python's zipfile), `gdelt-lastupdate.txt`.
  The real export of 06:00 UTC had 1,025 rows: 97 fit a theme, 63 after
  merging, so the hour holds a few hundred points.

### 5. Key export / import

- `proxy/lib/setup.js`: `POST /setup/keys/export { passphrase }` ->
  `{ bundle, names }`, bundle = `{ v: 1, kdf: 'scrypt', N: 32768, r: 8, p: 1,
salt, iv, tag, data }` (base64; AES-256-GCM; the version and KDF
  parameters are authenticated as AAD). `POST /setup/keys/import` takes
  `{ bundle, passphrase }` or `{ env: '<.env text>' }`. Same gates as a save
  (loopback socket AND loopback Host AND same origin AND `X-Argus-Setup: 1`
  AND JSON; `ARGUS_SETUP=off` disables), passphrase >= 10 characters, body
  <= 64 KB, KDF parameters bounded on import (<= 64 MB of scrypt memory).
  Values validated like a save; on import, names Argus does not use are left
  out and named (`ignored`), and an empty value never removes a key. Wrong
  passphrase and a changed file give one error. No value is ever logged or
  returned; every setup answer is `cache-control: no-store`. `GET
/setup/keys` adds `transfer: true`.
- SETUP > KEYS (top of the section, the key list is long): MOVE KEYS TO
  ANOTHER DEVICE, EXPORT KEYS (passphrase twice, EXPORT: downloads
  `argus-keys.json` via a Blob and shows the bundle with COPY and SAVE FILE,
  since the Android WebView cannot save blob downloads) and IMPORT KEYS (file
  picker, or paste the keys file or `.env` lines, passphrase for a keys file).
  Results show inline in a status line (green / red bracket), not popups; key
  saves report inline too now.

## main.js wiring (exactly)

1. Where the notifier is created: also imports `createLogStore`, creates
   `logs` (`app.logs = logs`), a `log(entry)` helper (adds, and
   `console.warn`s the first occurrence of each failure), passes
   `createNotifier({ log })`, and adds `webglcontextlost` /
   `webglcontextrestored` listeners on `app.viewer.scene.canvas` (log entry +
   a critical `GRAPHICS RESET` notice cleared on restore).
2. Before the registrations loop: `staleSeen`, `trackedClient(key)`
   (`proxyClient.tracked`), `markStale(key, s)`. In the loop, `makeSource`
   passes `trackedClient(r.key)` instead of `proxyClient`, and `register`
   gets `decorateStatus: (s) => markStale(r.key, s)`.
3. The old "FEED ERROR" notification block (`manager.subscribeStatus`) now
   logs: errors (folded), STALE on entering it, BACK on recovery.
4. Terrain `onStatus`: logs instead of a popup.
5. `createSetupTab({ ..., logs })`.
6. The DEMO DATA notice gets `kind: 'notice'`.
7. Dev `window.__argus` gains `logs` and `setup`.

Merged `2231757` (integration) cleanly; tests re-run after the merge.

## Settings keys

None added (`SETTINGS_SCHEMA` untouched). No new env keys either.

## Feeds

- New: `gdelt-events` (removed: `gdelt-geo`, dead).
- Changed: `overpass` (mirrors, validate, 35 s, 12 h cache), `chp-cad`
  (validate, retries 2, freshConnection, stale 1 h), `celestrak` and `firms`
  (30 s timeouts).

## Tests

- `node --test proxy/test/*.test.js`: 162 / 162 pass (new
  `reliability.test.js`, `gdelt.test.js`; extended `setup.test.js`,
  `contextFeeds.test.js`).
- Core + shells: 658 pass, 2 fail (the two known: satellites/propagate,
  scene/occlusion, missing packages). New `core/ui/logs.test.js`; extended
  `chp.test.js` (real fixture, cut copy), `gdelt.test.js` (rewritten),
  `proxyClient.test.js`, `credits.test.js`.
- eslint (scratchpad config) clean; prettier clean on every touched file.

## Harness (port 5202, my server copy forwarding /health, /feed, /setup to a

real proxy from this worktree on 5212)

- Desktop 1440x900 and mobile 412x915: SETUP shows MOVE KEYS at the top of
  KEYS; EXPORT with two passphrases produced the bundle (status "2 KEYS
  EXPORTED: FIRMS_MAP_KEY, SHODAN_API_KEY", file download + text with COPY);
  IMPORT with a wrong passphrase said "wrong passphrase, or the file was
  changed"; with the right one "KEYS IMPORTED"; pasting `.env` lines said "1
  KEY IMPORTED: FIRMS_MAP_KEY. Left out: PROXY_PORT."; the keys file stayed
  mode 600.
- Feeds fail from this container (403), and no popup appeared: LOGS at the
  bottom of SETUP showed a red badge "2", no rows while closed, two ERR rows
  when opened ("FLIGHTS FEED ERROR x2"), ERR filter worked.
- CHP through the proxy from a local copy of the live document
  (`CHP_CAD_URL`): 146 incidents across California. Then the upstream was
  stopped: after the minute of freshness, a refresh showed `STALE 146` in the
  layer row, status note "STALE: the feed is not answering, showing its last
  good data (2M old)", one WARN log entry, still no popup.
- Car (`?shell=car`, 800x480) with flights, chp, gdelt: no page errors, no
  popups; CHP stale, GDELT's error went to the log.
- Demo mode (no proxy): News events 15 points, note "GDELT 06:30Z, 1 h";
  CHP demo 6.

## Not live-tested here

- Node's fetch does not go through this container's egress proxy, so no
  upstream was reached through the Argus proxy itself: the CHP retry on a
  fresh connection, the Overpass mirror order against the real instances,
  and the GDELT producer against data.gdeltproject.org ran only against local
  servers (the real documents were fetched with curl and are the fixtures).
- Whether CHP's load balancer re-balances per connection (what the retry
  relies on) is unknown; the stale fallback covers it either way.
- Node 18 (Android app): no Node 18 here. The code avoids newer APIs
  (`zlib.crc32`), and the `Connection` header has a tested fallback, but it
  was run on Node 20 and 22 only. scrypt (32 MB, N = 2^15) timing on the
  phone is not measured (about 0.1 s on a desktop).
- Clipboard and the file picker inside the Android WebView: COPY falls back
  to `execCommand('copy')`; the picker uses the app's existing
  `onShowFileChooser`.

## For other workers

- Do not add popups for failures: `notify` / `notifier.push` already routes
  anything that reads like a failure to LOGS. To log directly use
  `app.logs?.add({ level, source, title, body })`; to force a popup for
  something that matches the failure words, pass `kind: 'notice'`.
- A / E1: the Overpass proxy cache is per exact URL (the QL), 12 h, 2,000
  entries / 24 MB for that feed. A tile burst is queued in the proxy (2 at a
  time, 60 a minute, up to 3 minutes' wait), so a client should not give up
  on an Overpass tile much sooner than that; past the wait (or 500 waiting,
  or the 6,000-a-day cap) the proxy answers 429 "busy" or the stale copy.
  `layerManager` `register` gained an optional `decorateStatus`;
  `createLayer` is untouched. A layer's status may now carry `stale`
  (seconds) and a `STALE: ...` note.
- Anyone adding a feed: `timeoutMs`, `mirrors`, `retries`, `validate`,
  `produce`, `queue` are available; `validateFeeds` checks them.
- The terminal shell already shows feed failures in its layer list and its
  own message line (no popups there), so it has no LOGS view.
