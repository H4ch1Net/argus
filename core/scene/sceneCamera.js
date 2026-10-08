import * as Cesium from 'cesium';

// The scene director's camera (core/ui/scenesTool.js): read the view as a shot
// camera and fly to one, with a promise that settles when the flight does.
// Degrees and metres in and out (core/share/scenes.js); Cesium takes radians.

/**
 * @param {import('cesium').Viewer} viewer
 */
export function createSceneCamera(viewer) {
  const camera = viewer.camera;
  const scene = viewer.scene;
  const deg = Cesium.Math.toDegrees;
  const rad = Cesium.Math.toRadians;

  return {
    /** The view now: { lon, lat, alt, heading, pitch, roll } (degrees, metres). */
    read() {
      const pc = camera.positionCartographic;
      return {
        lon: deg(pc.longitude),
        lat: deg(pc.latitude),
        alt: pc.height,
        heading: deg(camera.heading),
        pitch: deg(camera.pitch),
        roll: deg(camera.roll),
      };
    },

    /**
     * Fly to a shot camera over durationMs (0: jump there). Resolves true when
     * the flight lands, false when it is cancelled (by the signal, by a newer
     * flight, or by the user taking the camera).
     * @param {{ lon: number, lat: number, alt: number, heading?: number,
     *   pitch?: number, roll?: number }} c
     * @param {number} durationMs
     * @param {AbortSignal} [signal]
     * @returns {Promise<boolean>}
     */
    flyTo(c, durationMs, signal) {
      return new Promise((resolve) => {
        if (signal?.aborted) {
          resolve(false);
          return;
        }
        let settled = false;
        const onAbort = () => camera.cancelFlight(); // Cesium then runs cancel
        const done = (landed) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          scene.requestRender();
          resolve(landed);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        const destination = Cesium.Cartesian3.fromDegrees(c.lon, c.lat, c.alt);
        const orientation = {
          heading: rad(c.heading ?? 0),
          pitch: rad(c.pitch ?? -90),
          roll: rad(c.roll ?? 0),
        };
        if (!(durationMs > 0)) {
          camera.cancelFlight();
          camera.setView({ destination, orientation });
          done(true);
          return;
        }
        camera.flyTo({
          destination,
          orientation,
          duration: durationMs / 1000,
          complete: () => done(true),
          cancel: () => done(false),
        });
        scene.requestRender();
      });
    },
  };
}
