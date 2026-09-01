import { bootGlobe } from '../core/index.js';
import '../core/ui/readout.css';
import './shell.css';

// Desktop shell (Linux / Windows). Side-panel layout, mouse/keyboard. No sensor
// code (geolocation lives only in the mobile shell), so it exposes no aroundMe;
// the "Around Me" preset still enables its layers, just without a fly-to.

/**
 * @param {HTMLElement} root
 */
export async function mountShell(root) {
  root.classList.add('argus-shell-desktop');

  const globeEl = document.createElement('div');
  globeEl.className = 'argus-globe';

  const panelEl = document.createElement('div');
  panelEl.className = 'argus-panel';

  root.append(globeEl, panelEl);

  const app = await bootGlobe(globeEl);

  // Panel order: controls, then readout, then the metadata card.
  const controlsSlot = document.createElement('div');
  controlsSlot.className = 'argus-panel__controls';
  const uiSlot = document.createElement('div');
  panelEl.append(controlsSlot, app.readout.el, uiSlot);

  return {
    ...app,
    mountUi: (el) => uiSlot.appendChild(el),
    mountControls: (parts) => {
      for (const el of Object.values(parts)) if (el) controlsSlot.append(el);
    },
  };
}

export const shellName = 'desktop';
