import { h } from './dom.js';

// The weather history strip (VIEW > WEATHER HISTORY): step the timed weather
// overlays back through the last day of observations, play the loop, or jump
// back to LIVE. Shows the exact observation time on screen, in UTC, ctOS style
// (ddMMyy-hhmm). Drives core/layers/weather/timeline.js; hidden until a weather
// overlay has reported its times.

const fmt = (iso) => {
  if (!iso) return '------';
  const d = new Date(iso);
  const two = (n) => String(n).padStart(2, '0');
  return `${two(d.getUTCDate())}${two(d.getUTCMonth() + 1)}${two(d.getUTCFullYear() % 100)}-${two(d.getUTCHours())}${two(d.getUTCMinutes())}Z`;
};

/** @param {{ timeline: object }} deps */
export function createWeatherStrip({ timeline }) {
  const btn = (label, title, onclick) =>
    h('button.ct-btn', { type: 'button', title, onclick }, label);
  const back = btn('◀', 'Previous observation', () => timeline.step(-1));
  const play = btn('PLAY', 'Loop the last day of observations', () =>
    timeline.togglePlay(),
  );
  const fwd = btn('▶', 'Next observation', () => timeline.step(1));
  const live = btn('LIVE', 'Newest observations', () => timeline.latest());
  const time = h('span.ct-wx__time', {}, '------');
  const note = h(
    'div.ct-section__note',
    {},
    'Turn on radar, IR clouds or lightning to step back through the last day.',
  );
  const row = h('div.ct-seg.ct-wx', { hidden: true }, back, play, fwd, live);
  const el = h('div.ct-wx__wrap', {}, note, row, time);
  time.hidden = true;

  const render = () => {
    const st = timeline.getState();
    const has = (st.timeline?.length ?? 0) > 0;
    row.hidden = !has;
    time.hidden = !has;
    note.hidden = has;
    if (!has) return;
    play.textContent = st.playing ? 'HOLD' : 'PLAY';
    play.setAttribute('aria-pressed', String(st.playing));
    live.setAttribute('aria-pressed', String(st.mode === 'latest'));
    const shown = Object.values(st.frames || {})
      .filter(Boolean)
      .sort()
      .at(-1);
    time.textContent = `${st.mode === 'latest' ? 'LIVE ' : 'OBS  '}${fmt(shown ?? st.target)}${st.loading ? '  LOADING' : ''}`;
  };
  timeline.subscribe(render);
  render();
  // Never loop frames in a background tab.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) timeline.pause();
  });
  return { el };
}
