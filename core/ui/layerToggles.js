import './layerToggles.css';

// Per-layer on/off pills. Reflects and drives the layer manager; re-renders on
// any manager change (so presets update these too). onManualToggle fires when
// the user toggles a layer here, letting the shell clear the active preset.

/**
 * @param {{ manager: object, onManualToggle?: () => void }} opts
 */
export function createLayerToggles({ manager, onManualToggle }) {
  const el = document.createElement('div');
  el.className = 'argus-toggles';

  function render() {
    el.innerHTML = '';
    for (const { key, label, enabled } of manager.list()) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'argus-toggles__btn';
      btn.classList.toggle('is-on', enabled);
      btn.dataset.layer = key;
      btn.setAttribute('aria-pressed', String(enabled));
      btn.textContent = label;
      btn.addEventListener('click', async () => {
        await manager.toggle(key);
        onManualToggle?.();
      });
      el.appendChild(btn);
    }
  }

  render();
  manager.subscribe(render);
  return { el, render };
}
