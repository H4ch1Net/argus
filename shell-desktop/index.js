import { bootGlobe } from '../core/index.js';
import { locateAndFly } from '../core/geo/geolocate.js';
import { buildControlModules, createModule } from '../core/ui/controlPanel.js';
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

  // Panel chrome: a titled terminal header, then the control modules, the SYSTEM
  // STATUS readout, and the metadata card.
  const header = document.createElement('div');
  header.className = 'argus-panel__header';
  header.innerHTML =
    '<span class="argus-panel__mark"></span>' +
    '<span class="argus-panel__name">ARGUS</span>' +
    '<span class="argus-panel__sub">GLOBAL SIGNALS TERMINAL</span>';

  const controlsSlot = document.createElement('div');
  controlsSlot.className = 'argus-panel__controls';
  const statusModule = createStatusModule(app.readout.el);
  const uiSlot = document.createElement('div');
  panelEl.append(header, controlsSlot, statusModule, uiSlot);

  return {
    ...app,
    mountUi: (el) => uiSlot.appendChild(el),
    mountOverlay: (el) => root.appendChild(el),
    mountControls: (parts) => {
      for (const el of buildControlModules(parts)) controlsSlot.append(el);
    },
    // "Around Me" preset fly-to (regional) and the locate-me button (city level).
    aroundMe: (camera) => locateAndFly(camera, { altitude: 120_000 }),
    locate: (camera, report) =>
      locateAndFly(camera, { altitude: 12_000, onStatus: report }),
  };
}

// The capability readout, framed as a SYSTEM STATUS module to match the controls.
function createStatusModule(readoutEl) {
  return createModule('SYSTEM STATUS', readoutEl);
}

export const shellName = 'desktop';
