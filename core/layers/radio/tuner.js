// Analog radio tuner: the pure model behind the dial (no DOM, no Cesium).
// One integer slot per station, in a stable catalogue order: specialist
// stations (news, talk, weather, emergency, ...) seeded first so they are
// never crowded out by music charts, then the rest by popularity. A pointer
// x position becomes a ratio, then a continuous coordinate, then the nearest
// station; the tape scrolls under a fixed needle. The shell owns input
// (Pointer Events, arrow keys) and audio; it commits a station on release.
//
// Adapted from gods-eye-view src/ui/radioTunerModel.js, src/ui/radioBindings.js
// and server/providers/radio/catalog.js (MIT).

/** The dial holds at most this many stations. */
export const TUNER_STATION_LIMIT = 750;
/** Operational categories seeded ahead of the popularity fill, in this order. */
export const TUNER_SPECIALIST_TAGS = Object.freeze([
  'news',
  'talk',
  'weather',
  'emergency',
  'scanner',
  'aviation',
  'marine',
  'traffic',
]);
export const TUNER_SEED_PER_TAG = 45;
/** Static noise during a drag stays at or under this gain (WebAudio). */
export const TUNER_STATIC_MAX_GAIN = 0.018;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const count = (n) => Math.max(0, Math.floor(Number(n) || 0));

const tagsOf = (s) =>
  (Array.isArray(s?.meta?.tags) ? s.meta.tags : []).map((t) =>
    String(t).toLowerCase().replace(/[_-]+/g, ' ').trim(),
  );

/**
 * The dial order for parsed radio stations (parseRadio output, which keeps the
 * directory's click-count order): up to TUNER_SEED_PER_TAG stations per
 * specialist tag first, then every other station by clicks (then name), up to
 * `limit`. Deterministic for the same input.
 */
export function tunerStations(stations, { limit = TUNER_STATION_LIMIT } = {}) {
  const list = Array.isArray(stations) ? stations.filter((s) => s && s.id) : [];
  const max = Math.max(0, Math.min(TUNER_STATION_LIMIT, count(limit)));
  const out = [];
  const seen = new Set();
  const take = (s) => {
    if (out.length >= max || seen.has(s.id)) return;
    seen.add(s.id);
    out.push(s);
  };
  for (const tag of TUNER_SPECIALIST_TAGS) {
    let n = 0;
    for (const s of list) {
      if (n >= TUNER_SEED_PER_TAG) break;
      if (seen.has(s.id)) continue;
      if (tagsOf(s).some((t) => t === tag || t.includes(tag))) {
        take(s);
        n += 1;
      }
    }
  }
  [...list]
    .sort(
      (a, b) =>
        (Number(b.meta?.clicks) || 0) - (Number(a.meta?.clicks) || 0) ||
        String(a.meta?.name ?? '').localeCompare(String(b.meta?.name ?? '')) ||
        String(a.id).localeCompare(String(b.id)),
    )
    .forEach(take);
  return out;
}

/** Nearest station index for a continuous dial coordinate; -1 for an empty dial. */
export function nearestIndex(coordinate, stationCount) {
  const n = count(stationCount);
  if (!n) return -1;
  return Math.min(n - 1, Math.max(0, Math.floor((Number(coordinate) || 0) + 0.5)));
}

/** A dial ratio in [0, 1] -> { coordinate, stationIndex }. */
export function ratioToIndex(ratio, stationCount) {
  const n = count(stationCount);
  if (!n) return { coordinate: 0, stationIndex: -1 };
  if (n === 1) return { coordinate: 0, stationIndex: 0 };
  const r = Math.min(1, Math.max(0, Number(ratio) || 0));
  const coordinate = r * (n - 1);
  return { coordinate, stationIndex: nearestIndex(coordinate, n) };
}

/**
 * A pointer x (clientX) over the dial -> { ratio, coordinate, stationIndex }.
 * `insetPx` keeps the ends of the dial reachable under a fingertip.
 */
export function pointerToTuner(clientX, left, width, stationCount, insetPx = 7) {
  const n = count(stationCount);
  if (!n) return { ratio: 0, coordinate: 0, stationIndex: -1 };
  if (n === 1) return { ratio: 0.5, coordinate: 0, stationIndex: 0 };
  const inset = Math.max(0, Number(insetPx) || 0);
  const usable = Math.max(1, (Number(width) || 0) - inset * 2);
  const ratio = Math.min(
    1,
    Math.max(0, ((Number(clientX) || 0) - (Number(left) || 0) - inset) / usable),
  );
  return { ratio, ...ratioToIndex(ratio, n) };
}

