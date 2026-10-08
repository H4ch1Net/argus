import * as Cesium from 'cesium';
import {
  camPose,
  normalizePose,
  projectionGeometry,
  stillSourceKind,
} from './projectionGeometry.js';

// PROJECT: a public traffic camera's published still, placed in the 3D scene
// where the camera looks. Thin white lines run from the camera to the four far
// corners and around the far rectangle (the ctOS frustum), and the still fills
// that rectangle as a textured quad facing back at the camera.
//
// Why a far-plane quad and not a ground drape: the quad is exact for any
// pitch (a drape needs every corner ray to hit the ground, which the upper
// rays of a camera looking down a road never do), it maps the image without
// the affine smear a 4-point ground polygon gives, and it is what the cctv
// layer and the reference's "monitor plane" already draw. The quad is lifted
// rigidly until it clears the ground at the camera (./projectionGeometry.js).
//
// Display only: the image is a blob: URL the caller fetched (./still.js) or a
// same-origin / proxy URL, loaded straight into a texture. This module makes
// no requests of its own and never reads the pixels (project guardrail).
//
// Geometry is held in callback properties that return cached values, so a
// pose edit from the gizmo redraws on the next requested frame with no async
// rebuild (and no flicker) under requestRenderMode.

const LINE = Cesium.Color.WHITE.withAlpha(0.95);
const SCREEN_TINT = Cesium.Color.WHITE.withAlpha(0.94);
const VIEW_PITCH_DEG = -22; // looking down along the frustum from behind and above

const placeholders = new Map();
/** A small ctOS card for the quad while the still loads or when it cannot. */
function placeholder(text) {
  let c = placeholders.get(text);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = 320;
  c.height = 180;
  const g = c.getContext('2d');
  g.fillStyle = '#0e0e0e';
  g.fillRect(0, 0, 320, 180);
  g.strokeStyle = '#d9d9d9';
  g.lineWidth = 2;
  g.strokeRect(1, 1, 318, 178);
  g.fillStyle = '#ffffff';
  g.font = '600 15px monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 160, 90);
  placeholders.set(text, c);
  return c;
}

