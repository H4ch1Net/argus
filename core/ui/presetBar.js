import './presetBar.css';

// Preset buttons. Core builds the element and owns selection highlighting; the
// shell decides where it sits. Selecting a preset calls onSelect(preset).

/**
 * @param {{ presets: object[], onSelect: (preset: object) => void }} opts
 */
export function createPresetBar({ presets, onSelect }) {
  const el = document.createElement('div');
  el.className = 'argus-presets';

  for (const p of presets) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'argus-presets__btn';
    btn.dataset.preset = p.id;
    btn.textContent = p.label;
    btn.addEventListener('click', () => {
      setActive(p.id);
      onSelect(p);
    });
    el.appendChild(btn);
  }

  function setActive(id) {
    for (const btn of el.querySelectorAll('.argus-presets__btn')) {
      btn.classList.toggle('is-active', btn.dataset.preset === id);
    }
  }

  return { el, setActive };
}
