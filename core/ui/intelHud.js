import './intelHud.css';
import * as Cesium from 'cesium';
import { h } from './dom.js';
import {
  cadenceMs,
  ecefToLatLon,
  inFreeArea,
  intelReadout,
  normalizePlaces,
} from './intelHudModel.js';

// The Intel HUD: ISR-style telemetry over the globe in the ctOS language. A
// marking banner, REC and the UTC time, the view band and altitude, the
// render mode, heading and off-nadir angle, and along the bottom the MGRS and
// DMS of the ground point under the canvas centre (the camera nadir when the
// centre is sky), GSD and NIIRS, sun elevation there, and the nearest place
// with distance and bearing.
//
// Read-only: it reads the camera and never moves it, and it passes every
// pointer through (pointer-events: none), so it needs no input handling and
// works the same on touch, pen and mouse. Updates at 4 Hz (2 Hz on the
// MINIMAL tier) only while visible and the page is shown, plus once whenever
// the camera settles. The REC dot blinks in CSS, not on a timer. All numbers
// come from intelHudModel.js (pure, tested).
//
// Adapted from gods-eye-view src/hud.js (MIT).

const DEG = 180 / Math.PI;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * @param {import('cesium').Viewer} viewer
 * @param {{
 *   places?: ({ name: string, lat: number, lon: number }|[string, number, number])[],
 *   getMode?: () => string,
 *   tier?: string,
 * }} [opts] places: what NEAR measures against (core/search/places.js CITIES
 *   rows work as is); getMode: the render mode label (NORMAL, NVG, FLIR, ...);
 *   tier: the capability tier ('minimal' halves the update rate)
 */
