// Cockpit briefing: what is around the subject you are flying with. Three pages
// for a rotating strip (LIVE SIGNALS, REGIONAL NEWS, LOCAL INFO) built from the
// reverse-geocoded place (Nominatim /reverse), current weather (Open-Meteo),
// headlines about the place (Google News RSS, with GDELT as the fallback) and
// the nearest tracked contacts. Plus the weather-effect profile a cockpit cloud
// or rain overlay can draw from.
//
// Adapted from gods-eye-view server/providers/regional/{news,weather,briefing}.js,
// src/data/regionalModel.js, src/weatherEffectsMath.js and
// src/ui/cockpitSignals.js (MIT). The reference names the region from a 2.6 MB
// Natural Earth bundle; Argus asks Nominatim instead.
//
// Pure and Cesium-free (the terminal shell may use it): parsers and query
// builders, plus fetchBriefing, which takes an injected proxy client. Every
// request goes through the proxy feeds 'nominatim', 'openmeteo', 'gnews' and
// 'gdelt' (proxy/feeds/imagery.js). All text it returns is plain text: render it
// with textContent, never innerHTML.
//
// Guardrail: the news searches use the PLACE name derived from coordinates,
// never free text, so this can never become a search for a person.

export const OPEN_METEO_CURRENT =
  'temperature_2m,apparent_temperature,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,visibility';
/** Refresh the briefing after this long, or after the subject moves this far. */
export const BRIEF_REFRESH_MS = 5 * 60 * 1000;
export const BRIEF_REFRESH_DISTANCE_M = 25_000;
/** How long each page stays up in the rotating strip. */
export const BRIEF_PAGE_MS = 9000;
export const MAX_ARTICLES = 5;

/** Credits the briefing must show beside the data it displays (core/credits.js). */
export const BRIEF_CREDITS = {
  weather: { text: 'Weather data by Open-Meteo.com', url: 'https://open-meteo.com/' },
  gnews: { text: 'Google News', url: 'https://news.google.com/' },
  gdelt: { text: 'GDELT Project', url: 'https://www.gdeltproject.org/' },
  place: {
    text: '© OpenStreetMap contributors',
    url: 'https://www.openstreetmap.org/copyright',
  },
};

const MAX_RSS_CHARS = 2 * 1024 * 1024;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const clean = (v, max = 180) =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

function safeHttpUrl(v) {
  try {
    const u = new URL(String(v ?? ''));
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** A coordinate rounded to `digits` decimals, as a query string value. */
export function roundCoord(v, digits = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new TypeError('coordinate must be finite');
  return String(Number(n.toFixed(digits)));
}

function point({ latitude, longitude } = {}) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90)
    throw new TypeError('a finite latitude and longitude are required');
  // Wrap the longitude into [-180, 180) so a camera past the antimeridian works.
  return { lat, lon: ((((lon + 180) % 360) + 360) % 360) - 180 };
}

// --- query builders (each matches its feed's pinned query) ------------------

/** Open-Meteo current conditions: getJson('openmeteo', '/forecast', { params }). */
export function openMeteoQuery(where) {
  const { lat, lon } = point(where);
  return {
    latitude: roundCoord(lat),
    longitude: roundCoord(lon),
    current: OPEN_METEO_CURRENT,
    timezone: 'UTC',
  };
}

/**
 * Nominatim reverse geocode at city level (zoom 10): enough to name the region,
 * deliberately not a street address. getJson('nominatim', '/reverse', { params }).
 */
export function reverseQuery(where) {
  const { lat, lon } = point(where);
  return {
    format: 'jsonv2',
    lat: roundCoord(lat),
    lon: roundCoord(lon),
    zoom: '10',
    addressdetails: '1',
    'accept-language': 'en',
  };
}

