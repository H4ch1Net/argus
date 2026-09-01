import { bootGlobe } from '../core/index.js';
import { createBottomSheet } from './bottomSheet.js';
import { createCompass } from './compass.js';
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
  const uiSlot = document.createElement('div');
  sheet.content.append(controlsSlot, app.readout.el, uiSlot);

  return {
    ...app,
    mountUi: (el) => uiSlot.appendChild(el),
    mountControls: (parts) => {
      for (const el of Object.values(parts)) if (el) controlsSlot.append(el);
    },
    // "Around Me": fly to the device location. Graceful if denied/unavailable;
    // the globe simply stays at the world view.
    aroundMe: (camera) => {
      if (!('geolocation' in navigator)) return;
      navigator.geolocation.getCurrentPosition(
        (pos) =>
          camera.flyTo({
            longitude: pos.coords.longitude,
            latitude: pos.coords.latitude,
            altitude: 200_000,
          }),
        () => {
          /* denied or unavailable: keep the world view */
        },
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 },
      );
    },
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
