// Per-layer extras for the target panel: the actions and extra card rows that
// only make sense for some contacts. Glue between the interaction spine and the
// pure modules the layers ship:
//
//   aircraft      TRACE 24H: the earlier track from adsb.lol, prepended to the
//                 trail and the scrubber history; adsbdb type and route rows
//                 (shown at run time only, never stored: adsbdb's terms).
//   satellites    NEXT PASS over the observer (the phone's position, or the
//                 middle of the view on a desktop), with rise / peak / set.
//   launch pads   REPLAY: the reconstructed ascent and orbit of the latest
//                 launch from that pad, labelled as an estimate.
//   anything      NEAREST CAM: the closest public traffic camera, when the
//                 traffic cameras layer is on.
//
// Every lookup goes through the proxy to a pinned public index.

const AIRCRAFT = new Set(['flights', 'military', 'localadsb']);
const SATELLITES = new Set(['satellites', 'constellations']);

/**
 * @param {{ proxyClient: object|null, manager: object, notify: Function,
 *   getObserver: () => Promise<{ latitude: number, longitude: number }|null>,
 *   replay: { start: Function, stop: Function, running: () => boolean },
 *   select: (target: object) => void }} deps
 */
export function createTargetExtras({
  proxyClient,
  manager,
  notify,
  getObserver,
  replay,
  select,
}) {
  let enrich = null; // { queue, keys, rows } loaded lazily with a proxy
  const passes = new Map(); // target id -> card rows
  const traced = new Set(); // target ids already backfilled
  let refresh = () => {};

  async function enrichment() {
    if (!proxyClient) return null;
    if (!enrich) {
      enrich = (async () => {
        const [m, q] = await Promise.all([
          import('../layers/flights/enrich.js'),
          import('../layers/flights/enrichQueue.js'),
        ]);
        return {
          queue: q.createEnrichQueue({ fetch: m.createAdsbdbFetcher(proxyClient) }),
          keys: m.enrichKeys,
          rows: m.enrichmentRows,
        };
      })();
    }
    return enrich;
  }
  let enrichNow = null; // the resolved module set, for synchronous card rows

  /** Extra rows for a contact's card, from whatever has arrived so far. */
  function rows(key, n) {
    const out = [];
    if (AIRCRAFT.has(key) && enrichNow) {
      const k = enrichNow.keys(n.meta);
      // peek() wraps a cached answer as { value } (a cached miss is
      // { value: null }); the rows want the answer itself.
      const aircraft = k.aircraft
        ? (enrichNow.queue.peek(k.aircraft)?.value ?? null)
        : null;
      const route = k.route ? (enrichNow.queue.peek(k.route)?.value ?? null) : null;
      if (aircraft || route) out.push(...enrichNow.rows(n.meta, { aircraft, route }));
    }
    const p = passes.get(`${key}:${n.id}`);
    if (p) out.push(...p);
    return out;
  }

  /** Called when a contact becomes the target. */
  async function onSelect(key, n) {
    if (!AIRCRAFT.has(key) || !n) return;
    const e = await enrichment();
    if (!e) return;
    enrichNow = e;
    const k = e.keys(n.meta);
    await Promise.all(
      [k.aircraft, k.route]
        .filter(Boolean)
        .map((key2) => e.queue.request(key2, { priority: true })),
    );
    refresh();
  }

  async function trace(key, target, n) {
    const layer = manager.getLayer(key);
    if (!proxyClient || !layer) {
      notify({ title: 'TRACE UNAVAILABLE', body: 'Needs the live proxy.', level: 'low' });
      return;
    }
    const { fetchTraceFixes } = await import('../layers/military/trace.js');
    const history = layer.getRecord(target.id)?.getHistoryFixes() ?? [];
    try {
      const fixes = await fetchTraceFixes({
        proxyClient,
        hex: n.meta.hex ?? n.id,
        before: history[0]?.t ?? Date.now(),
        maxPoints: 400,
      });
      const added = layer.backfill(target.id, fixes);
      traced.add(`${key}:${n.id}`);
      notify({
        title: added ? 'TRACE LOADED' : 'NO EARLIER TRACK',
        body: added
          ? `${added} earlier fixes from adsb.lol added to the trail.`
          : 'adsb.lol has no earlier track for this aircraft.',
        level: 'low',
        key: 'trace',
      });
    } catch (err) {
      notify({ title: 'TRACE FAILED', body: String(err?.message || err), key: 'trace' });
    }
  }

  async function nextPass(key, n) {
    const observer = await getObserver();
    if (!observer) {
      notify({
        title: 'NO OBSERVER',
        body: 'No position to predict a pass for.',
        level: 'low',
      });
      return;
    }
    const [{ satPositionAt }, { findNextPass, describePass }] = await Promise.all([
      import('../layers/satellites/propagate.js'),
      import('../layers/satellites/passes.js'),
    ]);
    const pass = findNextPass({
      positionAt: (ms) => satPositionAt(n.meta.satrec, new Date(ms)),
      observer,
      fromMs: Date.now(),
    });
    passes.set(`${key}:${n.id}`, [
      ['Observer', `${observer.latitude.toFixed(2)}, ${observer.longitude.toFixed(2)}`],
      ...describePass(pass),
    ]);
    refresh();
  }

  async function nearestCam(target) {
    const cams = manager.getLayer('trafficcams');
    const here = target.position.getValue();
    if (!cams || !here) return;
    const [{ nearestCamera }, Cesium] = await Promise.all([
      import('../layers/trafficcams/nearest.js'),
      import('cesium'),
    ]);
    const c = Cesium.Cartographic.fromCartesian(here);
    const list = [];
    cams.forEachRecord((t, n) => list.push({ t, n }));
    const best = nearestCamera(
      list.map((x) => x.n),
      { lat: Cesium.Math.toDegrees(c.latitude), lon: Cesium.Math.toDegrees(c.longitude) },
      { maxKm: 50 },
    );
    if (!best) {
      notify({
        title: 'NO CAMERA NEARBY',
        body: 'No public camera within 50 km in view.',
        level: 'low',
      });
      return;
    }
    select(list[best.index].t);
  }

  /** Actions for the target panel. */
  function actions(target, rec) {
    const key = rec.key;
    const n = rec.normalized;
    const out = [];
    if (AIRCRAFT.has(key) && n && proxyClient && key !== 'localadsb') {
      const done = traced.has(`${key}:${n.id}`);
      out.push({
        label: done ? 'TRACED' : 'TRACE 24H',
        title: 'Load the last day of track from adsb.lol',
        pressed: done,
        onClick: () => trace(key, target, n),
      });
    }
    if (SATELLITES.has(key) && n?.meta?.satrec) {
      out.push({
        label: 'NEXT PASS',
        title: 'When it next rises over you',
        onClick: () => nextPass(key, n),
      });
    }
    if (key === 'launches' && n?.meta?.launches?.length) {
      out.push({
        label: replay.running() ? 'STOP REPLAY' : 'REPLAY',
        title: 'Reconstructed ascent and orbit of the latest launch here (an estimate)',
        pressed: replay.running(),
        onClick: () => (replay.running() ? replay.stop() : replay.start(n)),
      });
    }
    if (key !== 'trafficcams' && manager.isEnabled('trafficcams')) {
      out.push({
        label: 'NEAREST CAM',
        title: 'Jump to the closest public camera',
        onClick: () => nearestCam(target),
      });
    }
    return out;
  }

  return {
    rows,
    actions,
    onSelect,
    /** The tracker's panel refresh, so async results show without waiting. */
    setRefresh(fn) {
      refresh = fn;
    },
  };
}