/** The search term for a place: its locality, else region, else country. */
export function newsTerm(place) {
  const raw = place?.locality || place?.region || place?.country || '';
  const term = [...String(raw)]
    .filter((ch) => {
      const c = ch.codePointAt(0);
      return c >= 0x20 && c !== 0x7f && ch !== '"' && ch !== '\\';
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
    .trim();
  return term || null;
}

/** Google News RSS search: getText('gnews', '/search', { params }). */
export function gnewsQuery(term) {
  return { q: term, hl: 'en-US', gl: 'US', ceid: 'US:en' };
}

/** GDELT DOC 2.0 article list: getText('gdelt', '/doc', { params }). */
export function gdeltQuery(term, { maxRecords = MAX_ARTICLES, timespan = '48h' } = {}) {
  return {
    query: `"${term}"`,
    mode: 'artlist',
    format: 'json',
    maxrecords: String(Math.max(1, Math.min(10, Math.trunc(maxRecords) || MAX_ARTICLES))),
    sort: 'datedesc',
    timespan,
  };
}

// --- place --------------------------------------------------------------------

/** A Nominatim reverse answer as { label, locality, region, country, countryCode }. */
export function normalizePlace(payload) {
  const a = payload?.address || {};
  const locality = clean(
    a.city || a.town || a.village || a.municipality || a.hamlet || a.county,
    90,
  );
  const region = clean(a.state || a.region || a.county, 90);
  const country = clean(a.country, 90);
  const label =
    [locality, region].filter((v, i, all) => v && all.indexOf(v) === i).join(', ') ||
    country ||
    clean(payload?.display_name, 120);
  if (!label) return null;
  return {
    label,
    locality: locality || null,
    region: region || null,
    country: country || null,
    countryCode: clean(a.country_code, 4).toUpperCase() || null,
  };
}

// --- news ---------------------------------------------------------------------

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function codePointText(n) {
  if (!Number.isInteger(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff))
    return '';
  return String.fromCodePoint(n);
}

/** XML text to plain text: CDATA unwrapped, entities decoded once, tags dropped. */
function decodeText(v) {
  return String(v ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(
      /&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos));/g,
      (_, d, h, n) =>
        d
          ? codePointText(Number(d))
          : h
            ? codePointText(parseInt(h, 16))
            : XML_ENTITIES[n],
    )
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tagText(block, tag) {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return m ? decodeText(m[1]) : '';
}

function isoOrNull(raw) {
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Parse an RSS 2.0 feed (Google News search) into at most `limit` articles:
 * { title, url, domain, publishedAt }. A document that declares a DOCTYPE or an
 * ENTITY is refused outright (no entity expansion of any kind happens here, and
 * a feed has no business declaring either), as is one over 2 MB.
 * @throws {Error} on a refused document
 */
export function parseRss(xml, limit = MAX_ARTICLES) {
  const text = String(xml ?? '');
  if (text.length > MAX_RSS_CHARS) throw new Error('RSS document too large');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text))
    throw new Error('RSS document with DOCTYPE/ENTITY declarations refused');
  const max = Math.max(1, Math.min(20, Math.trunc(limit) || MAX_ARTICLES));
  const seen = new Set();
  const out = [];
  for (const m of text.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const item = m[1];
    const title = tagText(item, 'title').slice(0, 180);
    const url = safeHttpUrl(tagText(item, 'link'));
    if (!title || !url) continue;
    const source = tagText(item, 'source').slice(0, 80);
    const sourceUrl = safeHttpUrl(
      decodeText(/<source\b[^>]*\burl\s*=\s*"([^"]*)"/i.exec(item)?.[1] ?? ''),
    );
    const domain =
      source ||
      (sourceUrl ? new URL(sourceUrl).hostname : new URL(url).hostname).replace(
        /^www\./,
        '',
      );
    const sig = `${title.toLowerCase()}|${domain.toLowerCase()}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({ title, url, domain, publishedAt: isoOrNull(tagText(item, 'pubDate')) });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Parse a GDELT DOC 2.0 artlist answer (object or JSON text; GDELT answers some
 * errors as plain text, which yields []) into { title, url, domain,
 * publishedAt, sourceCountry } articles. Article HTML is never trusted.
 */
export function parseGdeltArtlist(payload, limit = MAX_ARTICLES) {
  let body = payload;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return [];
    }
  }
  const rows = Array.isArray(body?.articles) ? body.articles : [];
  const max = Math.max(1, Math.min(MAX_ARTICLES, Math.trunc(limit) || MAX_ARTICLES));
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const url = safeHttpUrl(row?.url || row?.url_mobile);
    const title = clean(row?.title, 180);
    if (!url || !title) continue;
    const host = new URL(url).hostname.replace(/^www\./, '');
    const sig = `${title.toLowerCase()}|${host}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    const raw = clean(row?.seendate, 32);
    const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(raw);
    out.push({
      title,
      url,
      domain: clean(row?.domain || host, 80),
      publishedAt: compact
        ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z`
        : isoOrNull(raw),
      sourceCountry: clean(row?.sourcecountry, 60) || null,
    });
    if (out.length >= max) break;
  }
  return out;
}

// --- weather ------------------------------------------------------------------

const WMO_TEXT = {
  0: 'CLEAR',
  1: 'MAINLY CLEAR',
  2: 'PARTLY CLOUDY',
  3: 'OVERCAST',
  45: 'FOG',
  48: 'RIME FOG',
  51: 'LIGHT DRIZZLE',
  53: 'DRIZZLE',
  55: 'DENSE DRIZZLE',
  56: 'LIGHT FREEZING DRIZZLE',
  57: 'FREEZING DRIZZLE',
  61: 'LIGHT RAIN',
  63: 'RAIN',
  65: 'HEAVY RAIN',
  66: 'LIGHT FREEZING RAIN',
  67: 'FREEZING RAIN',
  71: 'LIGHT SNOW',
  73: 'SNOW',
  75: 'HEAVY SNOW',
  77: 'SNOW GRAINS',
  80: 'LIGHT SHOWERS',
  81: 'SHOWERS',
  82: 'VIOLENT SHOWERS',
  85: 'SNOW SHOWERS',
  86: 'HEAVY SNOW SHOWERS',
  95: 'THUNDERSTORM',
  96: 'THUNDERSTORM, HAIL',
  99: 'THUNDERSTORM, HEAVY HAIL',
};

/** A WMO weather code (as Open-Meteo reports it) as terse uppercase text. */
export function weatherCodeText(code) {
  if (code === null || code === undefined || code === '') return 'CONDITIONS UNKNOWN';
  const c = Number(code);
  if (!Number.isFinite(c)) return 'CONDITIONS UNKNOWN';
  if (WMO_TEXT[c]) return WMO_TEXT[c];
  // Codes outside the table fall back to their family.
  if (c >= 51 && c <= 57) return 'DRIZZLE';
  if (c >= 61 && c <= 67) return 'RAIN';
  if (c >= 71 && c <= 77) return 'SNOW';
  if (c >= 80 && c <= 82) return 'SHOWERS';
  if (c >= 85 && c <= 86) return 'SNOW SHOWERS';
  if (c >= 95) return 'THUNDERSTORM';
  return 'MIXED CONDITIONS';
}

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** Compass point a wind blows FROM, e.g. 'NW'; '' when unknown. */
export function windCardinal(deg) {
  if (deg === null || deg === undefined || deg === '') return '';
  const d = Number(deg);
  if (!Number.isFinite(d)) return '';
  return CARDINALS[Math.round((((d % 360) + 360) % 360) / 45) % 8];
}

/**
 * Open-Meteo current conditions as a small record (null without a temperature).
 * Open-Meteo's times are zone-less UTC (we ask for timezone=UTC); they are
 * pinned to UTC explicitly, since JS reads a zone-less time as local.
 */
export function normalizeWeather(payload) {
  const cur = payload?.current;
  if (!cur || numOrNull(cur.temperature_2m) === null) return null;
  const rawTime =
    typeof cur.time === 'string' && !/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(cur.time)
      ? `${cur.time}Z`
      : cur.time;
  const weatherCode = numOrNull(cur.weather_code);
  return {
    observedAt: isoOrNull(rawTime),
    temperatureC: numOrNull(cur.temperature_2m),
    apparentTemperatureC: numOrNull(cur.apparent_temperature),
    precipitationMm: numOrNull(cur.precipitation),
    cloudCoverPct: numOrNull(cur.cloud_cover),
    windKph: numOrNull(cur.wind_speed_10m),
    windDirectionDeg: numOrNull(cur.wind_direction_10m),
    visibilityM: numOrNull(cur.visibility),
    weatherCode,
    summary: weatherCodeText(weatherCode),
  };
}

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));
function range01(v, min, max) {
  if (v === null || v === undefined || !Number.isFinite(Number(v)) || max <= min)
    return 0;
  return clamp01((Number(v) - min) / (max - min));
}

/**
 * Observed weather as bounded visual strengths (0..1) for a cockpit overlay.
 * The WMO code picks the effect family; the numbers only set its strength.
 * Missing weather fails clear instead of inventing conditions.
 */
export function weatherEffectProfile(weather) {
  if (!weather || numOrNull(weather.weatherCode) === null) {
    return {
      available: false,
      cloud: 0,
      rain: 0,
      snow: 0,
      fog: 0,
      haze: 0,
      droplets: 0,
      storm: 0,
      wind: 0,
      windDirectionDeg: 0,
    };
  }
  const code = Number(weather.weatherCode);
  const cover = range01(weather.cloudCoverPct, 8, 100);
  const precip = Math.max(0, Number(weather.precipitationMm) || 0);
  const wind = range01(weather.windKph, 4, 90);
  const vis = numOrNull(weather.visibilityM);
  const visFog = vis !== null ? range01(12000 - vis, 0, 11500) : 0;

  const drizzle = code >= 51 && code <= 57;
  const rainCode = (code >= 61 && code <= 67) || (code >= 80 && code <= 82) || code >= 95;
  const snowCode = (code >= 71 && code <= 77) || (code >= 85 && code <= 86);
  const fogCode = code === 45 || code === 48;
  const stormCode = code >= 95;

  const observed = range01(precip, 0.05, 8);
  const rainFloor = drizzle ? 0.12 : rainCode ? (stormCode ? 0.68 : 0.28) : 0;
  const rain = drizzle || rainCode ? Math.max(rainFloor, observed) : 0;
  const snow = snowCode ? Math.max(0.3, observed) : 0;
  const fog = Math.max(fogCode ? 0.78 : 0, visFog);
  const storm = stormCode ? Math.max(0.55, observed) : 0;
  const forcedCloud = stormCode ? 0.92 : rain || snow ? 0.7 : fogCode ? 0.55 : 0;
  const cloud = Math.max(cover, forcedCloud);
  const dir = numOrNull(weather.windDirectionDeg);

  return {
    available: true,
    cloud: clamp01(cloud),
    rain: clamp01(rain),
    snow: clamp01(snow),
    fog: clamp01(fog),
    haze: clamp01(Math.max(fog * 0.78, cloud * 0.14 + (rain + snow) * 0.2)),
    droplets: clamp01(rain * (0.58 + storm * 0.42)),
    storm: clamp01(storm),
    wind,
    windDirectionDeg: dir !== null ? ((dir % 360) + 360) % 360 : 0,
  };
}

/** Fade ground-weather overlays as the camera climbs above their layer. */
export function weatherAltitudeFactors(altitudeM) {
  const alt = Math.max(0, Number(altitudeM) || 0);
  return {
    precipitation: 1 - range01(alt, 6000, 14000),
    cloud: 1 - range01(alt, 14000, 24000),
    haze: 1 - range01(alt, 9000, 20000),
  };
}

// --- contacts -----------------------------------------------------------------

function latLonOf(p) {
  const src = p?.position ?? p;
  const lat = numOrNull(src?.latitude);
  const lon = numOrNull(src?.longitude);
  return lat === null || lon === null ? null : { lat, lon };
}

/** Great-circle distance in metres between two { latitude, longitude } (or records). */
export function distanceM(a, b) {
  const p = latLonOf(a);
  const q = latLonOf(b);
  if (!p || !q) return Infinity;
  const r = Math.PI / 180;
  const dLat = (q.lat - p.lat) * r;
  const dLon = (q.lon - p.lon) * r;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(p.lat * r) * Math.cos(q.lat * r) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/**
 * The `limit` nearest contacts to the subject, nearest first, each with its
 * distanceM. Candidates are layer records ({ id, position: { latitude,
 * longitude } }) or plain { latitude, longitude } objects; ones without a
 * position, the subject itself (`excludeId`), and ones beyond maxDistanceM are
 * left out.
 */
export function nearestContacts(
  subject,
  candidates,
  { limit = 5, maxDistanceM = Infinity, excludeId = null } = {},
) {
  if (!latLonOf(subject)) return [];
  const out = [];
  for (const c of candidates || []) {
    if (excludeId != null && c?.id === excludeId) continue;
    const d = distanceM(subject, c);
    if (!Number.isFinite(d) || d > maxDistanceM) continue;
    out.push({ ...c, distanceM: d });
  }
  out.sort((a, b) => a.distanceM - b.distanceM);
  return out.slice(0, Math.max(0, Math.trunc(limit)));
}

/** '4.2 KM' under 10 km, '12 KM' beyond; 'DISTANCE UNKNOWN' otherwise. */
export function formatDistance(m) {
  if (!finite(m) || m < 0) return 'DISTANCE UNKNOWN';
  return m < 10_000 ? `${(m / 1000).toFixed(1)} KM` : `${Math.round(m / 1000)} KM`;
}

/**
 * Whether a briefing fetched at last.at for last.point is due again: after
 * BRIEF_REFRESH_MS, or once the subject has moved BRIEF_REFRESH_DISTANCE_M.
 */
export function needsRefresh(last, where, now = Date.now()) {
  if (!last || !finite(last.at)) return true;
  if (now - last.at >= BRIEF_REFRESH_MS) return true;
  return distanceM(last.point, where) >= BRIEF_REFRESH_DISTANCE_M;
}

// --- assembly -----------------------------------------------------------------

const round = (v) => Math.round(v);

/**
 * The strip's three pages as plain-text lines. Each line may carry a `url`
 * (an article) or a `target` ({ layer, id }, a contact to select); each page
 * carries the credit to show with it.
 * @param {{ place?: object|null, weather?: object|null,
 *   news?: { articles?: object[], source?: string|null }|null,
 *   contacts?: Array<{ id: string, layer?: string, label?: string, kind?: string,
 *     distanceM: number }> }} brief
 */
export function briefingPages({
  place = null,
  weather = null,
  news = null,
  contacts = [],
}) {
  const signals = (contacts || []).map((c) => ({
    text: clean(c.label || c.id, 40).toUpperCase(),
    detail: [c.kind ? clean(c.kind, 30).toUpperCase() : null, formatDistance(c.distanceM)]
      .filter(Boolean)
      .join(' · '),
    target: c.layer ? { layer: c.layer, id: c.id } : null,
  }));

  const articles = news?.articles || [];
  const newsLines = articles.map((a) => ({
    text: a.title,
    detail: a.domain,
    url: a.url,
  }));

  const local = [];
  if (place?.label) local.push({ text: place.label.toUpperCase() });
  if (weather) {
    let line = `${round(weather.temperatureC)}°C · ${weather.summary}`;
    const feels = weather.apparentTemperatureC;
    if (finite(feels) && Math.abs(feels - weather.temperatureC) >= 2)
      line += ` · FEELS ${round(feels)}°C`;
    local.push({ text: line });
    const parts = [];
    if (finite(weather.windKph))
      parts.push(
        `WIND ${round(weather.windKph)} KM/H ${windCardinal(weather.windDirectionDeg)}`.trim(),
      );
    if (finite(weather.visibilityM))
      parts.push(
        `VIS ${weather.visibilityM >= 10_000 ? round(weather.visibilityM / 1000) : (weather.visibilityM / 1000).toFixed(1)} KM`,
      );
    if (finite(weather.cloudCoverPct))
      parts.push(`CLOUD ${round(weather.cloudCoverPct)}%`);
    if (parts.length) local.push({ text: parts.join(' · ') });
  }

  const newsCredit =
    news?.source === 'gnews'
      ? BRIEF_CREDITS.gnews
      : news?.source === 'gdelt'
        ? BRIEF_CREDITS.gdelt
        : null;
  return [
    {
      id: 'signals',
      title: 'LIVE SIGNALS',
      lines: signals.length ? signals : [{ text: 'NO CONTACTS NEARBY' }],
      credit: null,
    },
    {
      id: 'news',
      title: 'REGIONAL NEWS',
      lines: newsLines.length ? newsLines : [{ text: 'NO REGIONAL HEADLINES' }],
      credit: newsCredit,
    },
    {
      id: 'local',
      title: 'LOCAL INFO',
      lines: local.length ? local : [{ text: 'LOCAL CONDITIONS UNAVAILABLE' }],
      credit: weather ? BRIEF_CREDITS.weather : place ? BRIEF_CREDITS.place : null,
    },
  ];
}

function abortError() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

/**
 * Headlines about a place: Google News RSS first, GDELT when it fails or is
 * empty. `sources` can drop either (e.g. ['gdelt'] to skip Google News, whose
 * terms allow personal, non-commercial use only).
 * @returns {Promise<{ status: 'ready'|'empty'|'unavailable', term: string|null,
 *   source: 'gnews'|'gdelt'|null, articles: object[] }>}
 */
export async function fetchNews({
  proxyClient,
  place,
  signal,
  sources = ['gnews', 'gdelt'],
}) {
  const term = newsTerm(place);
  if (!term) return { status: 'unavailable', term: null, source: null, articles: [] };
  let tried = false;
  if (sources.includes('gnews')) {
    tried = true;
    try {
      const xml = await proxyClient.getText('gnews', '/search', {
        params: gnewsQuery(term),
        signal,
      });
      const articles = parseRss(xml);
      if (articles.length) return { status: 'ready', term, source: 'gnews', articles };
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
    }
  }
  if (sources.includes('gdelt')) {
    try {
      const text = await proxyClient.getText('gdelt', '/doc', {
        params: gdeltQuery(term),
        signal,
      });
      const articles = parseGdeltArtlist(text);
      return {
        status: articles.length ? 'ready' : 'empty',
        term,
        source: 'gdelt',
        articles,
      };
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      return { status: 'unavailable', term, source: null, articles: [] };
    }
  }
  return { status: tried ? 'empty' : 'unavailable', term, source: null, articles: [] };
}

/**
 * Fetch one briefing for a point through the proxy: place and weather in
 * parallel, then headlines for the place. Any source may fail on its own; the
 * status is 'ready' with all three, 'partial' with some, and it throws only when
 * none answered (or on abort).
 * @param {{ proxyClient: { getJson: Function, getText: Function },
 *   latitude: number, longitude: number, signal?: AbortSignal,
 *   newsSources?: string[], now?: () => number }} opts
 */
export async function fetchBriefing({
  proxyClient,
  latitude,
  longitude,
  signal,
  newsSources,
  now = () => Date.now(),
}) {
  const where = { latitude, longitude };
  const [placeR, weatherR] = await Promise.allSettled([
    proxyClient.getJson('nominatim', '/reverse', { params: reverseQuery(where), signal }),
    proxyClient.getJson('openmeteo', '/forecast', {
      params: openMeteoQuery(where),
      signal,
    }),
  ]);
  if (signal?.aborted) throw abortError();
  const place = placeR.status === 'fulfilled' ? normalizePlace(placeR.value) : null;
  const weather =
    weatherR.status === 'fulfilled' ? normalizeWeather(weatherR.value) : null;
  const news = await fetchNews({ proxyClient, place, signal, sources: newsSources });
  if (!place && !weather && news.status === 'unavailable')
    throw new Error('no briefing source answered');
  return {
    status: place && weather && news.status !== 'unavailable' ? 'ready' : 'partial',
    retrievedAt: new Date(now()).toISOString(),
    point: where,
    place,
    weather,
    news,
  };
}
