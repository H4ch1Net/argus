import * as Cesium from 'cesium';

// Camera controls exposed by core: "set camera to X" / "home". Sensors
// (geolocation, orientation) are shell inputs, not core (master plan 3.2): the
// mobile shell reads GPS and calls flyTo; core never imports sensor code.

export function createCameraControls(viewer) {
  // Re-aim the camera about the ground point at the centre of the screen,
  // keeping its distance; zoomed out past the globe's edge, go home instead.
  function orbitCentre({ heading, pitch }, duration) {
    const camera = viewer.camera;
    const canvas = viewer.scene.canvas;
    const centre = camera.pickEllipsoid(
      new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
      viewer.scene.globe.ellipsoid,
    );
    if (!centre) {
      camera.flyHome(duration);
    } else {
      camera.flyToBoundingSphere(new Cesium.BoundingSphere(centre, 0), {
        offset: new Cesium.HeadingPitchRange(
          heading ?? camera.heading,
          pitch ?? camera.pitch,
          Cesium.Cartesian3.distance(camera.positionWC, centre),
        ),
        duration,
      });
    }
    viewer.scene.requestRender();
  }

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

    /**
     * Step the zoom in (direction > 0) or out (direction < 0) by a fraction of
     * the current eye height, so each press feels proportional at every scale.
     * Backs the on-screen zoom buttons: a reliable zoom on trackpads and touch,
     * where wheel/pinch gestures are inconsistent.
     */
    zoomStep(direction, fraction = 0.4) {
      const h = viewer.camera.positionCartographic.height;
      const amount = Math.max(500, h * fraction);
      if (direction > 0) viewer.camera.zoomIn(amount);
      else viewer.camera.zoomOut(amount);
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
     * Turn the view so north is up, keeping whatever is at the centre of the
     * screen in place (it orbits that point rather than spinning the eye).
     */
    northUp(duration = 0.8) {
      orbitCentre({ heading: 0 }, duration);
    },

    /** Toggle straight-down and a 35 degree oblique view about the screen centre. */
    toggleTilt(duration = 0.8) {
      const steep = viewer.camera.pitch < Cesium.Math.toRadians(-70);
      orbitCentre({ pitch: Cesium.Math.toRadians(steep ? -35 : -90) }, duration);
    },

    /** The camera as plain degrees and metres: a view to keep and go back to. */
    getView() {
      const c = viewer.camera;
      const g = c.positionCartographic;
      return {
        longitude: Cesium.Math.toDegrees(g.longitude),
        latitude: Cesium.Math.toDegrees(g.latitude),
        height: g.height,
        heading: Cesium.Math.toDegrees(c.heading),
        pitch: Cesium.Math.toDegrees(c.pitch),
        roll: Cesium.Math.toDegrees(c.roll),
      };
    },

    /**
     * Fly to a view from getView(). Resolves true when the flight ends, false
     * when something cancels it (a press on the globe, another flight).
     */
    flyToView(v, duration = 1.5) {
      return new Promise((resolve) => {
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(v.longitude, v.latitude, v.height),
          orientation: {
            heading: Cesium.Math.toRadians(v.heading ?? 0),
            pitch: Cesium.Math.toRadians(v.pitch ?? -90),
            roll: Cesium.Math.toRadians(v.roll ?? 0),
          },
          duration,
          complete: () => resolve(true),
          cancel: () => resolve(false),
        });
        viewer.scene.requestRender();
      });
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
