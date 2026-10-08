// Webcam categories: the Argus set every webcam source maps onto, how Windy's
// own categories map in, the conservative title rules that refine a category,
// and the shared category filter the map and the filter chips use. Pure: no
// Cesium, no DOM (the terminal shell uses it too).
//
// GUARDRAIL: a category describes what a published webcam is FOR (a beach, a
// pass, a runway), read from the provider's own tags and title. Nothing here,
// or anywhere in this layer, looks at what a camera shows.

/**
 * The Argus webcam categories, in chip order. `glyph` names the ctOS map glyph
 * (core/ui/glyphs.js) drawn for the category.
 * @type {ReadonlyArray<{ id: string, label: string, short: string, glyph: string }>}
 */
export const WEBCAM_CATEGORIES = Object.freeze(
  [
    ['traffic', 'Traffic', 'TRAFFIC'],
    ['city', 'City & plazas', 'CITY'],
    ['beach', 'Beach & surf', 'BEACH'],
    ['harbor', 'Harbor & marina', 'HARBOR'],
    ['mountain', 'Mountain & ski', 'MOUNTAIN'],
    ['weather', 'Weather', 'WEATHER'],
    ['airport', 'Airport', 'AIRPORT'],
    ['park', 'Parks & nature', 'PARKS'],
    ['wildlife', 'Wildlife', 'WILDLIFE'],
    ['rail', 'Rail & transit', 'RAIL'],
    ['campus', 'Campus', 'CAMPUS'],
    ['construction', 'Buildings & construction', 'BUILD'],
    ['observatory', 'Observatory & sky', 'SKY'],
    ['space', 'Earth from space', 'SPACE'],
    ['other', 'Other', 'OTHER'],
  ].map(([id, label, short]) => Object.freeze({ id, label, short, glyph: `wc-${id}` })),
);

export const CATEGORY_IDS = Object.freeze(WEBCAM_CATEGORIES.map((c) => c.id));
const BY_ID = new Map(WEBCAM_CATEGORIES.map((c) => [c.id, c]));

export const isCategory = (id) => BY_ID.has(id);
/** A category's record (label, glyph), falling back to "other". */
export const categoryInfo = (id) => BY_ID.get(id) ?? BY_ID.get('other');

/**
 * Windy Webcams API v3 category ids -> Argus categories. Windy's list (per its
 * documentation, not live-tested here) has no rail, campus or wildlife entry;
 * those come from the title rules below. Unknown ids fall to "other".
 */
export const WINDY_CATEGORY_MAP = Object.freeze({
  traffic: 'traffic',
  city: 'city',
  square: 'city',
  beach: 'beach',
  coast: 'beach',
  bay: 'beach',
  island: 'beach',
  harbor: 'harbor',
  harbour: 'harbor',
  marina: 'harbor',
  port: 'harbor',
  mountain: 'mountain',
  sportarea: 'mountain',
  resort: 'mountain',
  ski: 'mountain',
  meteo: 'weather',
  weather: 'weather',
  airport: 'airport',
  park: 'park',
  landscape: 'park',
  forest: 'park',
  lake: 'park',
  river: 'park',
  camping: 'park',
  golf: 'park',
  water: 'park',
  animals: 'wildlife',
  wildlife: 'wildlife',
  observatory: 'observatory',
  building: 'construction',
  construction: 'construction',
  train: 'rail',
  railway: 'rail',
  university: 'campus',
});

/**
 * Title rules, deliberately narrow: each needs an unambiguous word or phrase,
 * so "Big Bear Lake" is not a wildlife camera and "Rail Trail" is not a railway.
 */
const TEXT_RULES = [
  [
    'wildlife',
    /\bwildlife\b|\b(?:bird|nest|eagle|osprey|falcon|owl|heron|stork|puffin|seal|bear|penguin|feeder)\s?cam\b|\bnesting\b|\bwater(?:ing)?\s?hole\b|\bbird\s?feeder\b|\bzoo\b/i,
  ],
  [
    'rail',
    /\b(?:railway|railroad|railcam|rail\s?yard|train\s?station|trainspotting|trains?|amtrak|metro\s?station|subway\s?station)\b/i,
  ],
  [
    'campus',
    /\b(?:university|campus|college|universit[äa]t|universidad|universit[ée])\b/i,
  ],
  ['construction', /\b(?:construction|building\s?site|baustelle|chantier)\b/i],
];

/** Which way a tie between a webcam's categories breaks: most specific first. */
const PRECEDENCE = [
  'space',
  'observatory',
  'traffic',
  'airport',
  'harbor',
  'beach',
  'mountain',
  'wildlife',
  'rail',
  'campus',
  'construction',
  'weather',
  'city',
  'park',
  'other',
];
const RANK = new Map(PRECEDENCE.map((id, i) => [id, i]));

/** The categories a title states plainly (wildlife, rail, campus, construction). */
export function categoriesFromText(text) {
  const t = String(text ?? '');
  return TEXT_RULES.filter(([, re]) => re.test(t)).map(([id]) => id);
}

/**
 * One Argus category for a webcam: its provider's categories (Windy ids are
 * mapped), refined by its title, the most specific winning.
 * @param {{ windy?: string[], base?: string[], text?: string }} from
 */
export function categoryFor({ windy = [], base = [], text = '' } = {}) {
  const candidates = [
    ...base.filter(isCategory),
    ...windy.map((id) => WINDY_CATEGORY_MAP[String(id).toLowerCase()] ?? 'other'),
    ...categoriesFromText(text),
  ];
  let best = 'other';
  for (const c of candidates) if (RANK.get(c) < RANK.get(best)) best = c;
  return best;
}

/**
 * A selection over a fixed set of ids, with change notification: which
 * categories (or camera kinds) the map shows. Shared by a layer definition (it
 * filters what it draws) and the filter chips (they set it), so a change
 * re-draws from the data already fetched, never a new request.
 * @param {ReadonlyArray<string>} ids every id the filter knows
 * @param {Iterable<string>} [initial] the ids selected at first (all)
 */
export function createSetFilter(ids, initial = ids) {
  const known = new Set(ids);
  let selected = new Set([...initial].filter((id) => known.has(id)));
  const listeners = new Set();
  const emit = () => {
    const snapshot = new Set(selected);
    for (const fn of listeners) fn(snapshot);
  };
  return {
    ids,
    has: (id) => selected.has(id),
    /** A copy of the current selection. */
    selected: () => new Set(selected),
    get size() {
      return selected.size;
    },
    /** True when every id is selected (nothing is filtered out). */
    get isAll() {
      return ids.every((id) => selected.has(id));
    },
    set(next) {
      const s = new Set([...(next ?? [])].filter((id) => known.has(id)));
      if (s.size === selected.size && [...s].every((id) => selected.has(id))) return;
      selected = s;
      emit();
    },
    toggle(id) {
      if (!known.has(id)) return;
      const s = new Set(selected);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      this.set(s);
    },
    all() {
      this.set(ids);
    },
    none() {
      this.set([]);
    },
    /** fn(selectedSet) on every change; returns an unsubscribe function. */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** The webcam category filter. @param {Iterable<string>} [initial] (all) */
export const createCategoryFilter = (initial = CATEGORY_IDS) =>
  createSetFilter(CATEGORY_IDS, initial);

/**
 * The one filter the globe's webcam layer reads. The filter chips and
 * webcamsDefinition.setCategories() both set it.
 * @type {ReturnType<typeof createSetFilter>}
 */
export const webcamFilter = createCategoryFilter();
