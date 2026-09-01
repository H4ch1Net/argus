import * as Cesium from 'cesium';
import './cockpit.css';

// Cockpit mode: the camera rides a tracked entity (master plan 8). A chase cam
// sits behind and above the entity, looking along its direction of travel, and
// updates every frame. Heading is derived from the entity's motion, so it is
// layer-agnostic (works for aircraft and satellites alike). Runs at 60fps and
// holds a Wake Lock while active (master plan 6.1); both are released on exit.
//
// "Terrain-following" here clamps the camera to a minimum height above the
// ellipsoid; true terrain sampling arrives with real (token-brokered) terrain.

const CHASE_DISTANCE = 4000; // metres behind the entity
const CHASE_HEIGHT = 1200; // metres above
const LOOK_AHEAD = 1500; // aim point ahead of the entity
const MIN_HEIGHT = 150; // camera floor above the ellipsoid

export function createCockpit(viewer, { onExit } = {}) {
  const scene = viewer.scene;
  let entity = null;
  let active = false;
  let removePreRender = null;
  let wakeLock = null;
  let savedFrameRate = null;
  let exitBtn = null;
  let lastPos = null;
  let forward = null;

  function updateCamera() {
    const cur = entity.position.getValue(viewer.clock.currentTime);
    if (!cur) return;

    if (lastPos) {
      const delta = Cesium.Cartesian3.subtract(cur, lastPos, new Cesium.Cartesian3());
      if (Cesium.Cartesian3.magnitude(delta) > 0.5) {
        forward = Cesium.Cartesian3.normalize(delta, new Cesium.Cartesian3());
      }
    }
    lastPos = Cesium.Cartesian3.clone(cur, lastPos || new Cesium.Cartesian3());

    const up =
      scene.globe.ellipsoid.geodeticSurfaceNormal(cur, new Cesium.Cartesian3()) ||
      Cesium.Cartesian3.normalize(cur, new Cesium.Cartesian3());
    if (!forward) {
      // No motion yet: face along the local eastward tangent.
      forward = Cesium.Cartesian3.cross(
        up,
        Cesium.Cartesian3.UNIT_Z,
        new Cesium.Cartesian3(),
      );
      Cesium.Cartesian3.normalize(forward, forward);
    }

    const camPos = Cesium.Cartesian3.add(
      cur,
      Cesium.Cartesian3.multiplyByScalar(
        forward,
        -CHASE_DISTANCE,
        new Cesium.Cartesian3(),
      ),
      new Cesium.Cartesian3(),
    );
    Cesium.Cartesian3.add(
      camPos,
      Cesium.Cartesian3.multiplyByScalar(up, CHASE_HEIGHT, new Cesium.Cartesian3()),
      camPos,
    );

    // Terrain-follow (ellipsoid floor for now): never let the camera sink below.
    const carto = Cesium.Cartographic.fromCartesian(camPos);
    if (carto.height < MIN_HEIGHT) {
      carto.height = MIN_HEIGHT;
      Cesium.Cartographic.toCartesian(carto, undefined, camPos);
    }

    const lookAt = Cesium.Cartesian3.add(
      cur,
      Cesium.Cartesian3.multiplyByScalar(forward, LOOK_AHEAD, new Cesium.Cartesian3()),
      new Cesium.Cartesian3(),
    );
    const direction = Cesium.Cartesian3.subtract(lookAt, camPos, new Cesium.Cartesian3());
    Cesium.Cartesian3.normalize(direction, direction);

    viewer.camera.setView({ destination: camPos, orientation: { direction, up } });
  }

  async function acquireWakeLock() {
    try {
      if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    } catch {
      // Denied or unsupported: cockpit still works, the screen may just dim.
    }
  }
  function releaseWakeLock() {
    try {
      wakeLock?.release?.();
    } catch {
      // already released
    }
    wakeLock = null;
  }

  function enter(target) {
    if (active || !target) return;
    entity = target;
    active = true;
    lastPos = null;
    forward = null;
    viewer.trackedEntity = undefined; // we drive the camera directly
    scene.screenSpaceCameraController.enableInputs = false;
    savedFrameRate = viewer.targetFrameRate;
    viewer.targetFrameRate = 60;
    removePreRender = scene.preRender.addEventListener(updateCamera);
    acquireWakeLock();
    showExitButton();
    scene.requestRender();
  }

  function exit() {
    if (!active) return;
    active = false;
    removePreRender?.();
    removePreRender = null;
    scene.screenSpaceCameraController.enableInputs = true;
    if (savedFrameRate != null) viewer.targetFrameRate = savedFrameRate;
    releaseWakeLock();
    if (exitBtn) exitBtn.hidden = true;
    entity = null;
    onExit?.();
    scene.requestRender();
  }

  function showExitButton() {
    if (!exitBtn) {
      exitBtn = document.createElement('button');
      exitBtn.type = 'button';
      exitBtn.className = 'argus-cockpit-exit';
      exitBtn.textContent = 'Exit cockpit';
      exitBtn.addEventListener('click', exit);
      document.body.appendChild(exitBtn);
    }
    exitBtn.hidden = false;
  }

  // Capture-phase Escape so it exits cockpit before the tracker's Escape (which
  // would otherwise deselect the entity).
  const onKeyDown = (e) => {
    if (active && e.key === 'Escape') {
      e.stopPropagation();
      exit();
    }
  };
  document.addEventListener('keydown', onKeyDown, true);

  return {
    enter,
    exit,
    isActive: () => active,
    destroy() {
      exit();
      document.removeEventListener('keydown', onKeyDown, true);
      if (exitBtn) exitBtn.remove();
    },
  };
}
