import './imagerySwitcher.css';

// Imagery switcher: a small segmented control to pick the base imagery (Relief /
// Satellite / Streets). Core builds the element; the shell places it. Selecting a
// source swaps the viewer's base layer via the imagery controller.

/**
 * @param {{ sources: {id: string, label: string}[], current: string, onSelect: (id: string) => void }} opts
 */
export function createImagerySwitcher({ sources, current, onSelect }) {
  const el = document.createElement('div');
  el.className = 'argus-imagery';
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', 'Base imagery');

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

  function setActive(id) {
    for (const [key, btn] of buttons)
      btn.setAttribute('aria-pressed', String(key === id));
    onSelect(id);
  }

  return { el, setActive };
}
