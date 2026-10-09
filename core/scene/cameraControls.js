import * as Cesium from 'cesium';

// Camera controls exposed by core: "set camera to X" / "home". Sensors
// (geolocation, orientation) are shell inputs, not core (master plan 3.2): the
// mobile shell reads GPS and calls flyTo; core never imports sensor code.

// Zoom about a point: never nearer the point than this, never further out than
// this from the Earth's centre.
const ZOOM_MIN_RANGE_M = 40;
const ZOOM_MAX_DISTANCE_M = 5e7;

export function createCameraControls(viewer) {
  // Called before every move made through these controls (the orbit stops).
  const before = new Set();
  const pre = () => {
    cancelZoom();
    before.forEach((fn) => fn());
  };

  // ---------------------------------------------------- zoom about a point
  // Double tap, triple tap and trackpad pinch: the camera slides along the ray
  // through the tapped pixel, keeping its orientation, so what is under the
  // finger stays under it the whole way. Animated on rAF (eased), cancelled by
  // the next press on the globe or any other move made through these controls.
  const scene = viewer.scene;
  const win = new Cesium.Cartesian2();
  const zoomFrom = new Cesium.Cartesian3();
  const zoomTo = new Cesium.Cartesian3();
  const zoomAt3 = new Cesium.Cartesian3();
  const zoomDir = new Cesium.Cartesian3();
  const zoomUp = new Cesium.Cartesian3();
  let zoomRaf = 0;
  let lastZoom = null; // { start: Cartesian3, point: Cartesian3, t } of the last zoom in
  function cancelZoom() {
    if (zoomRaf) cancelAnimationFrame(zoomRaf);
    zoomRaf = 0;
  }
  scene.canvas.addEventListener('pointerdown', cancelZoom);

  /** The ground under a window position (terrain when loaded), or undefined. */
  function groundAt(x, y) {
    win.x = x;
    win.y = y;
    const camera = viewer.camera;
    const ray = scene.globe?.pick ? camera.getPickRay(win) : null;
    const hit = ray ? scene.globe.pick(ray, scene, new Cesium.Cartesian3()) : undefined;
    return (
      hit ?? camera.pickEllipsoid(win, scene.globe.ellipsoid, new Cesium.Cartesian3())
    );
  }

  /** The camera flies free (not following a target nor looking at one). */
  function freeCamera() {
    const t = viewer.camera.transform;
    return (
      !viewer.trackedEntity && (!t || Cesium.Matrix4.equals(t, Cesium.Matrix4.IDENTITY))
    );
  }

  function slideTo(destination, duration) {
    const camera = viewer.camera;
    Cesium.Cartesian3.clone(camera.positionWC, zoomFrom);
    Cesium.Cartesian3.clone(destination, zoomTo);
    Cesium.Cartesian3.clone(camera.directionWC, zoomDir);
    Cesium.Cartesian3.clone(camera.upWC, zoomUp);
    const place = (k) => {
      Cesium.Cartesian3.lerp(zoomFrom, zoomTo, k, zoomAt3);
      camera.setView({
        destination: zoomAt3,
        orientation: { direction: zoomDir, up: zoomUp },
      });
      scene.requestRender();
    };
    if (!(duration > 0)) {
      place(1);
      return;
    }
    const t0 = performance.now();
    const ms = duration * 1000;
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      place(1 - (1 - k) ** 3); // ease out: quick start, soft landing
      zoomRaf = k < 1 ? requestAnimationFrame(step) : 0;
    };
    zoomRaf = requestAnimationFrame(step);
  }
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
    /** fn() runs before every move made through these controls; returns an unsubscribe. */
    beforeMove(fn) {
      before.add(fn);
      return () => before.delete(fn);
    },
    /** Fly to a geographic point. altitude in metres (eye height above the point). */
    flyTo({ longitude, latitude, altitude = 250_000, duration = 1.5 }) {
      pre();
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(longitude, latitude, altitude),
        duration,
      });
      viewer.scene.requestRender();
    },
    flyHome(duration = 1.5) {
      pre();
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
      pre();
      const h = viewer.camera.positionCartographic.height;
      const amount = Math.max(500, h * fraction);
      if (direction > 0) viewer.camera.zoomIn(amount);
      else viewer.camera.zoomOut(amount);
      viewer.scene.requestRender();
    },

    /**
     * Zoom about a window position (CSS px from the canvas corner): factor 2
     * halves the distance to the ground there, 0.5 doubles it. chain: start
     * from where the previous zoom in started (a triple tap undoes its double
     * tap's zoom, then zooms out). duration 0 moves at once (trackpad pinch).
     */
    zoomAt(pos, factor, { duration = 0.32, chain = false } = {}) {
      if (!(factor > 0) || factor === 1) return;
      pre();
      const camera = viewer.camera;
      camera.cancelFlight?.();
      if (!freeCamera()) {
        // Following or looking at a target: zoom toward it instead.
        const d = Cesium.Cartesian3.magnitude(camera.position);
        if (factor > 1) camera.zoomIn(d * (1 - 1 / factor));
        else camera.zoomOut(d * (1 / factor - 1));
        scene.requestRender();
        return;
      }
      const now = performance.now();
      const chained = chain && lastZoom && now - lastZoom.t < 2000 ? lastZoom : null;
      const canvas = scene.canvas;
      const point =
        chained?.point ??
        groundAt(pos.x, pos.y) ??
        groundAt(canvas.clientWidth / 2, canvas.clientHeight / 2);
      if (!point) {
        this.zoomStep(factor > 1 ? 1 : -1);
        return;
      }
      const base = chained?.start ?? Cesium.Cartesian3.clone(camera.positionWC);
      if (!chain && factor > 1) lastZoom = { start: base, point, t: now };
      else lastZoom = null;
      const away = Cesium.Cartesian3.subtract(base, point, new Cesium.Cartesian3());
      const dist = Cesium.Cartesian3.magnitude(away);
      if (!(dist > 0)) return;
      let next = Math.max(ZOOM_MIN_RANGE_M, dist / factor);
      // Not past the outer limit (measured from the Earth's centre).
      const dest = Cesium.Cartesian3.add(
        point,
        Cesium.Cartesian3.multiplyByScalar(away, next / dist, new Cesium.Cartesian3()),
        new Cesium.Cartesian3(),
      );
      const out = Cesium.Cartesian3.magnitude(dest);
      if (out > ZOOM_MAX_DISTANCE_M) {
        next *= ZOOM_MAX_DISTANCE_M / out;
        Cesium.Cartesian3.add(
          point,
          Cesium.Cartesian3.multiplyByScalar(away, next / dist, dest),
          dest,
        );
      }
      slideTo(dest, duration);
    },

    /**
     * Fly to fit a box (degrees; west > east crosses the antimeridian), keeping
     * the heading and at most a moderate tilt. A tiny box (contacts stacked on
     * one spot) gets a minimum size that still lands low enough to draw every
     * contact apart (below the merge height).
     */
    fitBounds(
      { west, south, east, north },
      { pad = 0.35, minSpanDeg = 0.01, duration = 1.2 } = {},
    ) {
      if (![west, south, east, north].every(Number.isFinite)) return;
      pre();
      const camera = viewer.camera;
      const span = east >= west ? east - west : east + 360 - west;
      let lon = west + span / 2;
      if (lon > 180) lon -= 360;
      const lat = (south + north) / 2;
      const cos = Math.max(0.2, Math.cos(Cesium.Math.toRadians(lat)));
      const halfLat = (Math.max(north - south, minSpanDeg) * (1 + pad)) / 2;
      const halfLon = (Math.max(span * cos, minSpanDeg) * (1 + pad)) / 2;
      const radius = Math.hypot(halfLat, halfLon) * 111_320;
      const pitch = Math.min(camera.pitch, Cesium.Math.toRadians(-40));
      camera.flyToBoundingSphere(
        new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(lon, lat, 0), radius),
        { offset: new Cesium.HeadingPitchRange(camera.heading, pitch, 0), duration },
      );
      scene.requestRender();
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
      pre();
      orbitCentre({ heading: 0 }, duration);
    },

    /** Toggle straight-down and a 35 degree oblique view about the screen centre. */
    toggleTilt(duration = 0.8) {
      pre();
      const steep = viewer.camera.pitch < Cesium.Math.toRadians(-70);
      orbitCentre({ pitch: Cesium.Math.toRadians(steep ? -35 : -90) }, duration);
    },

    /**
     * Fly to look at a point from a range, heading and pitch (degrees; pitch
     * negative looks down). height lifts the point above the ground, so a
     * landmark is framed at its middle; the ground comes from the loaded
     * terrain when there is some, else groundM.
     */
    flyAround({
      longitude,
      latitude,
      height = 0,
      groundM = 0,
      range = 1500,
      heading = 0,
      pitch = -35,
      duration = 2,
    }) {
      pre();
      const ground =
        viewer.scene.globe?.getHeight?.(
          Cesium.Cartographic.fromDegrees(longitude, latitude),
        ) ?? groundM;
      const center = Cesium.Cartesian3.fromDegrees(longitude, latitude, ground + height);
      // Resolves true when the flight lands, false when something cancels it.
      return new Promise((resolve) => {
        viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(center, 1), {
          offset: new Cesium.HeadingPitchRange(
            Cesium.Math.toRadians(heading),
            Cesium.Math.toRadians(pitch),
            range,
          ),
          duration,
          complete: () => resolve(true),
          cancel: () => resolve(false),
        });
        viewer.scene.requestRender();
      });
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
      pre();
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
      pre();
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
