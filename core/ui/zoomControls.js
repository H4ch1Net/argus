import './zoomControls.css';
import { h } from './dom.js';

// The view stack: a column of 37px framed cells (the bar's workspace cells,
// stood on end) floating over the globe. + / − zoom (hold to repeat), N for
// north up, TLT straight down / oblique, ⌂ the whole Earth, and GEO where the
// shell can read the position: centre on me and follow, again for heading
// up (the cell reads HDG), again to stop. A drag pauses following and a
// RECENTER chip appears beside the cell. A reliable alternative to wheel and
// pinch on trackpads and touch.

const GEO_TITLES = {
  idle: 'Centre on me and follow',
  locating: 'Locating my position',
  centered: 'Centre on me and follow',
  following: 'Following me (tap: heading up)',
  heading: 'Following me, heading up (tap: stop following)',
  paused: 'Following paused (tap: recenter)',
  error: 'No position (location is off, or no fix yet)',
};

/**
 * @param {{ camera: { zoomStep: (dir: number) => void, northUp?: Function,
 *   toggleTilt?: Function, flyHome?: Function },
 *   geo?: { press: () => any, recenter?: () => any,
 *     subscribe: (fn: (s: { state: string, note: string }) => void) => any } | null }} opts
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
    // GEO (core/geo/geoControl.js): its state shows on the cell, with a short
    // note beside it (accuracy, LOCATING, HEADING UP, DENIED) that fades;
    // trouble goes to the log, never to a popup.
    const btn = cell('GEO', GEO_TITLES.idle, { 'aria-pressed': 'false' });
    const label = h('span', {}, 'GEO');
    btn.replaceChildren(label);
    const tag = h('span.ct-viewstack__note', { hidden: true, 'aria-live': 'polite' });
    btn.appendChild(tag);
    btn.addEventListener('click', () => geo.press());
    // RECENTER: a paused follow takes the camera back.
    const recenter = h(
      'button.ct-viewstack__recenter',
      {
        type: 'button',
        hidden: true,
        title: 'Follow me again',
        onclick: () => (geo.recenter ? geo.recenter() : geo.press()),
      },
      'RECENTER',
    );
    let tagTimer = null;
    geo.subscribe(({ state, note }) => {
      const following = state === 'following' || state === 'heading';
      btn.classList.toggle('is-pending', state === 'locating');
      btn.classList.toggle('is-live', state === 'centered' || state === 'paused');
      btn.classList.toggle('is-follow', following);
      btn.classList.toggle('is-error', state === 'error');
      btn.setAttribute('aria-pressed', String(following));
      label.textContent = state === 'heading' ? 'HDG' : 'GEO';
      btn.title = GEO_TITLES[state] ?? GEO_TITLES.idle;
      btn.setAttribute('aria-label', btn.title);
      recenter.hidden = state !== 'paused';
      clearTimeout(tagTimer);
      const text = state === 'paused' ? '' : note || '';
      tag.textContent = text;
      tag.hidden = !text;
      tag.classList.toggle('is-error', state === 'error');
      // Notes fade; LOCATING stays while it lasts.
      if (text && state !== 'locating')
        tagTimer = setTimeout(() => (tag.hidden = true), 2600);
    });
    el.append(btn, recenter);
  }
  return { el };
}
