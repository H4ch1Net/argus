import './gizmo.css';

// CCTV pose-calibration gizmo: sliders for heading / pitch / FOV / range. Shown
// when a camera is tracked; edits update the camera's pose live. On desktop and
// with the S Pen (pointerType 'pen') the sliders give the precision that fingers
// lack for aligning a camera to what it actually shows.

const FIELDS = [
  { key: 'heading', label: 'Heading', min: 0, max: 360, step: 1, unit: '°' },
  { key: 'pitch', label: 'Pitch', min: 0, max: 80, step: 1, unit: '°' },
  { key: 'fovDeg', label: 'FOV', min: 20, max: 120, step: 1, unit: '°' },
  { key: 'rangeM', label: 'Range', min: 50, max: 1000, step: 10, unit: ' m' },
];

/**
 * @param {{ onChange: (pose: object) => void }} opts
 */
export function createPoseGizmo({ onChange }) {
  const el = document.createElement('div');
  el.className = 'argus-gizmo';
  el.hidden = true;

  const title = document.createElement('div');
  title.className = 'argus-gizmo__title';
  el.appendChild(title);

  let pose = null;
  const inputs = new Map();

  for (const f of FIELDS) {
    const row = document.createElement('label');
    row.className = 'argus-gizmo__row';
    const name = document.createElement('span');
    name.textContent = f.label;
    const value = document.createElement('span');
    value.className = 'argus-gizmo__value';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = f.min;
    input.max = f.max;
    input.step = f.step;
    input.addEventListener('input', () => {
      if (!pose) return;
      pose = { ...pose, [f.key]: Number(input.value) };
      value.textContent = `${Math.round(pose[f.key])}${f.unit}`;
      onChange(pose);
    });
    row.append(name, input, value);
    el.appendChild(row);
    inputs.set(f.key, { input, value });
  }

  return {
    el,
    show(nextPose, name) {
      pose = { ...nextPose };
      title.textContent = `Calibrate: ${name}`;
      for (const f of FIELDS) {
        const { input, value } = inputs.get(f.key);
        input.value = pose[f.key];
        value.textContent = `${Math.round(pose[f.key])}${f.unit}`;
      }
      el.hidden = false;
    },
    hide() {
      pose = null;
      el.hidden = true;
    },
  };
}
