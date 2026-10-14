// Road names as people type them and as OpenStreetMap spells them. One
// folding for both: street words to one abbreviation each ("pkway", "pky",
// "parkway" -> "pkwy"), directions to a letter, and numbered routes to one
// key ("Highway 111", "CA-111", "SR 111", "State Route 111" all name route
// 111; "I-10", "Interstate 10", "I 10" name interstate 10). Used by the place
// ranking (./rank.js) and by the intersection search (./intersection.js),
// which matches a typed street against the names and refs of the road lines
// in the basemap's vector tiles (OpenMapTiles `transportation_name`: name,
// name_en, ref, network). Pure: every shell shares it.

// Every spelling -> the one kept. Abbreviations as the US Census and USPS
// write them, so "Jackson Street" matches "JACKSON ST".
const SPELLINGS = {
  st: ['street', 'str'],
  ave: ['avenue', 'av', 'avn', 'aven', 'avenu'],
  blvd: ['boulevard', 'boul', 'bvd', 'blv', 'boulv'],
  rd: ['road'],
  dr: ['drive', 'drv'],
  ln: ['lane'],
  ct: ['court'],
  pl: ['place'],
  pkwy: ['parkway', 'pkway', 'pky', 'pwy', 'parkwy', 'pkwys'],
  hwy: ['highway', 'hway', 'hiway', 'hwys'],
  fwy: ['freeway', 'frwy', 'freewy'],
  expy: ['expressway', 'expwy', 'expressw', 'expw'],
  tpke: ['turnpike', 'tpk', 'trnpk'],
  ter: ['terrace', 'terr'],
  cir: ['circle', 'circ'],
  sq: ['square'],
  trl: ['trail'],
  mt: ['mount'],
  ft: ['fort'],
  n: ['north'],
  s: ['south'],
  e: ['east'],
  w: ['west'],
  ne: ['northeast'],
  nw: ['northwest'],
  se: ['southeast'],
  sw: ['southwest'],
};

/** Spelling -> canonical word ("parkway" -> "pkwy"). */
export const CANON = new Map();
for (const [canon, list] of Object.entries(SPELLINGS))
  for (const s of list) CANON.set(s, canon);

/** Canonical word -> every spelling, itself included (for prefixes and Overpass). */
export const SPELLED = new Map(
  Object.entries(SPELLINGS).map(([canon, list]) => [canon, [canon, ...list]]),
);

/** The words that make a name a street ("Jackson St", "Golf Center Pkwy"). */
export const STREET_TYPES = new Set([
  'st',
  'ave',
  'blvd',
  'rd',
  'dr',
  'ln',
  'ct',
  'pl',
  'pkwy',
  'hwy',
  'fwy',
  'expy',
  'tpke',
  'ter',
  'cir',
  'trl',
  'way',
  'loop',
  'row',
  'aly',
  'alley',
  'path',
  'pike',
]);

export const DIRECTIONS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);

/** Lower case, accents off, split into words (no folding). */
export function words(s) {
  return (
    String(s ?? '')
      .toLowerCase()
      .normalize('NFKD')
      // Combining marks (U+0300-036F), spelled out.
      .replace(/[̀-ͯ]/g, '')
      // "U.S. 99" -> "us 99", "N.E." -> "ne" (an abbreviation's dots).
      .replace(/\b([a-z])\.(?=[a-z]\.)/g, '$1')
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  );
}

// --------------------------------------------------------------- routes
// A route is { type, num, qual }: type 'I' (interstate), 'US', 'SR' (a state
// route) or '*' (a highway or route of any kind: "Highway 111"); qual a word
// that makes it a variant of the main route (business loop, old alignment).

// State codes taken as a route prefix ("CA 111", "CA-111"). Codes that are
// also common words or street abbreviations (in, or, me, hi, ok, oh, de, co,
// la, pa, ct, ne, mt, ...) are left out: "ne 5th" is not Nebraska 5.
const STATE_CODES = new Set(
  'ak al ar az ca fl ga ia id il ks ky md mn ms nc nd nh nj nm nv ny ri sc sd tn tx ut va vt wa wi wv wy'.split(
    ' ',
  ),
);
const QUALIFIERS = new Map(
  Object.entries({
    bus: 'bus',
    business: 'bus',
    bl: 'bus',
    old: 'old',
    hist: 'old',
    historic: 'old',
    alt: 'alt',
    alternate: 'alt',
    byp: 'byp',
    bypass: 'byp',
    truck: 'truck',
    spur: 'spur',
    conn: 'conn',
    connector: 'conn',
  }),
);
const ROUTE_NUM = /^\d{1,3}[a-z]?$/;

/**
 * Read a route from the start of `w` (words). Returns { route, used } or
 * null. Prefixes: interstate / i, us (highway / route), state route /
 * highway, sr / sh, a state code, highway / hwy / route / rte; or one word
 * like "i10", "sr111", "ca111", "us99".
 */
