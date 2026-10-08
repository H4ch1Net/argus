import * as Cesium from 'cesium';

// The interaction spine. Selecting a contact makes it the target: the tracking
// overlay locks the hub brackets on it, a fading trail shows where it has been,
// and the target panel opens with its card and actions. Selecting never moves
// the camera; FOLLOW is an explicit action, and it keeps the current viewing
// distance and angle instead of diving in. Deselecting (tap on empty space, the
// panel's ESC button, or Escape) releases everything and leaves the camera
// where it is. Layer-agnostic: resolve(target) supplies the card model and the
// history, so every layer reuses it unchanged.

const TRAIL_MAX_POINTS = 48;
const FOLLOW_MIN_RANGE_M = 1500;
const FOLLOW_MAX_RANGE_M = 600_000;

/**
 * @param {import('cesium').Viewer} viewer
 * @param {object} opts
 * @param {(target: object) => ({ metadata: object, getHistoryFixes: () => object[], mover?: boolean, key?: string } | null)} opts.resolve
 * @param {{ showTarget: Function, clearTarget: Function }} opts.panel
 * @param {{ setSelected: Function, setFollowing: Function }} [opts.overlay]
 * @param {(target: object|null, rec?: object) => void} [opts.onChange]
 * @param {(target: object) => void} [opts.onCockpit]
 * @param {(target: object, rec: object) => object[]} [opts.extraActions]
 * @param {(msg: { title: string, body?: string }) => void} [opts.notify]
 */
