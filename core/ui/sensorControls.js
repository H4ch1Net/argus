import './sensorControls.css';

// Sensor shader controls: single-select Normal / NVG / FLIR, plus a CRT overlay
// toggle where the tier supports stacking (desktop). Drives the shader controller.

/**
 * @param {{ shaders: { setSensor: (m: string) => void, setCrt: (b: boolean) => void, crtSupported: boolean, crt: boolean } }} opts
 */
export function createSensorControls({ shaders }) {
  const el = document.createElement('div');
  el.className = 'argus-sensors';

  const buttons = new Map();
  for (const [mode, label] of [
    ['none', 'Normal'],
    ['nvg', 'NVG'],
    ['flir', 'FLIR'],
  ]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'argus-sensors__btn';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      shaders.setSensor(mode);
      setActive(mode);
    });
    el.appendChild(btn);
    buttons.set(mode, btn);
  }

  if (shaders.crtSupported) {
    const crtBtn = document.createElement('button');
    crtBtn.type = 'button';
    crtBtn.className = 'argus-sensors__btn argus-sensors__crt';
    crtBtn.textContent = 'CRT';
    crtBtn.addEventListener('click', () => {
      const on = !shaders.crt;
      shaders.setCrt(on);
      crtBtn.classList.toggle('is-on', on);
    });
    el.appendChild(crtBtn);
  }

  function setActive(mode) {
    for (const [m, btn] of buttons) btn.classList.toggle('is-active', m === mode);
  }
  setActive('none');

  return { el };
}