/**
 * The visible stretch of tape around a coordinate: ticks at a pitch of at
 * least `minPitchPx` (or `speedFactor` times the directory step, so a drag
 * sweeps the tape faster than the needle), a label on every `labelStep`th
 * channel plus the ends and the current one.
 * @returns {{ ticks: Array<{ stationIndex: number, channel: number, xPx: number,
 *   current: boolean, label: string }>, needleX: number, pitchPx: number, ratio: number }}
 */
export function tunerTape(
  coordinate,
  stationCount,
  width,
  { insetPx = 7, minPitchPx = 14, speedFactor = 5, overscan = 2, labelStep = 6 } = {},
) {
  const n = count(stationCount);
  const dialWidth = Math.max(0, Number(width) || 0);
  const inset = Math.max(0, Number(insetPx) || 0);
  const usable = Math.max(0, dialWidth - inset * 2);
  if (!n) return { ticks: [], needleX: inset, pitchPx: 0, ratio: 0 };
  const minPitch = Math.max(1, Number(minPitchPx) || 14);
  if (n === 1) {
    const x = inset + usable / 2;
    return {
      ticks: [{ stationIndex: 0, channel: 1, xPx: x, current: true, label: '01' }],
      needleX: x,
      pitchPx: minPitch,
      ratio: 0.5,
    };
  }
  const value = Math.min(n - 1, Math.max(0, Number(coordinate) || 0));
  const step = usable / (n - 1);
  const pitchPx = Math.max(minPitch, step * Math.max(1, Number(speedFactor) || 5));
  const needleX = inset + step * value;
  const over = pitchPx * Math.max(0, Number(overscan) || 0);
  const first = Math.max(0, Math.ceil(value + (-over - needleX) / pitchPx));
  const last = Math.min(
    n - 1,
    Math.floor(value + (dialWidth + over - needleX) / pitchPx),
  );
  const current = nearestIndex(value, n);
  const every = Math.max(1, Math.floor(Number(labelStep) || 6));
  const digits = Math.max(2, String(n).length);
  const ticks = [];
  for (let i = first; i <= last; i += 1) {
    const channel = i + 1;
    const labelled = i === current || i === 0 || i === n - 1 || channel % every === 0;
    ticks.push({
      stationIndex: i,
      channel,
      xPx: needleX + pitchPx * (i - value),
      current: i === current,
      label: labelled ? String(channel).padStart(digits, '0') : '',
    });
  }
  return { ticks, needleX, pitchPx, ratio: value / (n - 1) };
}

/**
 * The station a key moves to: ArrowLeft/Down one back, ArrowRight/Up one on,
 * PageUp/PageDown a tenth of the dial, Home/End the ends. Null for any other
 * key (let it through) or an empty dial.
 */
export function keyStep(key, currentIndex, stationCount) {
  const n = count(stationCount);
  if (!n) return null;
  const max = n - 1;
  const cur = Math.min(max, Math.max(0, Math.round(Number(currentIndex) || 0)));
  const page = Math.max(1, Math.round(max / 10));
  const next = {
    ArrowLeft: cur - 1,
    ArrowDown: cur - 1,
    ArrowRight: cur + 1,
    ArrowUp: cur + 1,
    PageUp: cur + page,
    PageDown: cur - page,
    Home: 0,
    End: max,
  }[key];
  return next === undefined ? null : Math.min(max, Math.max(0, next));
}

/** Where a station id sits on the dial (to follow a station picked on the globe); -1 if absent. */
export function indexOfStation(stations, id) {
  return Array.isArray(stations) ? stations.findIndex((s) => s?.id === id) : -1;
}

/**
 * Radio Browser counts a listen when /json/url/<uuid> is requested; the
 * radiobrowser proxy feed allows exactly that GET. Null for a non-station id.
 * (The proxy caches it, so one listener re-tuning cannot inflate the count.)
 */
export function stationClickPath(stationOrId) {
  const id = typeof stationOrId === 'string' ? stationOrId : stationOrId?.id;
  const uuid = String(id ?? '').replace(/^radio:/, '');
  return UUID.test(uuid) ? `/json/url/${uuid.toLowerCase()}` : null;
}
