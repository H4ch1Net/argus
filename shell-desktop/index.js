import { bootGlobe } from '../core/index.js';
import { locateAndFly } from '../core/geo/geolocate.js';
import '../core/ui/readout.css';
import './shell.css';

// Desktop shell (Linux / Windows). Side-panel layout, mouse/keyboard. It uses a
// one-shot geolocation for "Around Me" and the locate-me button (the owner asked
// for locate-me on desktop too); it deliberately still does NOT import the
// continuous orientation/compass sensor, which stays mobile-only.

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
    // "Around Me" preset fly-to (regional) and the locate-me button (city level).
    aroundMe: (camera) => locateAndFly(camera, { altitude: 120_000 }),
    locate: (camera, report) =>
      locateAndFly(camera, { altitude: 12_000, onStatus: report }),
  };
}

export const shellName = 'desktop';