function routeAt(w, i) {
  const a = w[i];
  const b = w[i + 1];
  const c = w[i + 2];
  const num = (x) => (x && ROUTE_NUM.test(x) ? x : null);
  // One word: i10, us99, sr111, ca111, hwy111.
  const glued = /^(i|us|sr|sh|hwy|rte|[a-z]{2})(\d{1,3}[a-z]?)$/.exec(a ?? '');
  if (glued) {
    const t = prefixType(glued[1]);
    if (t) return { route: { type: t, num: glued[2] }, used: 1 };
  }
  if (a === 'interstate' || a === 'i' || a === 'ih')
    return num(b) ? { route: { type: 'I', num: b }, used: 2 } : null;
  if (a === 'us' || (a === 'u' && b === 's')) {
    const j = a === 'us' ? i + 1 : i + 2;
    const x = w[j];
    if (num(x)) return { route: { type: 'US', num: x }, used: j - i + 1 };
    if ((x === 'hwy' || x === 'highway' || x === 'route' || x === 'rte') && num(w[j + 1]))
      return { route: { type: 'US', num: w[j + 1] }, used: j - i + 2 };
    return null;
  }
  if (a === 'state' && (b === 'route' || b === 'rte' || b === 'hwy' || b === 'highway'))
    return num(c) ? { route: { type: 'SR', num: c }, used: 3 } : null;
  if (a === 'sr' || a === 'sh' || a === 'ste')
    return num(b) ? { route: { type: 'SR', num: b }, used: 2 } : null;
  if (STATE_CODES.has(a)) {
    if (num(b)) return { route: { type: 'SR', num: b }, used: 2 };
    if ((b === 'hwy' || b === 'highway' || b === 'route' || b === 'sr') && num(c))
      return { route: { type: 'SR', num: c }, used: 3 };
    return null;
  }
  if (a === 'hwy' || a === 'highway' || a === 'route' || a === 'rte' || a === 'rt')
    return num(b) ? { route: { type: '*', num: b }, used: 2 } : null;
  if (a === 'county' && (b === 'road' || b === 'rd' || b === 'route') && num(c))
    return { route: { type: 'CR', num: c }, used: 3 };
  return null;
}

function prefixType(p) {
  if (p === 'i') return 'I';
  if (p === 'us') return 'US';
  if (p === 'sr' || p === 'sh') return 'SR';
  if (p === 'hwy' || p === 'rte') return '*';
  return STATE_CODES.has(p) ? 'SR' : null;
}

/**
 * The route a text names, or null: "Highway 111" -> { type: '*', num: '111' },
 * "CA- 111" -> SR 111, "I 10 BUS" -> I 10 with qual 'bus', "Old Highway 111"
 * -> qual 'old'. Only when the route is the whole text (a qualifier aside):
 * "Highway 111 Bridge" is not the route.
 */
export function parseRoute(text) {
  const w = words(text);
  if (!w.length) return null;
  let qual = null;
  let i = 0;
  if (QUALIFIERS.has(w[0]) && w.length > 2) {
    qual = QUALIFIERS.get(w[0]);
    i = 1;
  }
  const r = routeAt(w, i);
  if (!r) return null;
  const rest = w.slice(i + r.used);
  if (rest.length > 1) return null;
  if (rest.length === 1) {
    if (!QUALIFIERS.has(rest[0])) return null;
    qual = QUALIFIERS.get(rest[0]);
  }
  return { ...r.route, qual };
}

/**
 * The routes a road line carries: its `ref` (";"-separated, e.g. "CA 111
 * Old;I 10 BUS;US 99 Hist" or "10" with network "us-interstate") and any
 * name that is a route ("CA- 111", "Highway 111").
 */
export function lineRoutes({ ref, network, names = [] } = {}) {
  const out = [];
  const typeOf = {
    'us-interstate': 'I',
    'us-highway': 'US',
    'us-state': 'SR',
  }[String(network ?? '')];
  for (const raw of String(ref ?? '').split(';')) {
    const r = raw.trim();
    if (!r) continue;
    if (/^\d{1,3}[a-z]?$/i.test(r))
      out.push({ type: typeOf ?? '*', num: r.toLowerCase(), qual: null });
    else {
      const p = parseRoute(r);
      if (p) out.push(p);
    }
  }
  for (const n of names) {
    const p = parseRoute(n);
    if (p) out.push(p);
  }
  return out;
}

/** How one typed route matches one line route: 1 the same, 0.7 a variant of it, 0 no. */
export function routeMatch(q, r) {
  if (!q || !r || q.num !== r.num) return 0;
  const typeOk = q.type === '*' || r.type === '*' || q.type === r.type;
  if (!typeOk) return 0;
  return q.qual === r.qual ? 1 : 0.7;
}

/**
 * Words with every route folded to one word, "rt" and its number ("highway
 * 111", "ca 111", "sr 111" -> "rt111"; "i 10" -> "rt10"), so a route matches
 * however it is written. The words are folded street words (foldStreet).
 */
export function foldRoutes(w) {
  const out = [];
  let i = 0;
  while (i < w.length) {
    const r = routeAt(w, i);
    if (r) {
      out.push(`rt${r.route.num}`);
      i += r.used;
    } else {
      out.push(w[i]);
      i += 1;
    }
  }
  return out;
}