/** { id, name, lon, lat } from a normalized entity or a catalogue record. */
function locate(record) {
  const lat = Number(record?.position?.latitude ?? record?.lat);
  const lon = Number(record?.position?.longitude ?? record?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return {
    id: String(record.id ?? ''),
    name: String(record.meta?.name ?? record.name ?? 'Camera'),
    lon,
    lat,
  };
}

/**
 * @param {import('cesium').Viewer} viewer
 * @param {{ proxyBase?: string|null }} [opts]  proxyBase: the proxy's root URL,
 *   for a proxy that is not on the page's own origin (VITE_PROXY_BASE_URL)
 */
export function createCamProjection(viewer, { proxyBase = null } = {}) {
  const scene = viewer.scene;
  let state = null; // { id, name, lon, lat, pose, aspect, ground, cart }
  let entities = [];
  let material = null;
  let removeTileListener = null;
  let loadToken = 0;
  let destroyed = false;

  function groundAt() {
    const c = Cesium.Cartographic.fromDegrees(state.lon, state.lat);
    let h;
    try {
      if (scene.globe?.show) h = scene.globe.getHeight(c);
      else if (scene.sampleHeightSupported) h = scene.sampleHeight(c, entities);
    } catch {
      h = undefined;
    }
    if (Number.isFinite(h)) return h;
    return Number.isFinite(state.pose.groundM) ? state.pose.groundM : 0;
  }

  // Cartesian positions and the quad's frame from the pure geometry.
  function recompute() {
    const geo = projectionGeometry(
      { lon: state.lon, lat: state.lat, groundM: state.ground },
      state.pose,
      { aspect: state.aspect },
    );
    const at = (p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.height);
    const mount = at(geo.mount);
    const [tl, tr, br, bl] = geo.corners.map(at);
    // The quad's frame: x = right, y = up, z = back toward the camera.
    const rot = Cesium.Matrix4.getMatrix3(
      Cesium.Transforms.eastNorthUpToFixedFrame(mount),
      new Cesium.Matrix3(),
    );
    const world = (v) =>
      Cesium.Matrix3.multiplyByVector(
        rot,
        new Cesium.Cartesian3(v.e, v.n, v.u),
        new Cesium.Cartesian3(),
      );
    const frame = new Cesium.Matrix3();
    Cesium.Matrix3.setColumn(frame, 0, world(geo.axes.right), frame);
    Cesium.Matrix3.setColumn(frame, 1, world(geo.axes.up), frame);
    Cesium.Matrix3.setColumn(
      frame,
      2,
      Cesium.Cartesian3.negate(world(geo.axes.dir), new Cesium.Cartesian3()),
      frame,
    );
    state.cart = {
      // Two strokes cover the eight edges once each (four corners have odd
      // degree, so one polyline cannot).
      strokeA: [tl, tr, br, bl, tl, mount, tr],
      strokeB: [br, mount, bl],
      center: at(geo.center),
      orientation: Cesium.Quaternion.fromRotationMatrix(frame),
      dimensions: new Cesium.Cartesian2(geo.halfW * 2, geo.halfH * 2),
      sphere: Cesium.BoundingSphere.fromPoints([mount, tl, tr, br, bl]),
    };
    scene.requestRender();
  }

  const live = (fn) => new Cesium.CallbackProperty(fn, false);
  // A position wants a PositionProperty; older Cesium builds lack the callback one.
  const livePosition = (fn) =>
    Cesium.CallbackPositionProperty
      ? new Cesium.CallbackPositionProperty(fn, false)
      : new Cesium.CallbackProperty(fn, false);

  function addEntities() {
    material = new Cesium.ImageMaterialProperty({
      image: placeholder('ACQUIRING STILL'),
      color: SCREEN_TINT,
      transparent: true,
    });
    const stroke = (key) =>
      viewer.entities.add({
        polyline: {
          positions: live(() => state?.cart[key] ?? []),
          width: 1,
          arcType: Cesium.ArcType.NONE,
          material: LINE,
        },
      });
    const screen = viewer.entities.add({
      position: livePosition((_t, result) =>
        state ? Cesium.Cartesian3.clone(state.cart.center, result) : undefined,
      ),
      orientation: live((_t, result) =>
        state ? Cesium.Quaternion.clone(state.cart.orientation, result) : undefined,
      ),
      plane: {
        plane: new Cesium.Plane(Cesium.Cartesian3.UNIT_Z, 0),
        dimensions: live((_t, result) =>
          state ? Cesium.Cartesian2.clone(state.cart.dimensions, result) : undefined,
        ),
        material,
      },
    });
    entities = [stroke('strokeA'), stroke('strokeB'), screen];
  }

  function removeEntities() {
    for (const e of entities) viewer.entities.remove(e);
    entities = [];
    material = null;
  }

  function useImage(img) {
    if (!state || !material) return;
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (w > 0 && h > 0) {
      state.aspect = w / h;
      recompute();
    }
    material.image = img;
    scene.requestRender();
  }

  function setImage(src) {
    const token = ++loadToken;
    if (!material) return;
    // An <img> (the card's) is reloaded from its URL with CORS mode set, so a
    // cross-origin proxy image can never taint the WebGL context.
    const url =
      typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement
        ? src.currentSrc || src.src
        : src;
    if (url === null || url === undefined || url === '') {
      material.image = placeholder('NO STILL');
      scene.requestRender();
      return;
    }
    const kind = stillSourceKind(url, { origin: location.origin, proxyBase });
    if (!kind) {
      material.image = placeholder('STILL REFUSED');
      scene.requestRender();
      return;
    }
    material.image = placeholder('ACQUIRING STILL');
    const img = new Image();
    if (kind === 'same-origin' || kind === 'proxy') img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => token === loadToken && useImage(img);
    img.onerror = () => {
      if (token !== loadToken || !material) return;
      material.image = placeholder('STILL UNAVAILABLE');
      scene.requestRender();
    };
    img.src = url;
  }

  /** Re-measure the ground under the camera; redraw if it moved. */
  function refreshGround() {
    if (!state) return;
    const h = groundAt();
    if (Math.abs(h - state.ground) > 0.5) {
      state.ground = h;
      recompute();
    }
  }

  function hide() {
    loadToken += 1;
    removeTileListener?.();
    removeTileListener = null;
    if (!state && !entities.length) return;
    removeEntities();
    state = null;
    scene.requestRender();
  }

  return {
    /**
     * Project a camera's still. Replaces any projection already shown.
     * @param {object} record  the normalized trafficcam ({ id, position, meta })
     *   or a catalogue record ({ id, lat, lon, name, pose })
     * @param {string|HTMLImageElement|null} image  a blob: URL (./still.js),
     *   a same-origin or proxy URL, or the card's <img>; null shows the frustum
     *   with a NO STILL card
     * @param {object} [pose]  an edited pose ({ heading, pitch, fovDeg, rangeM,
     *   heightM? }, the gizmo's shape); fields it lacks come from the prior
     * @returns {boolean} false when the record has no usable position
     */
    show(record, image, pose) {
      if (destroyed) return false;
      const at = locate(record);
      if (!at) return false;
      hide();
      state = { ...at, pose: camPose(record, pose), aspect: 16 / 9, ground: 0 };
      state.ground = groundAt();
      recompute();
      addEntities();
      setImage(image);
      // Terrain tiles finish loading after the fly-in: re-measure the ground.
      removeTileListener = scene.globe?.tileLoadProgressEvent.addEventListener(
        (queued) => queued === 0 && refreshGround(),
      );
      scene.requestRender();
      return true;
    },

    /** Swap the still (a newer frame) without touching the pose. */
    setImage(image) {
      if (state) setImage(image);
    },

    hide,

    /** Apply an edited pose (the gizmo's onChange), merged over the current one. */
    setPose(pose) {
      if (!state || !pose) return;
      state.pose = normalizePose({ ...state.pose, ...pose });
      recompute();
    },

    /** What is projected: { id, name, pose } (pose is a copy), or null. */
    active() {
      return state ? { id: state.id, name: state.name, pose: { ...state.pose } } : null;
    },

    /**
     * Fly the view behind and above the camera, looking along the frustum,
     * framed so the whole frustum and still are in view on any screen.
     * Release FOLLOW first (viewer.trackedEntity would hold the camera).
     */
    flyToView({ duration = 1.8 } = {}) {
      if (!state) return false;
      viewer.camera.flyToBoundingSphere(state.cart.sphere, {
        offset: new Cesium.HeadingPitchRange(
          Cesium.Math.toRadians(state.pose.heading),
          Cesium.Math.toRadians(VIEW_PITCH_DEG),
          0, // 0: Cesium picks the range that fits the sphere
        ),
        duration,
        complete: refreshGround,
      });
      scene.requestRender();
      return true;
    },

    refreshGround,

    destroy() {
      hide();
      destroyed = true;
    },
  };
}
