import './zoomControls.css';
import { h } from './dom.js';

// The view stack: a column of 37px framed cells (the bar's workspace cells,
// stood on end) floating over the globe. + / − zoom (hold to repeat), N for
// north up, TLT straight down / oblique, ⌂ the whole Earth, and GEO to centre
// on the device position (and follow it) where the shell can read it. A
// reliable alternative to wheel and pinch on trackpads and touch.

const GEO_TITLES = {
  idle: 'Centre on my location',
  locating: 'Locating my position',
  centered: 'Tap again to follow my position',
  following: 'Following my position (tap to stop)',
  error: 'No position (location is off, or no fix yet)',
};

/**
 * @param {{ camera: { zoomStep: (dir: number) => void, northUp?: Function,
 *   toggleTilt?: Function, flyHome?: Function },
 *   geo?: { press: () => any, subscribe: (fn: (s: { state: string, note: string }) => void) => any } | null }} opts
 */
export function createZoomControls({ camera, geo }) {
  const el = h('div.ct-viewstack', { role: 'group', 'aria-label': 'View controls' });

  const cell = (label, aria, extra = {}) =>
    h(
      'button.ct-viewstack__cell.ct-frame',
      { type: 'button', title: aria, 'aria-label': aria, ...extra },
      label,
    );

  const repeat = (dir, label, aria) => {
    const b = cell(label, aria);
    let held = null;
    const start = (e) => {
      e.preventDefault();
      camera.zoomStep(dir);
      let delay = 320;
      const tick = () => {
        camera.zoomStep(dir);
        delay = Math.max(90, delay - 40);
        held = setTimeout(tick, delay);
      };
      held = setTimeout(tick, delay);
    };
    const stop = () => {
      if (held) clearTimeout(held);
      held = null;
    };
    b.addEventListener('pointerdown', start);
    b.addEventListener('pointerup', stop);
    b.addEventListener('pointerleave', stop);
    b.addEventListener('pointercancel', stop);
    return b;
  };

  el.append(repeat(1, '+', 'Zoom in'), repeat(-1, '−', 'Zoom out'));
  if (camera.northUp)
    el.append(cell('N', 'North up', { onclick: () => camera.northUp() }));
  if (camera.toggleTilt)
    el.append(
      cell('TLT', 'Straight down / oblique', { onclick: () => camera.toggleTilt() }),
    );
  if (camera.flyHome)
    el.append(cell('⌂', 'Whole Earth', { onclick: () => camera.flyHome() }));
  if (geo) {
    // GEO (core/geo/geoControl.js): centre on me, then follow-me, then off.
    // Its state shows on the cell, with a short note beside it (accuracy,
    // LOCATING, DENIED); trouble goes to the log, never to a popup.
    const btn = cell('GEO', GEO_TITLES.idle, { 'aria-pressed': 'false' });
    const tag = h('span.ct-viewstack__note', { hidden: true, 'aria-live': 'polite' });
    btn.appendChild(tag);
    btn.addEventListener('click', () => geo.press());
    let tagTimer = null;
    geo.subscribe(({ state, note }) => {
      btn.classList.toggle('is-pending', state === 'locating');
      btn.classList.toggle('is-live', state === 'centered');
      btn.classList.toggle('is-follow', state === 'following');
      btn.classList.toggle('is-error', state === 'error');
      btn.setAttribute('aria-pressed', String(state === 'following'));
      btn.title = GEO_TITLES[state] ?? GEO_TITLES.idle;
      btn.setAttribute('aria-label', btn.title);
      clearTimeout(tagTimer);
      tag.textContent = note || '';
      tag.hidden = !note;
      tag.classList.toggle('is-error', state === 'error');
      // Notes fade; the ongoing states keep theirs while they last.
      if (note && state !== 'locating' && state !== 'following')
        tagTimer = setTimeout(() => (tag.hidden = true), 2600);
    });
    el.append(btn);
  }
  return { el };
}
