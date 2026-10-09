// GDELT 2.0 Events for the "News events" layer (the GDELT GEO 2.0 API it used
// is gone: 404 since 2026). GDELT publishes a machine-coded event table every
// 15 minutes as a zipped, tab-separated export; lastupdate.txt names the
// latest one with its size and MD5. This reads that list, fetches the export
// over HTTPS (pinned paths only, see the 'gdelt-events' feed in
// proxy/feeds/context.js), unzips it (lib/zip.js), keeps the events that fit
// the layer's themes, merges repeats of one event type at one place, and
// serves a small JSON document. The last hour (four exports) is kept so the
// map is not just one 15-minute slice; older slots are fetched once each.
//
// Themes from CAMEO, the event coding GDELT uses (CAMEO 1.1b3):
//   unrest   root 14, Protest (demonstrations, strikes, blockades, riots)
//   conflict roots 18 Assault, 19 Fight, 20 Unconventional mass violence
//   aid      0233 Appeal for humanitarian aid, 0333 Express intent to provide
//            humanitarian aid, 073 Provide humanitarian aid
// CAMEO has no natural-disaster code, so the old "natural disaster" theme has
// no equivalent; humanitarian aid (which follows disasters and conflicts) is
// the closest the coding allows. Everything else is dropped.
//
// GUARDRAIL: only where and what kind of event was reported, how often and in
// what tone, and the article link. The actor columns (names and codes of who
// did what to whom) are never read.
//
// Live-checked Oct 2026: lastupdate.txt and an export (67 KB zip, one 419 KB
// CSV entry, 61 columns, 1,025 rows) fetched over HTTPS; proxy/test/fixtures
// holds a trimmed copy. The fetch through Node was not run here.

import crypto from 'node:crypto';
import { readSingleEntry } from './zip.js';

export const GDELT_PATH = '/gdeltv2';
const SLOT_MS = 15 * 60_000;
const EXPORT_FILE = /^(\d{14})\.export\.CSV\.zip$/;
const EXPORT_ENTRY = /^\d{14}\.export\.CSV$/;

// GDELT 2.0 event table columns (0-based) read here, of 61.
const COL = {
  code: 26,
  root: 28,
  quad: 29,
  goldstein: 30,
  mentions: 31,
  sources: 32,
  articles: 33,
  tone: 34,
  geoType: 51,
  place: 52,
  country: 53,
  lat: 56,
  lon: 57,
  added: 59,
  url: 60,
};
const COLUMNS = 61;

/** 'unrest' | 'conflict' | 'aid' for a CAMEO event code, else null (dropped). */
export function gdeltTheme(code) {
  const c = String(code ?? '');
  if (!/^\d{2,4}$/.test(c)) return null;
  const root = c.slice(0, 2);
  if (root === '14') return 'unrest';
  if (root === '18' || root === '19' || root === '20') return 'conflict';
  if (c === '0233' || c === '0333' || c.startsWith('073')) return 'aid';
  return null;
}

/** "20261009060000" -> ms (UTC), or NaN. */
export function stampMs(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(stamp));
  if (!m) return NaN;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  return new Date(ms).getUTCDate() === d ? ms : NaN;
}

