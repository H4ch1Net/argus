import {
  bandFor,
  buildNetwork,
  focusRadiusM,
  hashString,
  keepsLeft,
  mergeWays,
  overpassRoadQuery,
  parseRoadWays,
  tilesAround,
} from './roads.js';
import {
  FLOW_BUDGET,
  FLOW_TTL_MS,
  flowForNetwork,
  flowQuery,
  flowSegmentPath,
  matchSegment,
  parseFlowSegment,
  planFlowSamples,
} from './flow.js';

// The simulated traffic model: the road network around the view and the
// live congestion on it, kept up to date as the view moves. Pure (no Cesium),
// so the terminal shell runs the same model. The layer's source returns this
// one object on every poll and keeps filling it in the background; the
// renderer watches its version counters.
//
//   roads    OSM ways from Overpass, one query per tile (roads.js), cached
//            30 minutes per tile; at most a handful of tiles per view, nearest
//            first, fetched one at a time so Overpass is never hammered.
//   flow     TomTom Flow Segment Data at a budgeted few points per view
//            (flow.js), each answer kept five minutes and re-matched onto
//            every network built while it is fresh. Without a TomTom key the
//            simulation runs at free-flow speeds and says so.

const TILE_TTL_MS = 30 * 60_000;
const TILE_MAX = 64;
const MAX_TILES = { minimal: 4, balanced: 6, full: 9 };
const FLOW_GAP_MS = 20_000; // between sampling batches for one view
const FIRST_WAIT_MS = 2500; // a poll waits this long for the first missing tile

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{ fetchWays: (band: object, tile: object) => Promise<object>,
 *   fetchFlow?: ((sample: object) => Promise<object>)|null, tier?: string,
 *   now?: () => number, demo?: boolean }} opts
 */
