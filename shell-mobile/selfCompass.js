import { deviceToCamera } from './orientation.js';

// The phone's compass for the own-position marker (core/geo/selfPosition.js):
// while the position sensors are open (GEO, follow-me, Around Me), absolute
// device orientation is turned into a heading and pushed in, so the icon
// points where the phone points when the user stands still (the course takes
// over when moving). Listens only while sensing, at most ten readings a second.
// A sensor, so a shell input: core never reads it (CLAUDE.md).

const MIN_MS = 100;

const screenAngle = (win) => win.screen?.orientation?.angle ?? win.orientation ?? 0;

/**
 * @param {{ watch: Function, setCompass: (deg: number|null) => void }} selfPosition
 * @returns {() => void} detach
 */
export function attachSelfCompass(selfPosition, { win = window } = {}) {
  if (!selfPosition?.watch || !selfPosition.setCompass || !win) return () => {};
  // Chrome on Android sends a north-referenced alpha only on the "absolute"
  // event; iOS gives webkitCompassHeading on the plain one.
  const type =
    'ondeviceorientationabsolute' in win
      ? 'deviceorientationabsolute'
      : 'deviceorientation';
  let listening = false;
  let last = -Infinity;
  const onOrient = (e) => {
    const absolute =
      type === 'deviceorientationabsolute' ||
      e.absolute === true ||
      typeof e.webkitCompassHeading === 'number';
    if (!absolute || (e.alpha == null && typeof e.webkitCompassHeading !== 'number'))
      return;
    const t = performance.now();
    if (t - last < MIN_MS) return;
    last = t;
    selfPosition.setCompass(deviceToCamera(e, screenAngle(win)).heading);
  };
  const unwatch = selfPosition.watch(({ sensing }) => {
    if (sensing && !listening) {
      win.addEventListener(type, onOrient);
      listening = true;
    } else if (!sensing && listening) {
      win.removeEventListener(type, onOrient);
      listening = false;
      selfPosition.setCompass(null);
    }
  });
  return () => {
    unwatch?.();
    if (listening) win.removeEventListener(type, onOrient);
    listening = false;
  };
}
