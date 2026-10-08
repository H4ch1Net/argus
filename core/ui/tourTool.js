import { h } from './dom.js';
import { section, createChoice, createSwitch } from './controls.js';
import { rankHotspots } from './hotspots.js';

// SITUATION TOUR (TOOLS): the master plan's ambient / situation-room mode. It
// ranks the hotspots across the layers that are on (core/ui/hotspots.js),
// flies to each, circles it for the hold time, and moves on, re-ranking every
// lap, for a wall display or a quiet watch. Keeps the screen awake while it
// runs. Any press on the globe, Escape or STOP ends it.

const HOLDS = [
  { id: 15, label: '15 S' },
  { id: 30, label: '30 S' },
  { id: 60, label: '60 S' },
];

/**
 * @param {{ getEntries: () => { key: string, n: object }[],
 *   flyTo: (spot: object) => Promise<boolean>, onArrive?: (spot: object) => void,
 *   select?: (spot: object) => void, stopMotion?: () => void, notify: Function,
 *   canvas?: EventTarget }} deps
 */
export function createTourTool({
  getEntries,
  flyTo,
  onArrive,
  select,
  stopMotion,
  notify,
  canvas,
}) {
  let holdS = 30;
  let selectEach = true;
  let run = null; // { token, wake }
  const status = h('div.ct-tool__summary', {}, 'IDLE');
  const startBtn = h(
    'button.ct-btn.ct-btn--ok',
    { type: 'button', onclick: () => start() },
    'START TOUR',
  );
  const stopBtn = h(
    'button.ct-btn',
    { type: 'button', disabled: true, onclick: () => stop() },
    'STOP',
  );

  const wait = (ms, token) =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      token.cancel = () => {
        clearTimeout(t);
        resolve();
      };
    });

  const onKey = (e) => e.key === 'Escape' && stop();
  const onPress = () => stop();

  async function start() {
    if (run) return;
    let spots = rankHotspots(getEntries());
    if (!spots.length) {
      notify({
        title: 'NOTHING TO TOUR',
        body: 'Turn on earthquakes, fires, storms, launches or a moving layer first.',
        level: 'low',
      });
      return;
    }
    const token = { stopped: false, cancel: null };
    run = { token, wake: null };
    try {
      run.wake = await navigator.wakeLock?.request('screen');
    } catch {
      run.wake = null; // not offered (or not visible): the tour runs anyway
    }
    startBtn.disabled = true;
    stopBtn.disabled = false;
    document.addEventListener('keydown', onKey);
    canvas?.addEventListener('pointerdown', onPress);
    for (let lap = 0; !token.stopped; lap += 1) {
      if (lap) spots = rankHotspots(getEntries());
      if (!spots.length) break;
      for (const [i, spot] of spots.entries()) {
        if (token.stopped) break;
        status.textContent = `${String(i + 1).padStart(2, '0')}/${String(spots.length).padStart(2, '0')}  ${spot.key.toUpperCase()}  ${spot.label.toUpperCase().slice(0, 28)}`;
        stopMotion?.();
        const landed = await flyTo(spot);
        if (token.stopped) break;
        if (landed) {
          if (selectEach) select?.(spot);
          onArrive?.(spot);
        }
        await wait(holdS * 1000, token);
      }
    }
    stop();
  }

  function stop() {
    if (!run) return;
    run.token.stopped = true;
    run.token.cancel?.();
    run.wake?.release?.().catch(() => {});
    run = null;
    stopMotion?.();
    document.removeEventListener('keydown', onKey);
    canvas?.removeEventListener('pointerdown', onPress);
    startBtn.disabled = false;
    stopBtn.disabled = true;
    status.textContent = 'IDLE';
  }

  const el = section(
    'SITUATION TOUR',
    h(
      'div.ct-section__note',
      {},
      'Flies round the hotspots of the layers that are on (big quakes, hot fires, storms, launches, live traffic), circling each. For a wall screen or a quiet watch.',
    ),
    createChoice({
      caption: 'Hold',
      options: HOLDS,
      current: holdS,
      onSelect: (id) => (holdS = id),
    }).el,
    createSwitch({
      label: 'Open each card',
      on: selectEach,
      onToggle: (on) => (selectEach = on),
    }).el,
    h('div.ct-seg', {}, startBtn, stopBtn),
    status,
  );
  return { el, stop, running: () => Boolean(run) };
}
