import './compass.css';
import { deviceToCamera } from './orientation.js';

// Point-at-sky mode (mobile shell, master plan 6.6): stand at the user's
// location and let DeviceOrientation aim the camera. A reticle marks where the
// phone points; whatever entity is under it lights up in a HUD, and tapping the
// HUD tracks it. Requires HTTPS + an explicit permission grant on iOS; degrades
// gracefully if denied or unsupported, never blocking the globe.

async function requestOrientationPermission() {
  const DOE = window.DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission === 'function') {
    try {
      return (await DOE.requestPermission()) === 'granted';
    } catch {
      return false;
    }
  }
  return typeof DOE !== 'undefined'; // Android/Chrome: available without a prompt
}

const screenAngle = () => screen.orientation?.angle ?? window.orientation ?? 0;

/**
 * @param {{ cameraControls: object, pickCenter: () => ({entity:object,label:string}|null), onLock: (entity: object) => void }} deps
 */
export function createCompass({ cameraControls, pickCenter, onLock }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'argus-compass-btn';
  button.textContent = 'Point at sky';

  const reticle = document.createElement('div');
  reticle.className = 'argus-reticle';
  reticle.hidden = true;
  reticle.innerHTML =
    '<div class="argus-reticle__ring"></div><button type="button" class="argus-reticle__hud" hidden></button>';
  const hud = reticle.querySelector('.argus-reticle__hud');

  let active = false;
  let userPos = null;
  let onOrient = null;
  let hudTimer = null;
  let current = null;

  const getPosition = () =>
    new Promise((resolve) => {
      if (!('geolocation' in navigator)) return resolve(cameraControls.groundPosition());
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ longitude: p.coords.longitude, latitude: p.coords.latitude }),
        () => resolve(cameraControls.groundPosition()),
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 },
      );
    });

  function refreshHud() {
    const hit = pickCenter?.();
    current = hit?.entity ?? null;
    if (hit?.label) {
      hud.textContent = `▶ ${hit.label}`;
      hud.hidden = false;
    } else {
      hud.hidden = true;
    }
  }

  async function enable() {
    const granted = await requestOrientationPermission();
    if (!granted) {
      button.textContent = 'Orientation blocked';
      setTimeout(() => {
        button.textContent = 'Point at sky';
      }, 2500);
      return;
    }
    userPos = await getPosition();
    onOrient = (e) => {
      if (!userPos) return;
      cameraControls.lookFrom({
        ...userPos,
        height: 30,
        ...deviceToCamera(e, screenAngle()),
      });
    };
    window.addEventListener('deviceorientation', onOrient, true);
    hudTimer = setInterval(refreshHud, 250);
    reticle.hidden = false;
    active = true;
    button.classList.add('is-on');
    button.textContent = 'Exit sky';
  }

  function disable() {
    if (onOrient) {
      window.removeEventListener('deviceorientation', onOrient, true);
      onOrient = null;
    }
    if (hudTimer) {
      clearInterval(hudTimer);
      hudTimer = null;
    }
    reticle.hidden = true;
    active = false;
    current = null;
    button.classList.remove('is-on');
    button.textContent = 'Point at sky';
  }

  button.addEventListener('click', () => (active ? disable() : enable()));
  hud.addEventListener('click', () => {
    if (current) {
      onLock?.(current);
      disable();
    }
  });

  return { button, reticle, isActive: () => active, destroy: disable };
}
