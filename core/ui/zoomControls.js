import './zoomControls.css';

// On-screen zoom stepper (+ / -), a reliable alternative to wheel/pinch zoom on
// trackpads and touch where those gestures are inconsistent. Floats over the
// globe; the shell decides where. Holding a button repeats the step.

/**
 * @param {{ camera: { zoomStep: (dir: number) => void } }} opts
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

  el.append(make(1, '+', 'Zoom in'), make(-1, '−', 'Zoom out'));
  return { el };
}
