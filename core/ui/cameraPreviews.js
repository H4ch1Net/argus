import './cameraPreviews.css';
import * as Cesium from 'cesium';
import { h } from './dom.js';
import {
  pickPreviews,
  placeCards,
  stillDue,
  ageLabel,
  shortName,
  PREVIEW_MAX_VIEW_KM,
  PREVIEW_DEFAULT,
  PREVIEW_MAX,
} from './cameraPreviewsModel.js';

// CAMERA PREVIEWS: the latest published still of the few traffic cameras and
// webcams nearest the middle of the view, shown beside their icons without a
// tap. When the view is under about 15 km across, up to K (4 by default, at
// most 8) ctOS-framed thumbnails sit next to their cameras, each with a thin
// leader line to its icon, its tracking id, a short name and the still's age.
// A press on a thumbnail selects the camera (its full card).
//
// Cost: the set is re-chosen at most 4 times a second, and only on frames
// Cesium renders anyway (requestRenderMode); in between, postRender projects
// just those K points and moves their cards (a transform, no layout). A still
// is fetched through the proxy's image feeds (the layer's own still URL, via
// core/layers/trafficcams/still.js), at most once a minute per camera, only
// while the page is visible and the camera's layer is on, and kept as a blob
// for a dozen recent cameras.
//
// GUARDRAIL: display only. The stills are shown as published; nothing reads,
// measures or analyses their pixels.

const PICK_MS = 250;
const TICK_MS = 5000;
const KEEP = 12; // stills kept for cameras that left the set
const LAYERS = ['trafficcams', 'webcams'];

const win = new Cesium.Cartesian2();
const edge = new Cesium.Cartesian2();
const scratchA = new Cesium.Cartesian3();
const scratchB = new Cesium.Cartesian3();

/**
 * @param {import('cesium').Viewer} viewer
 * @param {{
 *   getLayers: () => { key: string, layer: object }[],
 *   loadStill: (image: object, opts?: { signal?: AbortSignal }) =>
 *     Promise<{ url: string, revoke: () => void }>,
 *   getInsets?: () => { top: number, right: number, bottom: number, left: number },
 *   idFor?: (target: object) => number,
 *   onSelect?: (target: object) => void,
 *   isBusy?: () => boolean,
 *   avoid?: () => { x: number, y: number, w: number, h: number }[],
 *   enabled?: boolean, count?: number,
 * }} opts
 *   getLayers: the active layers (manager.active()); idFor: the tracking
 *   overlay's two-digit ids; isBusy: true to hide them (cockpit mode); avoid: screen rects the
 *   cards keep clear of (the selected target's label)
 */
