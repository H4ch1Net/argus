// GDELT events (the master plan's "News / events" layer), pure: the feed
// address, the themes, CAMEO labels and the parser. No Cesium, no DOM: the
// terminal uses it too.
//
// The GDELT GEO 2.0 API this layer used is gone (404 since 2026). The proxy now
// builds the data itself from GDELT 2.0's 15-minute Event exports (the last
// hour of them) and serves one JSON document at
// /feed/gdelt-events/events.json (proxy/lib/gdelt.js):
//   { v: 1, updated, windowMinutes, exports, events: [{ theme, code, quad,
//     goldstein, mentions, sources, articles, tone, geo, place, cc, lat, lon,
//     added, n, urls }] }
// where each event is one CAMEO event type at one place, merged over its
// repeats (n), and urls are up to three article links.
//
// GUARDRAIL: the client sends no query at all; the proxy keeps fixed event
// classes only and never the actor columns. The layer maps where events are
// reported, never who.

export const GDELT_FEED = 'gdelt-events';
export const GDELT_EVENTS_PATH = '/events.json';

// CAMEO has no natural-disaster code: the old "natural disaster" theme became
// humanitarian aid (appeals, pledges and deliveries of it), its nearest kin.
export const GDELT_THEMES = Object.freeze([
  { id: 'aid', label: 'Humanitarian aid' },
  { id: 'unrest', label: 'Protest / unrest' },
  { id: 'conflict', label: 'Armed conflict / violence' },
]);
const THEME_BY_ID = new Map(GDELT_THEMES.map((t) => [t.id, t]));

// CAMEO 1.1b3 labels for the codes the proxy keeps (roots 14, 18, 19, 20 and
// the humanitarian-aid codes). A code without its own label falls back to its
// three-digit base, then its root.
export const CAMEO = Object.freeze({
  '0233': 'Appeal for humanitarian aid',
  '0333': 'Intent to provide humanitarian aid',
  '073': 'Provide humanitarian aid',
  14: 'Protest',
  140: 'Political dissent',
  141: 'Demonstrate or rally',
  1411: 'Demonstrate for leadership change',
  1412: 'Demonstrate for policy change',
  1413: 'Demonstrate for rights',
  1414: 'Demonstrate for change in institutions',
  142: 'Hunger strike',
  143: 'Strike or boycott',
  144: 'Obstruct passage, block',
  145: 'Violent protest, riot',
  18: 'Assault',
  180: 'Unconventional violence',
  181: 'Abduct, hijack or take hostage',
  182: 'Physical assault',
  1821: 'Sexual assault',
  1822: 'Torture',
  1823: 'Killing by physical assault',
  183: 'Non-military bombing',
  1831: 'Suicide bombing',
  1832: 'Vehicular bombing',
  1833: 'Roadside bombing',
  1834: 'Location bombing',
  184: 'Use as human shield',
  185: 'Attempted assassination',
  186: 'Assassination',
  19: 'Fight',
  190: 'Conventional military force',
  191: 'Blockade, restricted movement',
  192: 'Occupy territory',
  193: 'Fight with small arms',
  194: 'Fight with artillery and tanks',
  195: 'Aerial weapons',
  1951: 'Precision-guided aerial munitions',
  1952: 'Remotely piloted aerial munitions',
  196: 'Ceasefire violation',
  20: 'Unconventional mass violence',
  200: 'Unconventional mass violence',
  201: 'Mass expulsion',
  202: 'Mass killings',
  203: 'Ethnic cleansing',
  204: 'Weapons of mass destruction',
  2041: 'Chemical, biological or radiological weapons',
  2042: 'Nuclear weapons',
});

/** Human label for a CAMEO code (exact, else its base, else its root). */
export function cameoLabel(code) {
  const c = String(code ?? '');
  return CAMEO[c] ?? CAMEO[c.slice(0, 3)] ?? CAMEO[c.slice(0, 2)] ?? `Event ${c}`;
}

const PRECISION = { 1: 'country', 2: 'US state', 3: 'US city', 4: 'city', 5: 'region' };

