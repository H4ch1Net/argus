import {
  FLOW_TTL_MS,
  flowQuery,
  flowSegmentPath,
  formatFlowReadout,
  parseFlowSegment,
} from '../layers/simtraffic/flow.js';
import { CONGESTION_COLORS } from '../layers/simtraffic/format.js';

// The FLOW readout: TomTom's live speed on the road at the middle of the view
// (current / free-flow, and the ratio), from the same pinned, budgeted
// 'tomtom-flowseg' feed the simulated traffic samples. Off by default (VIEW >
// ROAD FLOW): it spends a TomTom request when the view settles somewhere new
// below 25 km, at most one every 15 s, and reuses an answer for five minutes
// within about 30 m. On the desktop it sits in the bottom strip, on the phone
// in the intel pane (the shells' 'strip' slot).

const MAX_HEIGHT_M = 25_000;
const MIN_GAP_MS = 15_000;
const REUSE_M = 30;

/**
 * The readout's logic, without DOM or Cesium (testable).
 * @param {{ fetchFlow: (lat: number, lon: number) => Promise<object>,
 *   getView: () => ({ lat: number, lon: number, heightM: number }|null),
 *   onChange: (state: { text: string, level: string|null, seg: object|null }|null) => void,
 *   now?: () => number, units?: () => string }} deps
 */
export function createRoadFlow({
  fetchFlow,
  getView,
  onChange,
  now = () => Date.now(),
  units = () => 'metric',
}) {
  let enabled = false;
  let last = null; // { lat, lon, at, seg }
  let lastAsk = 0;
  let busy = false;
  let timer = null;

  const near = (a, b) =>
    Math.hypot(
      (a.lat - b.lat) * 110_540,
      (a.lon - b.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180),
    ) < REUSE_M;

  function show(seg) {
    onChange({
      text: formatFlowReadout(seg, units()),
      level: seg ? (seg.closed ? 'closed' : seg.level) : null,
      seg,
    });
  }

  async function check() {
    timer = null;
    if (!enabled) return;
    const v = getView();
    if (!v || !(v.heightM < MAX_HEIGHT_M)) {
      onChange({ text: 'ZOOM IN', level: null, seg: null });
      return;
    }
    if (last && near(last, v) && now() - last.at < FLOW_TTL_MS) return show(last.seg);
    const wait = MIN_GAP_MS - (now() - lastAsk);
    if (wait > 0 || busy) {
      timer = setTimeout(check, Math.max(500, wait));
      return;
    }
    busy = true;
    lastAsk = now();
    try {
      const seg = parseFlowSegment(await fetchFlow(v.lat, v.lon));
      if (seg) seg.level = seg.ratio < 0.45 ? 'jam' : seg.ratio < 0.75 ? 'slow' : 'free';
      last = { lat: v.lat, lon: v.lon, at: now(), seg };
      if (enabled) show(seg);
    } catch (err) {
      console.warn(`[argus] flow readout: ${err?.message || err}`);
      if (enabled)
        onChange({
          text: err?.status === 429 ? 'BUDGET SPENT' : 'UNAVAILABLE',
          level: null,
          seg: null,
        });
    } finally {
      busy = false;
    }
  }

  return {
    setEnabled(on) {
      enabled = Boolean(on);
      if (!enabled) {
        clearTimeout(timer);
        timer = null;
        onChange(null);
      } else check();
    },
    /** The view settled: look again (rate-limited). */
    viewChanged() {
      if (enabled && !timer) timer = setTimeout(check, 400);
    },
    get enabled() {
      return enabled;
    },
  };
}

/**
 * Mount the readout and its VIEW switch. Returns the VIEW section element.
 * @param {{ viewer: object, proxyClient: object, settings: object, mount: Function,
 *   ui: { section: Function, createSwitch: Function, createSegment: Function, h: Function },
 *   getView: () => object }} deps
 */
export function mountRoadFlow({ viewer, proxyClient, settings, mount, ui, getView }) {
  const seg = ui.createSegment({
    label: 'FLOW',
    value: '--',
    title: 'TomTom live speed on the road at the view centre: current / free-flow',
  });
  seg.el.hidden = true;
  seg.el.classList.add('ct-flow');
  mount('strip', seg.el);
  const valueEl = seg.el.querySelector('.ct-seg__value');
  const flow = createRoadFlow({
    getView,
    units: () => settings?.get('units') ?? 'metric',
    fetchFlow: (lat, lon) =>
      proxyClient.getJson('tomtom-flowseg', flowSegmentPath(3), {
        params: flowQuery(lat, lon),
      }),
    onChange: (s) => {
      seg.el.hidden = !s;
      if (!s) return;
      seg.set(s.text);
      if (valueEl) valueEl.style.color = s.level ? CONGESTION_COLORS[s.level] : '';
    },
  });
  viewer.camera.moveEnd.addEventListener(() => flow.viewChanged());
  const on = Boolean(settings?.get('flowReadout'));
  flow.setEnabled(on);
  return ui.section(
    'ROAD FLOW',
    ui.createSwitch({
      label: 'Flow at view centre',
      on,
      title:
        'TomTom current and free-flow speed on the road under the middle of the view',
      onToggle: (v) => {
        settings?.set('flowReadout', v);
        flow.setEnabled(v);
      },
    }).el,
    ui.h(
      'div.ct-section__note',
      {},
      'Live speeds © TomTom. One request when the view settles somewhere new (budgeted with the simulated traffic).',
    ),
  );
}
