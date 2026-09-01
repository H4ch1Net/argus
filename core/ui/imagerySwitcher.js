import './imagerySwitcher.css';

// Segmented control used for the base-imagery picker (Relief / Satellite /
// Streets) and the terrain picker (Flat / 3D Terrain / Photoreal). Core builds
// the element; the shell places it. onSelect may be async and return the id that
// was actually applied, so a mode that falls back (e.g. photoreal without a key)
// reverts the pressed state instead of lying about what took effect.

/**
 * @param {object} opts
 * @param {{id: string, label: string}[]} opts.sources
 * @param {string} opts.current
 * @param {(id: string) => void | string | Promise<void | string>} opts.onSelect
 * @param {string} [opts.ariaLabel]
 */
export function createImagerySwitcher({
  sources,
  current,
  onSelect,
  ariaLabel = 'Base imagery',
}) {
  const el = document.createElement('div');
  el.className = 'argus-imagery';
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', ariaLabel);

  const buttons = new Map();
  for (const s of sources) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'argus-imagery__btn';
    btn.textContent = s.label;
    btn.setAttribute('aria-pressed', String(s.id === current));
    btn.addEventListener('click', () => setActive(s.id));
    buttons.set(s.id, btn);
    el.appendChild(btn);
  }

  function paint(id) {
    for (const [key, btn] of buttons)
      btn.setAttribute('aria-pressed', String(key === id));
  }

  async function setActive(id) {
    paint(id); // optimistic
    const applied = await onSelect(id);
    // If the handler reports a different applied id (fall-back), reflect it.
    if (typeof applied === 'string' && applied !== id) paint(applied);
  }

  return { el, setActive };
}

/**
 * Terrain picker: same segmented control, labelled for terrain. Its onSelect
 * returns the applied mode (from the terrain controller), so a photoreal
 * fall-back reverts the pressed state.
 * @param {object} opts
 * @param {{id: string, label: string}[]} opts.sources
 * @param {string} opts.current
 * @param {(id: string) => Promise<string>} opts.onSelect
 */
export function createTerrainSwitcher({ sources, current, onSelect }) {
  return createImagerySwitcher({ sources, current, onSelect, ariaLabel: 'Terrain' });
}