const clean = (s, n) =>
  String(s ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);

function safeUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 600) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * A readable title for an article link, from its URL: the slug of its path
 * ("/2026/10/09/floods-hit-valencia.html" -> "Floods hit valencia"), else the
 * site. GDELT's export carries no titles.
 */
export function articleTitle(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return '';
  }
  const site = u.hostname.replace(/^www\./, '');
  let segs = [];
  try {
    segs = u.pathname.split('/').map((s) => decodeURIComponent(s));
  } catch {
    segs = [];
  }
  const slug = segs
    .reverse()
    .map((s) => s.replace(/\.[a-z0-9]{2,5}$/i, ''))
    .find((s) => /[a-z]{2,}[-_][a-z]{2,}/i.test(s));
  if (!slug) return site;
  const words = slug
    .split(/[-_+]+/)
    .filter((w) => w && !/^\d+$/.test(w) && !/^[0-9a-f]{8,}$/i.test(w));
  const text = clean(words.join(' '), 90);
  return text ? text[0].toUpperCase() + text.slice(1) : site;
}

const finite = (v, lo, hi) => (Number.isFinite(v) && v >= lo && v <= hi ? v : null);

/**
 * The proxy's events document (object or JSON text) -> normalized event
 * points. Anything malformed parses as no events.
 */
export function parseGdeltEvents(payload) {
  let doc = payload;
  if (typeof payload === 'string') {
    try {
      doc = JSON.parse(payload);
    } catch {
      return [];
    }
  }
  const list = Array.isArray(doc?.events) ? doc.events : [];
  const out = [];
  const seen = new Set();
  for (const e of list.slice(0, 3000)) {
    const theme = THEME_BY_ID.get(e?.theme);
    const code = typeof e?.code === 'string' && /^\d{2,4}$/.test(e.code) ? e.code : null;
    const lat = finite(e?.lat, -90, 90);
    const lon = finite(e?.lon, -180, 180);
    if (!theme || !code || lat === null || lon === null) continue;
    const id = `gdelt/${code}/${lat.toFixed(3)},${lon.toFixed(3)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const articles = [];
    for (const raw of Array.isArray(e.urls) ? e.urls.slice(0, 3) : []) {
      const url = safeUrl(raw);
      if (!url || articles.some((a) => a.url === url)) continue;
      const domain = new URL(url).hostname.replace(/^www\./, '');
      articles.push({ title: articleTitle(url) || domain, url, domain });
    }
    const added = typeof e.added === 'string' ? Date.parse(e.added) : NaN;
    out.push({
      id,
      type: 'event',
      position: { longitude: lon, latitude: lat, altitude: 0 },
      meta: {
        theme: theme.id,
        themeLabel: theme.label,
        code,
        codeLabel: cameoLabel(code),
        quadClass: finite(e.quad, 1, 4),
        goldstein: finite(e.goldstein, -10, 10),
        tone: finite(e.tone, -100, 100),
        place: clean(e.place, 120),
        country: typeof e.cc === 'string' && /^[A-Z]{2}$/.test(e.cc) ? e.cc : '',
        precision: PRECISION[e.geo] ?? '',
        count: Math.max(0, Math.round(finite(e.mentions, 0, 1e9) ?? 0)),
        events: Math.max(1, Math.round(finite(e.n, 1, 1e9) ?? 1)),
        articles,
        headline: articles[0]?.title ?? '',
        addedMs: Number.isFinite(added) ? added : null,
        demo: e.demo === true,
      },
    });
  }
  return out;
}

/** "GDELT 06:00Z, 1 h" for the layer menu, from the document. */
export function gdeltStatusNote(doc) {
  if (!doc || typeof doc !== 'object' || typeof doc.updated !== 'string') return '';
  const t = doc.updated.slice(11, 16);
  const span = Number(doc.windowMinutes) >= 60 ? `${doc.windowMinutes / 60} h` : '';
  return [`GDELT ${t}Z`, span].filter(Boolean).join(', ');
}