/** "Highway 111", "I-10", "US 99", "CA 111" as a road sign would say it. */
export function routeLabel(route, typed = '') {
  const n = route.num.toUpperCase();
  const q = route.qual
    ? ` ${route.qual === 'bus' ? 'Business' : capital(route.qual)}`
    : '';
  if (route.type === 'I') return `I-${n}${q}`;
  if (route.type === 'US') return `US ${n}${q}`;
  if (route.type === 'CR') return `County Road ${n}${q}`;
  if (route.type === 'SR') {
    const code = words(typed).find((x) => STATE_CODES.has(x));
    return `${code ? code.toUpperCase() : 'SR'} ${n}${q}`;
  }
  return `Highway ${n}${q}`;
}

const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------- street names

/** Street words folded: "Golf Center pkway" -> ['golf', 'center', 'pkwy']. */
export function foldStreet(text) {
  return words(text).map((t) => CANON.get(t) ?? t);
}

/** "44th" -> "44" (ordinals compared as numbers). */
const plain = (t) => t.replace(/^(\d+)(st|nd|rd|th)$/, '$1');

/** Leading and trailing directions off ("n jackson st" -> "jackson st"). */
function noDirections(t) {
  let a = 0;
  let b = t.length;
  while (b - a > 1 && DIRECTIONS.has(t[a])) a += 1;
  while (b - a > 1 && DIRECTIONS.has(t[b - 1])) b -= 1;
  return t.slice(a, b);
}

/** The name without its street word, when it ends in one ("jackson st" -> "jackson"). */
function noType(t) {
  return t.length > 1 && STREET_TYPES.has(t[t.length - 1]) ? t.slice(0, -1) : t;
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameSet = (a, b) => same([...a].sort(), [...b].sort());

/** True when `typed` (half a word) begins any spelling of `word`. */
function begins(typed, word) {
  if (typed.length < 2) return typed === word;
  const spelled = SPELLED.get(word) ?? [word];
  return spelled.some((s) => s.startsWith(typed));
}

/**
 * How a typed street name matches a road's name: 1 the same name (directions
 * aside), 0.7 near enough (no street word typed, "Monroe" for "Monroe
 * Street"; another street word; "Avenue 44" for "44th Avenue"), 0 no.
 * `partial`: the last typed word may be half typed.
 * @param {string[]} q  folded typed words (foldStreet)
 * @param {string[]} n  folded name words
 */
export function nameMatch(q, n, { partial = false } = {}) {
  if (!q.length || !n.length) return 0;
  const qd = noDirections(q);
  const nd = noDirections(n);
  if (same(qd, nd)) return 1;
  // Half typed: the words so far begin the name ("golf center pk", "golf cen").
  if (partial && nd.length >= qd.length) {
    const last = qd.length - 1;
    if (qd.every((t, i) => (i === last ? begins(t, nd[i]) : t === nd[i])))
      return nd.length === qd.length ? 0.95 : 0.8;
  }
  const qp = qd.map(plain);
  const np = nd.map(plain);
  if (same(qp, np)) return 1;
  // No street word typed: "monroe" for "monroe st".
  if (!STREET_TYPES.has(qp[qp.length - 1]) && same(qp, noType(np))) return 0.7;
  // Another street word ("golf center dr" for the parkway), or the words in
  // another order ("avenue 44" for "44th avenue").
  if (same(noType(qp), noType(np)) && noType(qp).length) return 0.7;
  if (qp.length >= 2 && sameSet(qp, np)) return 0.7;
  return 0;
}

/**
 * One side of an intersection as typed, ready to match: its route (if it
 * names one) and its folded words.
 */
export function roadQuery(text, { partial = false } = {}) {
  const route = parseRoute(text);
  return { text: String(text ?? '').trim(), route, words: foldStreet(text), partial };
}

/** True when the text reads as a street or road (a street word, a route, a numbered avenue). */
export function looksLikeRoad(text) {
  if (parseRoute(text)) return true;
  const w = foldStreet(text);
  if (w.length < 2) return false;
  if (w.some((t) => STREET_TYPES.has(t))) return true;
  // "5th st" is covered above; "avenue 44" folds to "ave 44".
  return /^\d+(st|nd|rd|th)?$/.test(w[w.length - 1]) && STREET_TYPES.has(w[0]);
}

/**
 * How well a road line matches a typed side: its best name or route match
 * (0 no, 0.7 a variant, 1 the road).
 * @param {{ route: object|null, words: string[], partial?: boolean }} side  roadQuery()
 * @param {{ names: string[], routes: object[] }} line  names as written, routes (lineRoutes)
 */
export function roadMatch(side, line) {
  let best = 0;
  if (side.route)
    for (const r of line.routes ?? []) best = Math.max(best, routeMatch(side.route, r));
  if (best === 1) return 1;
  for (const n of line.names ?? []) {
    best = Math.max(
      best,
      nameMatch(side.words, foldStreet(n), { partial: side.partial }),
    );
    if (best === 1) return 1;
  }
  return best;
}