export function createIntelHud(viewer, { places = [], getMode, tier } = {}) {
  const scene = viewer?.scene;
  const camera = viewer?.camera;
  const list = normalizePlaces(places);
  const period = cadenceMs(tier);
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };

  // ---------------------------------------------------------------- DOM
  const val = (cls = '') => h(`span.ct-intel__v${cls}`, {}, '---');
  const pair = (label, valueEl, cls = '') =>
    h(`span.ct-intel__pair${cls}`, {}, h('span.ct-intel__k', {}, label), valueEl);
  const line = (cls, ...kids) => h(`div.ct-intel__line${cls}`, {}, ...kids);

  const f = {
    date: h('span.ct-intel__v.ct-intel__x', {}, ''),
    time: val(),
    band: val(),
    alt: val(),
    mode: val(),
    hdg: val(),
    ona: val(),
    mgrs: val(),
    src: h('span.ct-intel__tag', { hidden: true }, 'NADIR'),
    dms: h('span.ct-intel__v', {}, '---'),
    gsd: val(),
    niirs: val(),
    sun: val(),
    nearK: h('span.ct-intel__k', {}, 'NEAR'),
    near: val('.ct-intel__v--near'),
  };

  const banner = h(
    'div.ct-intel__banner',
    {},
    h(
      'span.ct-intel__cls',
      {},
      'UNCLASSIFIED // OPEN SOURCE',
      h('span.ct-intel__x', {}, ' // PUBLIC FEEDS'),
    ),
  );

  const topLeft = h(
    'div.ct-intel__block',
    {},
    line(
      '.ct-intel__rec',
      h('span.ct-intel__dot', { 'aria-hidden': 'true' }, '●'),
      h('span.ct-intel__k', {}, 'REC'),
      h('span.ct-intel__stamp', {}, f.date, f.time),
    ),
    line('.ct-intel__y', pair('VIEW', f.band), pair('ALT', f.alt)),
  );
  const topRight = h(
    'div.ct-intel__block.ct-intel__block--end',
    {},
    line('', pair('MODE', f.mode)),
    line('.ct-intel__y', pair('HDG', f.hdg), pair('ONA', f.ona, '.ct-intel__xn')),
  );
  const bottomLeft = h(
    'div.ct-intel__block',
    {},
    line('', pair('MGRS', f.mgrs), f.src),
    line('.ct-intel__x', f.dms),
  );
  const nearPair = h('span.ct-intel__pair.ct-intel__pair--near', {}, f.nearK, f.near);
  const bottomRight = h(
    'div.ct-intel__block.ct-intel__block--end',
    {},
    line('', pair('GSD', f.gsd), pair('NIIRS', f.niirs)),
    line('.ct-intel__y', pair('SUN', f.sun), nearPair),
  );

  const area = h(
    'div.ct-intel__area',
    {},
    h('div.ct-intel__frame'),
    banner,
    h('div.ct-intel__top', {}, topLeft, topRight),
    h('div.ct-intel__bottom', {}, bottomLeft, bottomRight),
  );
  const reticle = h('div.ct-intel__reticle', { hidden: true });
  const el = h(
    'div.ct-intel',
    { hidden: true, role: 'group', 'aria-label': 'Intel HUD' },
    reticle, // first, so the text plates draw over it
    area,
  );

  const put = (node, text) => {
    if (node.textContent !== text) node.textContent = text;
  };

  // ---------------------------------------------------------------- read
  const win = new Cesium.Cartesian2();

  function sample() {
    const canvas = scene?.canvas;
    const w = num(canvas?.clientWidth) ?? 0;
    const hPx = num(canvas?.clientHeight) ?? 0;

    // Ground point under the canvas centre, and the slant range to it.
    let center = null;
    let rangeM = null;
    if (w > 0 && hPx > 0 && typeof camera?.pickEllipsoid === 'function') {
      win.x = w / 2;
      win.y = hPx / 2;
      const hit = camera.pickEllipsoid(win, scene?.globe?.ellipsoid);
      center = ecefToLatLon(hit);
      const pos = camera.positionWC;
      if (
        center &&
        num(pos?.x) !== null &&
        num(pos?.y) !== null &&
        num(pos?.z) !== null
      ) {
        rangeM = Math.hypot(hit.x - pos.x, hit.y - pos.y, hit.z - pos.z);
      }
    }

    // Camera position (the nadir fallback) and the terrain under it.
    const carto = camera?.positionCartographic;
    const lat = num(carto?.latitude);
    const lon = num(carto?.longitude);
    const cam =
      lat !== null && lon !== null
        ? { lat: lat * DEG, lon: lon * DEG, height: num(carto.height) }
        : null;
    let groundHeight = null;
    if (cam && typeof scene?.globe?.getHeight === 'function') {
      groundHeight = num(scene.globe.getHeight(carto));
    }

    return {
      w,
      h: hPx,
      readout: intelReadout({
        center,
        camera: cam,
        groundHeight,
        rangeM,
        pitch: num(camera?.pitch),
        heading: num(camera?.heading),
        fovy: num(camera?.frustum?.fovy),
        heightPx: hPx,
        places: list,
        date: new Date(),
      }),
    };
  }

  let warned = false;
  function tick() {
    let s;
    try {
      s = sample();
    } catch (err) {
      // A transient scene state (context loss, a mode morph) must not throw
      // four times a second: keep the last readout and say so once.
      if (!warned) {
        warned = true;
        console.warn('[intel-hud] camera read failed; keeping the last readout', err);
      }
      return;
    }
    const t = s.readout.text;
    put(f.date, `${t.date} `);
    put(f.time, t.time);
    put(f.band, t.band);
    put(f.alt, t.alt);
    put(
      f.mode,
      String((typeof getMode === 'function' && getMode()) || 'NORMAL').toUpperCase(),
    );
    put(f.hdg, t.hdg);
    put(f.ona, t.ona);
    put(f.mgrs, t.mgrs);
    f.src.hidden = s.readout.source !== 'NADIR';
    put(f.dms, t.dms);
    put(f.gsd, t.gsd);
    put(f.niirs, t.niirs);
    put(f.sun, t.sun);
    put(f.nearK, t.nearLabel);
    put(f.near, t.near);
    // The reticle marks the point the MGRS line names: only when that is the
    // canvas centre (not the nadir fallback) and the centre is not under a panel.
    reticle.hidden = !(
      s.readout.source === 'CENTER' && inFreeArea(s.w / 2, s.h / 2, s.w, s.h, insets)
    );
  }

  // ---------------------------------------------------------------- timers
  let visible = false;
  let destroyed = false;
  let timer = null;
  const pageHidden = () => typeof document !== 'undefined' && document.hidden;
  const running = () => visible && !destroyed && !pageHidden();

  function sync() {
    if (running()) {
      if (!timer) {
        timer = setInterval(tick, period);
        tick();
      }
    } else if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  const onVisibility = () => sync();
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }
  const removeMoveEnd = camera?.moveEnd?.addEventListener?.(() => {
    if (running()) tick();
  });

  return {
    el,
    /** Show or hide the HUD; timers run only while it is shown. */
    setVisible(on) {
      visible = Boolean(on) && !destroyed;
      el.hidden = !visible;
      sync();
    },
    visible: () => visible,
    /**
     * Keep the HUD inside the free area between panels (px from each edge of
     * viewer.container). Partial updates merge, as the tracking overlay's do.
     */
    setInsets(next = {}) {
      for (const k of ['top', 'right', 'bottom', 'left']) {
        const v = num(next[k]);
        if (v !== null) insets[k] = Math.max(0, v);
      }
      el.style.setProperty('--ct-intel-t', `${insets.top}px`);
      el.style.setProperty('--ct-intel-r', `${insets.right}px`);
      el.style.setProperty('--ct-intel-b', `${insets.bottom}px`);
      el.style.setProperty('--ct-intel-l', `${insets.left}px`);
      if (running()) tick();
    },
    destroy() {
      destroyed = true;
      visible = false;
      sync();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
      if (typeof removeMoveEnd === 'function') removeMoveEnd();
      el.remove();
    },
  };
}