export function createCameraPreviews(
  viewer,
  {
    getLayers,
    loadStill,
    getInsets = () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
    idFor = () => null,
    onSelect,
    isBusy = () => false,
    avoid = () => [],
    enabled: on = true,
    count: k = PREVIEW_DEFAULT,
  },
) {
  const scene = viewer.scene;
  const host = viewer.container ?? scene.canvas.parentElement;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ct-campreviews__lines');
  svg.setAttribute('aria-hidden', 'true');
  const el = h('div.ct-campreviews', { 'aria-label': 'Camera previews' });
  el.appendChild(svg);
  host.appendChild(el);

  let enabled = Boolean(on);
  let count = clampCount(k);
  let lastPick = 0;
  let area = { left: 0, top: 0, right: 0, bottom: 0 };
  let cardW = 128;
  let cardH = 92;
  const shown = new Map(); // id -> card state
  const stills = new Map(); // id -> { url, revoke, loadedAt, failedAt, loading } (LRU)
  const slots = new Map(); // id -> last slot
  const pool = [];
  // The host's size, kept by an observer (never read from layout per frame).
  const size = { w: host.clientWidth || 0, h: host.clientHeight || 0 };
  const ro = new ResizeObserver(() => {
    size.w = host.clientWidth;
    size.h = host.clientHeight;
    lastPick = 0;
  });
  ro.observe(host);

  function clampCount(n) {
    return Math.max(1, Math.min(PREVIEW_MAX, Math.round(Number(n) || PREVIEW_DEFAULT)));
  }

  // ------------------------------------------------------------------ cards
  function makeCard() {
    const img = h('img.ct-campreview__img', {
      alt: '',
      decoding: 'async',
      draggable: false,
    });
    const id = h('span.ct-campreview__id');
    const name = h('span.ct-campreview__name');
    const age = h('span.ct-campreview__age');
    const note = h('span.ct-campreview__note');
    const card = h(
      'button.ct-campreview',
      { type: 'button' },
      h('span.ct-campreview__frame', {}, img, note, age),
      h('span.ct-campreview__bar', {}, id, name),
    );
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('class', 'ct-campreviews__line');
    return { card, img, id, name, age, note, line };
  }

  function show(c) {
    const dom = pool.pop() ?? makeCard();
    const rec = c.layer.getRecord?.(c.target.id);
    const model = rec?.cardModel;
    const entry = {
      ...c,
      dom,
      image: model?.image?.url ? model.image : null,
      title: model?.title ?? 'Camera',
      sx: NaN,
      sy: NaN,
    };
    dom.card.dataset.layer = c.key;
    dom.card.title = `${entry.title}: select`;
    dom.card.onclick = () => onSelect?.(c.target);
    const n = idFor(c.target);
    dom.id.textContent = Number.isFinite(n) ? String(n).padStart(2, '0') : 'CAM';
    dom.name.textContent = shortName(entry.title);
    dom.img.hidden = true;
    dom.note.textContent = entry.image ? 'LOADING' : 'NO STILL';
    dom.age.textContent = '';
    dom.card.style.visibility = 'hidden';
    dom.line.style.visibility = 'hidden';
    el.appendChild(dom.card);
    svg.appendChild(dom.line);
    shown.set(c.id, entry);
    paintStill(entry);
    refreshStill(entry);
  }

  function hide(id) {
    const e = shown.get(id);
    if (!e) return;
    shown.delete(id);
    slots.delete(id);
    e.dom.card.remove();
    e.dom.line.remove();
    e.dom.card.onclick = null;
    e.dom.img.removeAttribute('src');
    pool.push(e.dom);
  }

  function hideAll() {
    for (const id of [...shown.keys()]) hide(id);
  }

  // ----------------------------------------------------------------- stills
  function paintStill(e) {
    const s = stills.get(e.id);
    if (s?.url) {
      if (e.dom.img.getAttribute('src') !== s.url) e.dom.img.src = s.url;
      e.dom.img.hidden = false;
      e.dom.note.textContent = '';
      e.dom.age.textContent = ageLabel(Date.now() - s.loadedAt);
    } else if (s?.failedAt && !s.loading) {
      e.dom.note.textContent = 'NO STILL';
    }
  }

  function layerOn(key) {
    return getLayers().some((a) => a.key === key);
  }

  async function refreshStill(e) {
    if (!e.image || document.hidden || !layerOn(e.key)) return;
    let s = stills.get(e.id);
    const now = Date.now();
    if (s && !stillDue(s, now)) return;
    if (!s) {
      s = {
        url: null,
        revoke: null,
        loadedAt: undefined,
        failedAt: undefined,
        loading: false,
      };
      stills.set(e.id, s);
    }
    s.loading = true;
    try {
      const got = await loadStill(e.image);
      s.revoke?.();
      s.url = got.url;
      s.revoke = got.revoke;
      s.loadedAt = Date.now();
      s.failedAt = undefined;
    } catch (err) {
      s.failedAt = Date.now();
      console.warn(`[argus] preview still ${e.id}: ${err?.message || err}`);
    } finally {
      s.loading = false;
    }
    // Most recently used last; forget the oldest beyond what is shown + KEEP.
    stills.delete(e.id);
    stills.set(e.id, s);
    for (const [id, old] of stills) {
      if (stills.size <= shown.size + KEEP) break;
      if (shown.has(id)) continue;
      old.revoke?.();
      stills.delete(id);
    }
    const live = shown.get(e.id);
    if (live) paintStill(live);
  }

  // A slow tick: refresh due stills and the age labels (no render needed).
  const tick = setInterval(() => {
    if (!enabled || document.hidden || !shown.size) return;
    for (const e of shown.values()) {
      paintStill(e);
      refreshStill(e);
    }
  }, TICK_MS);

  // -------------------------------------------------------------- picking
  function viewAcrossKm() {
    const midY = (area.top + area.bottom) / 2;
    win.x = area.left + 8;
    win.y = midY;
    const a = viewer.camera.pickEllipsoid(win, scene.globe.ellipsoid, scratchA);
    edge.x = area.right - 8;
    edge.y = midY;
    const b = viewer.camera.pickEllipsoid(edge, scene.globe.ellipsoid, scratchB);
    if (!a || !b) return Infinity; // the horizon is in view
    return Cesium.Cartesian3.distance(a, b) / 1000;
  }

  function pick() {
    const ins = getInsets() || {};
    area = {
      left: ins.left || 0,
      top: ins.top || 0,
      right: size.w - (ins.right || 0),
      bottom: size.h - (ins.bottom || 0),
    };
    const layers = getLayers().filter((a) => LAYERS.includes(a.key));
    if (
      !layers.length ||
      isBusy() ||
      area.right - area.left < 200 ||
      viewAcrossKm() > PREVIEW_MAX_VIEW_KM
    ) {
      hideAll();
      return;
    }
    const cands = [];
    const pad = 12;
    for (const { key, layer } of layers) {
      layer.forEachVisible?.((target, world) => {
        if (cands.length >= 400) return;
        const p = Cesium.SceneTransforms.worldToWindowCoordinates(scene, world, win);
        if (!p || p.x < area.left + pad || p.x > area.right - pad) return;
        if (p.y < area.top + pad || p.y > area.bottom - pad) return;
        cands.push({
          id: `${key}:${target.id}`,
          key,
          layer,
          target,
          world,
          x: p.x,
          y: p.y,
        });
      });
    }
    const chosen = pickPreviews(cands, {
      cx: (area.left + area.right) / 2,
      cy: (area.top + area.bottom) / 2,
      k: count,
      current: new Set(shown.keys()),
    });
    const want = new Set(chosen.map((c) => c.id));
    for (const id of [...shown.keys()]) if (!want.has(id)) hide(id);
    for (const c of chosen) if (!shown.has(c.id)) show(c);
    if (shown.size && cardW === 128) {
      const any = shown.values().next().value.dom.card;
      cardW = any.offsetWidth || cardW;
      cardH = any.offsetHeight || cardH;
    }
  }

  // ------------------------------------------------------------- placing
  function place() {
    const pts = [];
    for (const e of shown.values()) {
      const p = Cesium.SceneTransforms.worldToWindowCoordinates(scene, e.world, win);
      if (p) pts.push({ id: e.id, x: p.x, y: p.y });
      else e.dom.card.style.visibility = e.dom.line.style.visibility = 'hidden';
    }
    const cards = placeCards(pts, {
      w: cardW,
      h: cardH,
      area,
      prev: slots,
      avoid: avoid(),
    });
    for (let i = 0; i < cards.length; i += 1) {
      const c = cards[i];
      const e = shown.get(c.id);
      const p = pts[i];
      slots.set(c.id, c.slot);
      // (sx is NaN before the first placement: the test is written so NaN moves.)
      if (!(Math.abs(c.x - e.sx) <= 0.5 && Math.abs(c.y - e.sy) <= 0.5)) {
        e.sx = c.x;
        e.sy = c.y;
        e.dom.card.style.transform = `translate3d(${Math.round(c.x)}px, ${Math.round(c.y)}px, 0)`;
      }
      const ln = e.dom.line;
      ln.setAttribute('x1', c.lx.toFixed(1));
      ln.setAttribute('y1', c.ly.toFixed(1));
      ln.setAttribute('x2', p.x.toFixed(1));
      ln.setAttribute('y2', p.y.toFixed(1));
      e.dom.card.style.visibility = '';
      ln.style.visibility = '';
    }
  }

  const removePostRender = scene.postRender.addEventListener(() => {
    if (!enabled) return;
    const now = performance.now();
    if (now - lastPick >= PICK_MS) {
      lastPick = now;
      pick();
    }
    if (shown.size) place();
  });

  return {
    el,
    setEnabled(next) {
      enabled = Boolean(next);
      if (!enabled) hideAll();
      lastPick = 0;
      scene.requestRender();
    },
    setCount(n) {
      count = clampCount(n);
      lastPick = 0;
      scene.requestRender();
    },
    get enabled() {
      return enabled;
    },
    /** Ids shown now (for diagnostics and tests). */
    shown: () => [...shown.keys()],
    destroy() {
      removePostRender();
      clearInterval(tick);
      ro.disconnect();
      hideAll();
      for (const s of stills.values()) s.revoke?.();
      stills.clear();
      el.remove();
    },
  };
}
