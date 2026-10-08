import './zoomControls.css';

// On-screen zoom stepper (+ / -), a reliable alternative to wheel/pinch zoom on
// trackpads and touch where those gestures are inconsistent, plus north-up,
// tilt and whole-Earth buttons. Floats over the globe; the shell decides where.
// Holding a zoom button repeats the step.

/**
 * @param {{ camera: { zoomStep: (dir: number) => void, northUp?: Function,
 *   toggleTilt?: Function, flyHome?: Function } }} opts
 */
export function createZoomControls({ camera }) {
  const el = document.createElement('div');
  el.className = 'argus-zoom';

  const make = (dir, label, aria) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'argus-zoom__btn';
    b.textContent = label;
    b.setAttribute('aria-label', aria);
    let held = null;
    const start = (e) => {
      e.preventDefault();
      camera.zoomStep(dir);
      // Repeat while held, accelerating slightly.
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

  // One-tap view resets: north up, straight-down vs oblique, the whole Earth.
  const tap = (label, aria, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'argus-zoom__btn argus-zoom__btn--small';
    b.textContent = label;
    b.title = aria;
    b.setAttribute('aria-label', aria);
    b.addEventListener('click', fn);
    return b;
  };
  el.append(make(1, '+', 'Zoom in'), make(-1, '−', 'Zoom out'));
  if (camera.northUp) el.append(tap('N', 'North up', () => camera.northUp()));
  if (camera.toggleTilt)
    el.append(tap('⟂', 'Straight down / oblique', () => camera.toggleTilt()));
  if (camera.flyHome) el.append(tap('⌂', 'Whole Earth', () => camera.flyHome()));
  return { el };
}
