import './zoomControls.css';
import { h } from './dom.js';

// The view stack: a column of 37px framed cells (the bar's workspace cells,
// stood on end) floating over the globe. + / − zoom (hold to repeat), N for
// north up, TLT straight down / oblique, ⌂ the whole Earth, and GEO to centre
// on the device position where the shell can read it. A reliable alternative
// to wheel and pinch on trackpads and touch.

/**
 * @param {{ camera: { zoomStep: (dir: number) => void, northUp?: Function,
 *   toggleTilt?: Function, flyHome?: Function },
 *   onLocate?: (report: (status: 'ok'|'denied'|'unavailable') => void) => void,
 *   onNotify?: (msg: { title: string, body?: string, level?: string }) => void }} opts
 */
export function createZoomControls({ camera, onLocate, onNotify }) {
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
  if (onLocate) {
    let pending = false;
    const geo = cell('GEO', 'Centre on my location');
    geo.addEventListener('click', () => {
      if (pending) return;
      pending = true;
      geo.classList.add('is-pending');
      onLocate((status) => {
        pending = false;
        geo.classList.remove('is-pending');
        geo.classList.toggle('is-error', status !== 'ok');
        if (status !== 'ok') {
          onNotify?.({
            title: status === 'denied' ? 'LOCATION DENIED' : 'LOCATION UNAVAILABLE',
            body:
              status === 'denied'
                ? 'The browser refused location access for this page.'
                : 'This device could not report a position (it needs HTTPS on a phone).',
            level: 'low',
            key: 'geo',
          });
          setTimeout(() => geo.classList.remove('is-error'), 2500);
        }
      });
    });
    el.append(geo);
  }
  return { el };
}
