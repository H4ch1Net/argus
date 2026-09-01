import * as Cesium from 'cesium';

// Camera controls exposed by core: "set camera to X" / "home". Sensors
// (geolocation, orientation) are shell inputs, not core (master plan 3.2): the
// mobile shell reads GPS and calls flyTo; core never imports sensor code.

export function createCameraControls(viewer) {
  return {
    /** Fly to a geographic point. altitude in metres (eye height above the point). */
    flyTo({ longitude, latitude, altitude = 250_000, duration = 1.5 }) {
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(longitude, latitude, altitude),
        duration,
      });
      viewer.scene.requestRender();
    },
    flyHome(duration = 1.5) {
      viewer.camera.flyHome(duration);
      viewer.scene.requestRender();
    },

    /** The camera's current ground point (degrees), a fallback when GPS is denied. */
    groundPosition() {
      const c = viewer.camera.positionCartographic;
      return {
        longitude: Cesium.Math.toDegrees(c.longitude),
        latitude: Cesium.Math.toDegrees(c.latitude),
      };
    },

    /**
     * Place the camera at a point and aim it (degrees). Used by the mobile
     * shell's point-at-sky mode: stand at the user's position and look where the
     * phone points. heading 0 = north, pitch 0 = horizon, +90 = zenith.
     */
    lookFrom({ longitude, latitude, height = 30, heading = 0, pitch = 0, roll = 0 }) {
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(longitude, latitude, height),
        orientation: {
          heading: Cesium.Math.toRadians(heading),
          pitch: Cesium.Math.toRadians(pitch),
          roll: Cesium.Math.toRadians(roll),
        },
      });
      viewer.scene.requestRender();
    },
  };
}