export function createTracker(
  viewer,
  { resolve, panel, overlay, onChange, onCockpit, extraActions, notify },
) {
  const scene = viewer.scene;
  let tracked = null; // { target, rec }
  let trailEntity = null;
  let followEntity = null;
  const head = new Cesium.Cartesian3();

  const positionNow = (target, result) =>
    target.position.getValue(viewer.clock.currentTime, result);

  function trailPositions() {
    if (!tracked) return [];
    const fixes = tracked.rec.getHistoryFixes?.().slice(-TRAIL_MAX_POINTS) ?? [];
    const positions = fixes.map((f) =>
      Cesium.Cartesian3.fromDegrees(
        f.longitude,
        f.latitude,
        Math.max(0, f.altitude ?? 0),
      ),
    );
    // The live interpolated head, so the trail meets the moving contact.
    const p = positionNow(tracked.target, head);
    if (p) positions.push(Cesium.Cartesian3.clone(p));
    return positions;
  }

  function addTrail() {
    trailEntity = viewer.entities.add({
      polyline: {
        positions: new Cesium.CallbackProperty(trailPositions, false),
        width: 3,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.18,
          taperPower: 0.45, // fades toward the oldest point
          color: Cesium.Color.WHITE.withAlpha(0.85),
        }),
      },
    });
  }

  function removeTrail() {
    if (trailEntity) viewer.entities.remove(trailEntity);
    trailEntity = null;
  }

  // ------------------------------------------------------------- follow mode
  // Cesium follows a tracked entity, so a hidden 1 px stand-in entity rides
  // the target. Its viewFrom is the camera's current offset in the target's
  // east-north-up frame (clamped to a sensible range), so starting to follow
  // does not jump the view.
  function follow() {
    if (!tracked) return;
    const target = tracked.target;
    const p = positionNow(target, new Cesium.Cartesian3());
    if (!p) return;
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(p);
    const inv = Cesium.Matrix4.inverseTransformation(enu, new Cesium.Matrix4());
    const offset = Cesium.Matrix4.multiplyByPoint(
      inv,
      viewer.camera.positionWC,
      new Cesium.Cartesian3(),
    );
    const range = Cesium.Cartesian3.magnitude(offset);
    const clamped = Math.min(FOLLOW_MAX_RANGE_M, Math.max(FOLLOW_MIN_RANGE_M, range));
    if (range > 0) Cesium.Cartesian3.multiplyByScalar(offset, clamped / range, offset);
    // Looking straight down from far away: tilt a little so the follow reads.
    if (offset.z > 0 && Math.hypot(offset.x, offset.y) < offset.z * 0.15) {
      offset.y = -offset.z * 0.6;
    }
    unfollow(false);
    followEntity = viewer.entities.add({
      position: new Cesium.CallbackProperty(
        (time, result) => positionNow(target, result),
        false,
      ),
      point: { pixelSize: 1, color: Cesium.Color.TRANSPARENT },
      viewFrom: offset,
    });
    viewer.trackedEntity = followEntity;
    overlay?.setFollowing(true);
    refreshPanel();
  }

  function unfollow(refresh = true) {
    if (!followEntity) return;
    if (viewer.trackedEntity === followEntity) viewer.trackedEntity = undefined;
    viewer.entities.remove(followEntity);
    followEntity = null;
    overlay?.setFollowing(false);
    if (refresh) refreshPanel();
  }

  function flyTo() {
    if (!tracked) return;
    const p = positionNow(tracked.target, new Cesium.Cartesian3());
    if (!p) return;
    unfollow(false);
    const carto = Cesium.Cartographic.fromCartesian(p);
    const height = Math.max(carto.height, 0);
    const range = Math.min(
      Math.max(viewer.camera.positionCartographic.height * 0.4, 4000),
      250_000,
    );
    viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(p, 1), {
      offset: new Cesium.HeadingPitchRange(
        viewer.camera.heading,
        -Math.PI / 4,
        range + height * 0.1,
      ),
      duration: 1.6,
    });
    refreshPanel();
  }

  // ------------------------------------------------------------------ panel
  function actionsFor(target, rec) {
    const out = [
      {
        label: followEntity ? 'FOLLOWING' : 'FOLLOW',
        title: 'Keep the camera on this target (F)',
        pressed: Boolean(followEntity),
        ok: true,
        onClick: () => (followEntity ? unfollow() : follow()),
      },
      { label: 'FLY TO', title: 'Fly the camera to it', onClick: flyTo },
    ];
    if (rec.mover && onCockpit) {
      out.push({
        label: 'COCKPIT',
        title: 'Ride along (C)',
        onClick: () => onCockpit(target),
      });
    }
    return out.concat(extraActions?.(target, rec) ?? []);
  }

  function refreshPanel() {
    if (!tracked) return;
    const rec = resolve(tracked.target);
    if (!rec) {
      notify?.({
        title: 'TARGET LOST',
        body: `${tracked.rec.metadata.title} left the feed.`,
      });
      deselect();
      return;
    }
    tracked.rec = rec;
    panel.showTarget(rec.metadata, actionsFor(tracked.target, rec));
    overlay?.setSelected(tracked.target, hubInfo(rec));
  }

  function hubInfo(rec) {
    const m = rec.metadata;
    return {
      label: String(m.title ?? '').toUpperCase(),
      sub: m.readout ?? String(m.subtitle ?? '').toUpperCase(),
      history: () => rec.getHistoryFixes?.().length ?? 0,
    };
  }

  // The card is DOM, so it refreshes on a 1 s timer, not per frame; feed data
  // changes only every poll. The same tick notices a target that left the feed.
  let refreshTimer = null;
  function startRefresh() {
    stopRefresh();
    refreshTimer = setInterval(refreshPanel, 1000);
  }
  function stopRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
  }

  function select(target) {
    const rec = target ? resolve(target) : null;
    if (!rec) {
      deselect();
      return;
    }
    if (tracked?.target !== target) unfollow(false);
    tracked = { target, rec };
    if (!trailEntity) addTrail();
    panel.showTarget(rec.metadata, actionsFor(target, rec));
    overlay?.setSelected(target, hubInfo(rec));
    startRefresh();
    onChange?.(target, rec);
    scene.requestRender();
  }

  function deselect() {
    if (!tracked) return;
    unfollow(false);
    tracked = null;
    removeTrail();
    stopRefresh();
    panel.clearTarget();
    overlay?.setSelected(null);
    onChange?.(null);
    scene.requestRender();
  }

  const onKeyDown = (e) => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
    if (e.key === 'Escape') deselect();
    else if ((e.key === 'f' || e.key === 'F') && tracked && !e.ctrlKey && !e.metaKey) {
      if (followEntity) unfollow();
      else follow();
    }
  };
  document.addEventListener('keydown', onKeyDown);

  return {
    select,
    deselect,
    follow,
    unfollow,
    flyTo,
    get trackedEntity() {
      return tracked?.target ?? null;
    },
    get following() {
      return Boolean(followEntity);
    },
    /** Re-follow after something else (cockpit) borrowed the camera. */
    resume() {
      if (followEntity) viewer.trackedEntity = followEntity;
    },
    destroy() {
      deselect();
      document.removeEventListener('keydown', onKeyDown);
    },
  };
}
