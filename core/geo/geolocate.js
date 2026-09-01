// One-shot device geolocation, then a camera fly.
//
// Architecture note: sensors are normally shell inputs (master plan 3.2), and this
// is the one small utility in core that touches an optional browser sensor. It is
// invoked ONLY by a shell, never on the boot path, so the globe still boots with
// zero sensor dependency. Both shells share it so the "locate me" button and the
// "Around Me" preset behave identically on phone and desktop (the owner asked for
// locate-me on the target they use, which is desktop as well as mobile).
//
// It resolves to a status the caller can surface: 'ok', 'denied', or 'unavailable'.
// Graceful by contract: on denial or absence the globe simply stays where it is.

/**
 * @param {{ flyTo: (o: {longitude:number, latitude:number, altitude:number}) => void }} camera
 * @param {{ altitude?: number, onStatus?: (s: 'ok'|'denied'|'unavailable') => void }} [opts]
 */
export function locateAndFly(camera, { altitude = 60_000, onStatus } = {}) {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
    onStatus?.('unavailable');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      camera.flyTo({
        longitude: pos.coords.longitude,
        latitude: pos.coords.latitude,
        altitude,
      });
      onStatus?.('ok');
    },
    (err) => {
      // 1 = PERMISSION_DENIED; anything else is position unavailable / timeout.
      onStatus?.(err && err.code === 1 ? 'denied' : 'unavailable');
    },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 },
  );
}
