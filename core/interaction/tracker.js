import * as Cesium from 'cesium';

// The interaction spine: selecting an entity tracks it (camera follows), draws a
// fading trail of its recent path, highlights it, and shows a metadata card.
// Deselecting (tap on empty space, the card's close button, or Escape) restores
// everything. It is layer-agnostic: a `resolve(entity)` callback supplies the
// card model and the trail history, so later layers reuse it unchanged.

const TRAIL_MAX_POINTS = 24;

let ringImageCache = null;
function ringImage() {
  if (ringImageCache) return ringImageCache;
  const S = 64;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d');
  const cx = S / 2;
  // Targeting-bracket reticle: four corner brackets around a thin ring, the way
  // an ops console frames a locked contact. Phosphor cyan, restrained glow.
  g.strokeStyle = '#7ff2ff';
  g.shadowColor = 'rgba(95,227,255,0.9)';
  g.shadowBlur = 4;
  g.lineWidth = 2;
  g.beginPath();
  g.arc(cx, cx, 15, 0, Math.PI * 2);
  g.stroke();

  g.lineWidth = 3;
  const r = 26; // corner distance from centre
  const len = 9; // bracket arm length
  for (let i = 0; i < 4; i++) {
    const sx = i & 1 ? 1 : -1;
    const sy = i & 2 ? 1 : -1;
    const x = cx + sx * r;
    const y = cx + sy * r;
    g.beginPath();
    g.moveTo(x - sx * len, y);
    g.lineTo(x, y);
    g.lineTo(x, y - sy * len);
    g.stroke();
  }
  ringImageCache = c;
  return c;
}

/**
 * @param {import('cesium').Viewer} viewer
 * @param {object} opts
 * @param {(entity: import('cesium').Entity) => ({ metadata: object, getHistoryFixes: () => object[] } | null)} opts.resolve
 * @param {{ show: (m: object) => void, hide: () => void }} opts.card
 * @param {(entity: import('cesium').Entity | null) => void} [opts.onChange]
 */
export function createTracker(viewer, { resolve, card, onChange, onCockpit }) {
  const scene = viewer.scene;
  let tracked = null; // { entity, getHistoryFixes }

  // A "Cockpit" action is offered for movers when a cockpit handler is wired.
  const actionsFor = (entity, rec) =>
    rec.mover && onCockpit
      ? [{ label: 'Cockpit', onClick: () => onCockpit(entity) }]
      : [];
  let trailEntity = null;
  let haloEntity = null;

  function trailPositions() {
    if (!tracked) return [];
    const fixes = tracked.getHistoryFixes().slice(-TRAIL_MAX_POINTS);
    const positions = fixes.map((f) =>
      Cesium.Cartesian3.fromDegrees(
        f.longitude,
        f.latitude,
        Math.max(0, f.altitude ?? 0),
      ),
    );
    // Append the live interpolated head so the trail meets the moving aircraft.
    const head = tracked.entity.position.getValue(viewer.clock.currentTime);
    if (head) positions.push(head);
    return positions;
  }

  function haloPosition() {
    return tracked
      ? tracked.entity.position.getValue(viewer.clock.currentTime)
      : undefined;
  }

  function addOverlays() {
    trailEntity = viewer.entities.add({
      polyline: {
        positions: new Cesium.CallbackProperty(trailPositions, false),
        width: 2.5,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.2,
          taperPower: 0.4, // fades toward the oldest point
          color: Cesium.Color.fromCssColorString('#5fe3ff'),
        }),
        // No depthFailMaterial: the trail is occluded by the globe where it
        // passes behind the limb (depthTestAgainstTerrain) instead of showing
        // through it.
      },
    });
    haloEntity = viewer.entities.add({
      position: new Cesium.CallbackProperty(haloPosition, false),
      billboard: {
        image: ringImage(),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(1e6, 1.0, 2e7, 0.5),
      },
    });
  }

  function removeOverlays() {
    if (trailEntity) viewer.entities.remove(trailEntity);
    if (haloEntity) viewer.entities.remove(haloEntity);
    trailEntity = null;
    haloEntity = null;
  }

  // Trail/halo positions update per frame (cheap), but the card is DOM, so it is
  // refreshed on a 1s timer rather than every frame; feed data changes only
  // every poll (~15s). The same tick drops the selection if the tracked aircraft
  // has left the view (resolve returns null once it is gone).
  let refreshTimer = null;
  function startRefresh() {
    stopRefresh();
    refreshTimer = setInterval(() => {
      if (!tracked) return;
      const rec = resolve(tracked.entity);
      if (!rec) deselect();
      else card.show(rec.metadata, actionsFor(tracked.entity, rec));
    }, 1000);
  }
  function stopRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  function select(entity) {
    const rec = entity ? resolve(entity) : null;
    if (!rec) {
      deselect();
      return;
    }
    if (!trailEntity) addOverlays();
    tracked = { entity, getHistoryFixes: rec.getHistoryFixes };
    viewer.trackedEntity = entity; // camera follows
    card.show(rec.metadata, actionsFor(entity, rec));
    startRefresh();
    onChange?.(entity);
    scene.requestRender();
  }

  function deselect() {
    if (!tracked) return;
    tracked = null;
    viewer.trackedEntity = undefined;
    removeOverlays();
    stopRefresh();
    card.hide();
    onChange?.(null);
    scene.requestRender();
  }

  const onKeyDown = (e) => {
    if (e.key === 'Escape') deselect();
  };
  document.addEventListener('keydown', onKeyDown);

  return {
    select,
    deselect,
    get trackedEntity() {
      return tracked?.entity ?? null;
    },
    destroy() {
      deselect();
      document.removeEventListener('keydown', onKeyDown);
    },
  };
}
