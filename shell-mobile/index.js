import { bootGlobe } from '../core/index.js';
import { locateAndFly } from '../core/geo/geolocate.js';
import { createBottomSheet } from './bottomSheet.js';
import { createCompass } from './compass.js';
import { buildControlModules, createModule } from '../core/ui/controlPanel.js';
import '../core/ui/readout.css';
import './shell.css';

// Mobile shell v1 (S25-tuned). Owns the bottom-sheet layout, touch defaults, and
// the phone-native "Around Me" geolocation view. Sensors are shell inputs: this
// shell reads GPS and calls core's camera.flyTo; core never imports sensor code.

/**
 * @param {HTMLElement} root
 */
export async function mountShell(root) {
  root.classList.add('argus-shell-mobile');

  const globeEl = document.createElement('div');
  globeEl.className = 'argus-globe';
  root.appendChild(globeEl);

  const app = await bootGlobe(globeEl);

  const sheet = createBottomSheet({ peekHeight: 118 });
  root.appendChild(sheet.el);

  // Sheet content, top to bottom: presets + toggles (visible in the peek zone),
  // then the capability readout and the metadata card.
  const controlsSlot = document.createElement('div');
  controlsSlot.className = 'argus-sheet__controls';
  const statusModule = createModule('SYSTEM STATUS', app.readout.el);
  const uiSlot = document.createElement('div');
  sheet.content.append(controlsSlot, statusModule, uiSlot);

  return {
    ...app,
    mountUi: (el) => uiSlot.appendChild(el),
    mountOverlay: (el) => root.appendChild(el),
    mountControls: (parts) => {
      for (const el of buildControlModules(parts)) controlsSlot.append(el);
    },
    // "Around Me": fly to the device location at a regional altitude, so nearby
    // flights and quakes are in view. Graceful if denied/unavailable: the globe
    // simply stays put.
    aroundMe: (camera) => locateAndFly(camera, { altitude: 120_000 }),
    // "Locate me": zoom in closer to the user's position (city level), reporting
    // status so the button can show a denied/unavailable state.
    locate: (camera, report) =>
      locateAndFly(camera, { altitude: 12_000, onStatus: report }),
    // Point-at-sky mode: DeviceOrientation drives the camera. main provides the
    // camera controls plus how to identify and lock the aimed entity. The compass
    // button joins the controls; the reticle is a full-screen overlay.
    enableCompass: (deps) => {
      const compass = createCompass(deps);
      controlsSlot.appendChild(compass.button);
      root.appendChild(compass.reticle);
      return compass;
    },
  };
}

export const shellName = 'mobile';