const two = (n) => String(n).padStart(2, '0');
/** ms -> "20261009060000". */
export function msStamp(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}`;
}

/** The latest stamp and the n - 1 export slots before it, newest first. */
export function slotStamps(latest, n) {
  const t = stampMs(latest);
  return Array.from({ length: n }, (_, i) => msStamp(t - i * SLOT_MS));
}

/**
 * lastupdate.txt -> the export line { stamp, size, md5 }, or null. Lines are
 * "<bytes> <md5> http://data.gdeltproject.org/gdeltv2/<stamp>.export.CSV.zip";
 * only the file name is taken from it (the fetch is pinned to HTTPS).
 */
export function parseLastUpdate(text) {
  for (const line of String(text ?? '')
    .slice(0, 4096)
    .split(/\r?\n/)) {
    const m = /^(\d{1,9})\s+([0-9a-f]{32})\s+(\S{1,200})$/.exec(line.trim());
    if (!m) continue;
    let u;
    try {
      u = new URL(m[3]);
    } catch {
      continue;
    }
    if (u.hostname !== 'data.gdeltproject.org') continue;
    const file = /^\/gdeltv2\/([^/]+)$/.exec(u.pathname)?.[1] ?? '';
    const name = EXPORT_FILE.exec(file);
    if (!name || !Number.isFinite(stampMs(name[1]))) continue;
    return { stamp: name[1], size: Number(m[1]), md5: m[2] };
  }
  return null;
}

const clean = (s, n) =>
  String(s ?? '')
    // Control characters (U+0000-001F, U+007F-009F), spelled out: the Node 18
    // in the Android app has no Unicode property data for \p{Cc}.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);

function safeUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s || s.length > 600) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

const num = (s) => (s === '' || s == null ? NaN : Number(s));

/** "20261009060000" -> "2026-10-09T06:00:00Z", or null. */
const stampIso = (s) => {
  const ms = stampMs(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace('.000Z', 'Z') : null;
};

/**
 * One export's tab-separated text -> the events that fit a theme, with a
 * usable action place: { theme, code, quad, goldstein, mentions, sources,
 * articles, tone, geo, place, cc, lat, lon, added, url }.
 */
export function parseExportTsv(text, { maxRows = 100_000 } = {}) {
  const out = [];
  const lines = String(text ?? '').split('\n');
  for (let i = 0; i < lines.length && i < maxRows; i += 1) {
    const cols = lines[i].replace(/\r$/, '').split('\t');
    if (cols.length < COLUMNS) continue;
    const code = cols[COL.code];
    const theme = gdeltTheme(code);
    if (!theme || cols[COL.root] !== code.slice(0, 2)) continue;
    const geo = Number(cols[COL.geoType]);
    const lat = num(cols[COL.lat]);
    const lon = num(cols[COL.lon]);
    if (!(geo >= 1 && geo <= 5)) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) continue;
    const mentions = Math.max(0, Math.round(num(cols[COL.mentions]) || 0));
    const tone = num(cols[COL.tone]);
    const goldstein = num(cols[COL.goldstein]);
    const quad = Number(cols[COL.quad]);
    out.push({
      theme,
      code,
      quad: quad >= 1 && quad <= 4 ? quad : null,
      goldstein: goldstein >= -10 && goldstein <= 10 ? goldstein : null,
      mentions,
      sources: Math.max(0, Math.round(num(cols[COL.sources]) || 0)),
      articles: Math.max(0, Math.round(num(cols[COL.articles]) || 0)),
      tone: Number.isFinite(tone) ? Math.max(-100, Math.min(100, tone)) : null,
      geo,
      place: clean(cols[COL.place], 120),
      cc: /^[A-Z]{2}$/.test(cols[COL.country]) ? cols[COL.country] : '',
      lat,
      lon,
      added: stampIso(cols[COL.added]),
      url: safeUrl(cols[COL.url]),
    });
  }
  return out;
}

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Repeats of one event code at one place -> one record (n = how many events,
 * mentions / sources / articles summed, tone averaged by mentions, the latest
 * time, up to three distinct links, most-mentioned first); the most-mentioned
 * `max` are kept.
 */
export function mergeGdeltEvents(events, { max = 1500 } = {}) {
  const byKey = new Map();
  const ordered = [...events].sort((a, b) => b.mentions - a.mentions);
  for (const e of ordered) {
    const key = `${e.lat.toFixed(3)},${e.lon.toFixed(3)}|${e.code}`;
    let m = byKey.get(key);
    if (!m) {
      m = {
        ...e,
        n: 0,
        mentions: 0,
        sources: 0,
        articles: 0,
        toneSum: 0,
        toneW: 0,
        urls: [],
      };
      delete m.url;
      byKey.set(key, m);
    }
    m.n += 1;
    m.mentions += e.mentions;
    m.sources += e.sources;
    m.articles += e.articles;
    if (e.tone !== null) {
      const w = Math.max(1, e.mentions);
      m.toneSum += e.tone * w;
      m.toneW += w;
    }
    if (e.added && (!m.added || e.added > m.added)) m.added = e.added;
    if (e.url && m.urls.length < 3 && !m.urls.includes(e.url)) m.urls.push(e.url);
  }
  return [...byKey.values()]
    .sort((a, b) => b.mentions - a.mentions || b.n - a.n)
    .slice(0, max)
    .map(({ toneSum, toneW, ...m }) => ({
      ...m,
      lat: round(m.lat, 4),
      lon: round(m.lon, 4),
      tone: toneW ? round(toneSum / toneW, 2) : null,
    }));
}

/**
 * The 'gdelt-events' producer: called by the relay on a cache miss with a
 * pinned fetch (lib/relay.js pinnedFetcher). Keeps the parsed exports of the
 * last `windowFiles` slots between calls; concurrent calls share one build.
 */
export function createGdeltEventsProducer({
  windowFiles = 4,
  maxEvents = 1500,
  maxZipBytes = 8 * 1024 * 1024,
  maxCsvBytes = 64 * 1024 * 1024,
} = {}) {
  const files = new Map(); // stamp -> parsed events
  let inflight = null;

  async function load(fetchPinned, stamp, listed) {
    const zip = await fetchPinned(`${GDELT_PATH}/${stamp}.export.CSV.zip`, {
      maxBytes: maxZipBytes,
    });
    // The latest export is checked against the size and MD5 GDELT lists for it.
    if (listed) {
      const md5 = crypto.createHash('md5').update(zip).digest('hex');
      if (zip.length !== listed.size || md5 !== listed.md5)
        throw new Error('GDELT export does not match lastupdate.txt');
    }
    const { data } = await readSingleEntry(zip, {
      maxBytes: maxCsvBytes,
      name: EXPORT_ENTRY,
    });
    return parseExportTsv(data.toString('utf8'));
  }

  async function build(fetchPinned) {
    const list = await fetchPinned(`${GDELT_PATH}/lastupdate.txt`, { maxBytes: 4096 });
    const latest = parseLastUpdate(list.toString('utf8'));
    if (!latest) throw new Error('GDELT lastupdate.txt lists no export');
    const wanted = slotStamps(latest.stamp, windowFiles);
    for (const s of [...files.keys()]) if (!wanted.includes(s)) files.delete(s);
    for (const [i, stamp] of wanted.entries()) {
      if (files.has(stamp)) continue;
      try {
        files.set(stamp, await load(fetchPinned, stamp, i === 0 ? latest : null));
      } catch (err) {
        // The latest export must load; an older slot that fails (GDELT skips
        // one now and then) only shortens the window until the next refresh.
        if (i === 0) throw err;
      }
    }
    const have = wanted.filter((s) => files.has(s));
    const events = mergeGdeltEvents(
      have.flatMap((s) => files.get(s)),
      { max: maxEvents },
    );
    const doc = {
      v: 1,
      source: 'GDELT 2.0 Events',
      updated: stampIso(latest.stamp),
      windowMinutes: have.length * 15,
      exports: have.length,
      events,
    };
    return { contentType: 'application/json', body: Buffer.from(JSON.stringify(doc)) };
  }

  return ({ fetch }) => {
    inflight ??= build(fetch).finally(() => {
      inflight = null;
    });
    return inflight;
  };
}
