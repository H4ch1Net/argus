// GDELT events (the master plan's "News / events" layer), pure: the fixed
// theme queries and the parser. No Cesium, no DOM: the terminal uses it too.
//
// Per the provider's documentation, not live-tested here: the GDELT GEO 2.0
// API, GET https://api.gdeltproject.org/api/v2/geo/geo?query=...&mode=PointData
// &format=GeoJSON, answers a FeatureCollection of places mentioned in the
// last 24 hours of matching coverage: properties { name, count, shareimage,
// html } where html lists article links. GDELT answers some errors as plain
// text, which parses as no events.
//
// GUARDRAIL: only these fixed GKG theme queries are ever sent (the proxy pins
// them, proxy/feeds/context.js): never user free text, so the layer cannot be
// turned into a search for a person. It maps where events are reported.

export const GDELT_GEO_PATH = '/geo';
export const GDELT_THEMES = Object.freeze([
  { id: 'disaster', label: 'Natural disaster', query: 'theme:NATURAL_DISASTER' },
  { id: 'unrest', label: 'Protest / unrest', query: 'theme:PROTEST' },
  { id: 'conflict', label: 'Armed conflict', query: 'theme:ARMEDCONFLICT' },
]);

export const gdeltQuery = (theme) => ({
  query: theme.query,
  mode: 'PointData',
  format: 'GeoJSON',
});

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
const decode = (s) =>
  String(s ?? '')
    .replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e) => ENTITIES[e])
    .replace(/<[^>]*>/g, ' ')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function safeUrl(raw) {
  try {
    const u = new URL(decode(raw));
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Article links in a GEO answer's html snippet: [{ title, url, domain }], at most `limit`. */
export function gdeltArticles(html, limit = 5) {
  const out = [];
  const seen = new Set();
  const re = /<a\b([^>]*)>([\s\S]{0,400}?)<\/a>/gi;
  for (const m of String(html ?? '')
    .slice(0, 20_000)
    .matchAll(re)) {
    const attrs = m[1];
    const url = safeUrl(/\bhref\s*=\s*"([^"]{1,600})"/i.exec(attrs)?.[1] ?? '');
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = (
      decode(/\btitle\s*=\s*"([^"]{0,400})"/i.exec(attrs)?.[1] ?? '') || decode(m[2])
    ).slice(0, 160);
    out.push({
      title: title || new URL(url).hostname,
      url,
      domain: new URL(url).hostname.replace(/^www\./, ''),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * One theme's GEO answer (object or JSON text) -> normalized event points.
 * @param {object|string} payload
 * @param {{ id: string, label: string }} theme
 */
export function parseGdeltGeo(payload, theme) {
  let json = payload;
  if (typeof payload === 'string') {
    try {
      json = JSON.parse(payload);
    } catch {
      return [];
    }
  }
  const features = Array.isArray(json?.features) ? json.features : [];
  const out = [];
  const seen = new Set();
  for (const f of features.slice(0, 2000)) {
    const c = f?.geometry?.type === 'Point' ? f.geometry.coordinates : null;
    if (!Array.isArray(c)) continue;
    const [lon, lat] = c;
    if (
      !Number.isFinite(lon) ||
      !Number.isFinite(lat) ||
      Math.abs(lon) > 180 ||
      Math.abs(lat) > 90
    )
      continue;
    const id = `gdelt/${theme.id}/${lon.toFixed(3)},${lat.toFixed(3)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const p = f.properties ?? {};
    const articles = gdeltArticles(p.html);
    const count = Number.isFinite(Number(p.count))
      ? Math.max(0, Math.round(Number(p.count)))
      : articles.length;
    out.push({
      id,
      type: 'event',
      position: { longitude: lon, latitude: lat, altitude: 0 },
      meta: {
        theme: theme.id,
        themeLabel: theme.label,
        place: decode(p.name).slice(0, 120),
        count,
        articles,
        headline: articles[0]?.title ?? '',
        demo: p.demo === true,
      },
    });
  }
  return out;
}

/** Every theme's answer ({ [themeId]: payload }) -> one list. */
export function parseGdeltThemes(byTheme) {
  const out = [];
  for (const theme of GDELT_THEMES) {
    if (byTheme?.[theme.id] != null) out.push(...parseGdeltGeo(byTheme[theme.id], theme));
  }
  return out;
}