export function createTrafficModel({
  fetchWays,
  fetchFlow = null,
  tier = 'balanced',
  now = () => Date.now(),
  demo = false,
  flowBudget = null,
}) {
  const tiles = new Map(); // tile key -> { ways, at }
  const segments = new Map(); // point key -> { seg, at }
  let gen = 0;
  let appliedKey = '';
  let lastFlowAt = 0;
  let lastFlowFocus = null;
  let flowBusy = false;

  const model = {
    demo,
    /** Bumps when the road network changes. */
    version: 0,
    /** Bumps when congestion changes. */
    flowVersion: 0,
    /** Bumps when the focus moves. */
    focusVersion: 0,
    active: false,
    band: null,
    focus: null,
    radiusM: 0,
    leftHand: false,
    seed: 1,
    network: null,
    flow: new Map(), // edge id -> { ratio, freeKmh?, currentKmh?, measured, closed? }
    flowState: fetchFlow ? 'pending' : 'off', // pending | live | off | budget | error
    measured: 0,
    inferred: 0,
    samples: 0,
    loading: false,
    error: null,
    vehicles: 0, // set by whoever runs the simulation (for the layer count)
    view: null, // the last view asked for
    /** Called after the roads or the congestion change (the renderer redraws). */
    onChange: null,
    get count() {
      return model.vehicles;
    },

    /**
     * Point the model at a view: { lat, lon, heightM } (lat/lon the ground at
     * the middle of the view). Resolves once cached roads are applied and the
     * first missing tile has arrived (or a short wait has passed); the rest
     * loads in the background.
     */
    async update(view) {
      model.view = view ?? null;
      const band = view ? bandFor(view.heightM) : null;
      if (!band || !Number.isFinite(view.lat) || !Number.isFinite(view.lon)) {
        if (model.active) {
          model.active = false;
          model.version += 1;
          model.onChange?.();
        }
        gen += 1;
        model.loading = false;
        return model;
      }
      const radiusM = focusRadiusM(view.heightM);
      const want = tilesAround(
        band,
        view,
        radiusM,
        MAX_TILES[tier] ?? MAX_TILES.balanced,
      );
      const g = ++gen;
      const moved =
        !model.focus ||
        Math.hypot(
          (view.lat - model.focus.lat) * 110_540,
          (view.lon - model.focus.lon) * 111_320 * Math.cos((view.lat * Math.PI) / 180),
        ) > 25 ||
        Math.abs(radiusM - model.radiusM) > 50;
      const bandChanged = !model.active || model.band?.id !== band.id;
      model.focus = { lat: view.lat, lon: view.lon };
      model.radiusM = radiusM;
      model.leftHand = keepsLeft(view.lat, view.lon);
      model.active = true;
      model.band = band;
      if (moved || bandChanged) {
        model.focusVersion += 1;
        model.onChange?.();
      }
      apply(want);
      const missing = want.filter((t) => {
        const hit = tiles.get(t.key);
        return !hit || now() - hit.at > TILE_TTL_MS;
      });
      model.loading = missing.length > 0;
      let first = null;
      const run = (async () => {
        for (const t of missing) {
          if (g !== gen) return;
          try {
            const raw = await fetchWays(band, t);
            const ways = parseRoadWays(raw);
            tiles.delete(t.key);
            tiles.set(t.key, { ways, at: now() });
            while (tiles.size > TILE_MAX) tiles.delete(tiles.keys().next().value);
            model.error = null;
          } catch (err) {
            model.error = String(err?.message || err);
          }
          if (g !== gen) return;
          apply(want);
          first?.();
          first = null;
        }
        if (g !== gen) return;
        model.loading = false;
        await sampleFlow(g);
      })();
      if (missing.length) {
        await Promise.race([new Promise((r) => (first = r)), sleep(FIRST_WAIT_MS), run]);
      } else {
        await Promise.race([run, sleep(50)]);
      }
      return model;
    },

    /** Stop background loading (the layer was switched off). */
    cancel() {
      gen += 1;
      model.loading = false;
    },

    /** Congestion for an edge, or null when nothing is known. */
    flowFor(edge) {
      return model.flow.get(edge.id) ?? null;
    },

    /** One short status line for the layer menu. */
    note() {
      if (!model.active) return 'below 8 km only';
      if (model.loading && !model.network?.edges.length) return 'loading roads';
      const sim = demo ? 'DEMO roads, simulated' : 'SIMULATED';
      if (model.error && !model.network?.edges.length) return `roads: ${model.error}`;
      if (demo) return `${sim}, demo congestion`;
      switch (model.flowState) {
        case 'live':
          return `${sim}, TomTom flow at ${model.samples} pts (${model.measured} roads)`;
        case 'off':
          return `${sim}, free-flow (no TomTom key)`;
        case 'budget':
          return `${sim}, TomTom budget spent: free-flow`;
        case 'error':
          return `${sim}, TomTom flow unavailable`;
        default:
          return `${sim}, sampling TomTom flow`;
      }
    },
  };

  function apply(want) {
    const have = want.filter((t) => tiles.has(t.key));
    const key = `${model.band?.id}:${have.map((t) => t.key).join(',')}`;
    if (key === appliedKey) return;
    appliedKey = key;
    const ways = mergeWays(have.map((t) => tiles.get(t.key).ways));
    model.network = buildNetwork(ways, model.focus);
    model.seed = hashString(key);
    model.version += 1;
    applyFlow();
    model.onChange?.();
  }

  function freshSegments() {
    const t = now();
    const out = [];
    for (const [k, v] of segments) {
      if (t - v.at > FLOW_TTL_MS * 1.2) segments.delete(k);
      else out.push(v.seg);
    }
    return out;
  }

  function applyFlow() {
    const net = model.network;
    if (!net) return;
    const matches = freshSegments().map((seg) => ({
      seg,
      edges: matchSegment(net, seg),
    }));
    const r = flowForNetwork(net, matches);
    model.flow = r.byEdge;
    model.measured = r.measured;
    model.inferred = r.inferred;
    model.samples = matches.filter((m) => m.edges.length).length;
    model.flowVersion += 1;
    model.onChange?.();
  }

  async function sampleFlow(g) {
    if (!fetchFlow || flowBusy || !model.network) return;
    // Not configured on the proxy, or the day's budget spent: try again later.
    if (
      (model.flowState === 'off' || model.flowState === 'budget') &&
      now() - lastFlowAt < 10 * 60_000
    )
      return;
    const f = model.focus;
    const movedFar =
      !lastFlowFocus ||
      Math.hypot(
        (f.lat - lastFlowFocus.lat) * 110_540,
        (f.lon - lastFlowFocus.lon) * 111_320 * Math.cos((f.lat * Math.PI) / 180),
      ) >
        model.radiusM / 2;
    if (!movedFar && now() - lastFlowAt < FLOW_GAP_MS) return;
    // Drop expired answers first, so their roads are sampled again.
    freshSegments();
    applyFlow();
    const plan = planFlowSamples(model.network, {
      focus: f,
      radiusM: model.radiusM,
      budget: flowBudget ?? FLOW_BUDGET[tier] ?? FLOW_BUDGET.balanced,
      covered: (e) => {
        const x = model.flow.get(e.id);
        return Boolean(x?.measured);
      },
    });
    lastFlowAt = now();
    lastFlowFocus = { ...f };
    if (!plan.length) return;
    flowBusy = true;
    try {
      for (const s of plan) {
        if (g !== gen) return;
        const key = `${s.lat},${s.lon}`;
        const hit = segments.get(key);
        if (hit && now() - hit.at < FLOW_TTL_MS) continue;
        let seg = null;
        try {
          const edge = model.network.edges.find((e) => e.id === s.edge);
          seg = parseFlowSegment(await fetchFlow({ ...s, edgeRef: edge }));
          model.flowState = 'live';
        } catch (err) {
          const status = err?.status;
          model.flowState = status === 429 ? 'budget' : status === 502 ? 'off' : 'error';
          console.warn(`[argus] simtraffic: TomTom flow ${err?.message || err}`);
          break;
        }
        if (seg) segments.set(key, { seg, at: now() });
        if (g === gen) applyFlow();
      }
    } finally {
      flowBusy = false;
    }
  }

  return model;
}

/**
 * The layer source over the proxy: Overpass roads through the 'overpass' feed
 * and, when the proxy has a TomTom key, flow through 'tomtom-flowseg'.
 * @param {{ proxyClient: object, getView: () => ({ lat: number, lon: number,
 *   heightM: number }|null), flow?: boolean, tier?: string }} opts
 */
export function createSimTrafficSource({ proxyClient, getView, flow = false, tier }) {
  const model = createTrafficModel({
    tier,
    fetchWays: async (band, tile) => {
      const data = await proxyClient.getJson('overpass', '/interpreter', {
        params: { data: overpassRoadQuery(band, tile) },
      });
      // Overpass reports timeouts and overload as HTTP 200 with a remark.
      if (data?.remark && !data.elements?.length) {
        throw new Error(`Overpass: ${String(data.remark).slice(0, 120)}`);
      }
      return data;
    },
    fetchFlow: flow
      ? (s) =>
          proxyClient.getJson('tomtom-flowseg', flowSegmentPath(s.rank), {
            params: flowQuery(s.lat, s.lon),
          })
      : null,
  });
  const source = async () => model.update(getView());
  source.model = model;
  return source;
}
