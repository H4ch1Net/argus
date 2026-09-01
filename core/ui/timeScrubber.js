import './timeScrubber.css';

// Time scrubber (Phase 17): the front-end for the ring-buffer history. It drives
// the scene clock, so dragging back rewinds every mover at once (flights/ships
// interpolate from their buffers; satellites re-propagate via SGP4). Live by
// default; grabbing the slider freezes an anchor window ending at "now"; Play
// runs the frozen moment forward toward live; Live snaps back.

const WINDOW_MS = 5 * 60 * 1000; // scrubbable window: the last 5 minutes
const PLAY_SPEED = 8; // playback multiplier
const TICK_MS = 80;

function fmtOffset(ms) {
  if (ms <= 0) return 'LIVE';
  const s = Math.round(ms / 1000);
  return `-${String(Math.floor(s / 60)).padStart(1, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * @param {{ clock: { setScrub: (ms: number) => void, goLive: () => void, isLive: () => boolean } }} deps
 */
export function createTimeScrubber({ clock }) {
  const el = document.createElement('div');
  el.className = 'argus-scrub';
  el.innerHTML = `
    <button class="argus-scrub__btn" data-role="play" type="button" aria-label="Play">▶</button>
    <input class="argus-scrub__range" data-role="range" type="range"
      min="0" max="1000" value="1000" step="1" aria-label="Time scrubber" />
    <span class="argus-scrub__label" data-role="label">LIVE</span>
    <button class="argus-scrub__btn argus-scrub__live" data-role="live" type="button">LIVE</button>
  `;
  const playBtn = el.querySelector('[data-role="play"]');
  const range = el.querySelector('[data-role="range"]');
  const label = el.querySelector('[data-role="label"]');
  const liveBtn = el.querySelector('[data-role="live"]');

  let anchor = null; // real "now" captured when scrubbing began
  let playing = false;
  let timer = null;

  // slider value 0..1000 -> offset from anchor: 1000 = anchor (newest), 0 = window start
  const valueToOffset = (v) => ((1000 - v) / 1000) * WINDOW_MS;

  function stopPlay() {
    playing = false;
    playBtn.textContent = '▶';
    playBtn.setAttribute('aria-label', 'Play');
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function goLive() {
    stopPlay();
    anchor = null;
    range.value = '1000';
    label.textContent = 'LIVE';
    el.classList.remove('argus-scrub--scrubbing');
    clock.goLive();
  }

  function applyValue(v) {
    const off = valueToOffset(v);
    if (off <= 0) {
      goLive();
      return;
    }
    if (anchor === null) anchor = Date.now();
    el.classList.add('argus-scrub--scrubbing');
    label.textContent = fmtOffset(off);
    clock.setScrub(anchor - off);
  }

  range.addEventListener('input', () => {
    stopPlay();
    applyValue(Number(range.value));
  });

  liveBtn.addEventListener('click', goLive);

  playBtn.addEventListener('click', () => {
    if (playing) {
      stopPlay();
      return;
    }
    if (clock.isLive()) return; // nothing to play from
    playing = true;
    playBtn.textContent = '❚❚';
    playBtn.setAttribute('aria-label', 'Pause');
    timer = setInterval(() => {
      const v = Math.min(
        1000,
        Number(range.value) + (PLAY_SPEED * TICK_MS * 1000) / WINDOW_MS,
      );
      range.value = String(v);
      applyValue(v); // reaching 1000 calls goLive() via applyValue
    }, TICK_MS);
  });

  return {
    el,
    // Keep the label honest if the scrubbed moment ages past the anchor window.
    sync() {
      if (anchor === null) return;
      label.textContent = fmtOffset(valueToOffset(Number(range.value)));
    },
  };
}
