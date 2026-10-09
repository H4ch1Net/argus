import { bootGlobe } from '../core/index.js';
import { createGeoControl, flyToSelf } from '../core/geo/geoControl.js';
import { locateAndFly } from '../core/geo/geolocate.js';
import { h } from '../core/ui/dom.js';
import { createBar } from '../core/ui/hud/bar.js';
import { createTabs } from '../core/ui/tabs.js';
import { createBottomSheet } from './bottomSheet.js';
import { createCompass } from './compass.js';
import { attachSelfCompass } from './selfCompass.js';
import '../core/ui/theme.css';
import '../core/ui/readout.css';
import './shell.css';

// Mobile shell (S25-tuned), ctOS layout: a compact bar at the top (lockup,
// search, feed state), the view stack at the right edge in thumb reach, and a
// bottom sheet with kitty tabs: LAYERS / TARGET / VIEW / TOOLS. Selecting a
// contact opens the sheet to half on TARGET, so the card is visible with the
// map still in view. Sensors are shell inputs: this shell reads GPS and the
// compass and calls core's camera; core never imports sensor code. The own
// position (main sets api.selfPosition, core/geo/selfPosition.js) drives GEO,
// Around Me and the pass observer; the compass turns its marker when still.

/**
 * @param {HTMLElement} root
 */
export async function mountShell(root, bootOpts = {}) {
  root.classList.add('argus-shell-mobile');

  const globeEl = h('div.argus-globe');
  const hud = h('div.argus-hud');
  root.append(globeEl, hud);

  const app = await bootGlobe(globeEl, bootOpts);

  const bar = createBar();
  const panes = {
    layers: h('div.argus-pane'),
    target: h('div.argus-pane'),
    view: h('div.argus-pane'),
    intel: h('div.argus-pane'),
    setup: h('div.argus-pane'),
  };
  const sheet = createBottomSheet({ peekHeight: 58 });
  const tabs = createTabs({
    tabs: [
      { id: 'layers', label: 'LAYERS', pane: panes.layers },
      { id: 'target', label: 'TARGET', pane: panes.target },
      { id: 'view', label: 'VIEW', pane: panes.view },
      { id: 'intel', label: 'TOOLS', pane: panes.intel },
      { id: 'setup', label: 'SETUP', pane: panes.setup },
    ],
    // Tapping a tab while the sheet is down opens it.
    onChange: () => {
      if (!sheet.isOpen()) sheet.open();
      sheet.content.scrollTop = 0;
    },
  });
  sheet.head.appendChild(tabs.bar);
  sheet.content.appendChild(tabs.panes);

  const stack = h('div.argus-stack');
  const notify = h('div.argus-notify');
  const floatEl = h('div.argus-float');
  hud.append(bar.el, stack, notify, floatEl, sheet.el);

  let overlay = null;
  let clean = false;
  function layout() {
    if (!overlay) return;
    if (clean) return overlay.setInsets({ top: 0, bottom: 0, left: 0, right: 0 });
    const r = root.getBoundingClientRect();
    const sb = sheet.el.getBoundingClientRect();
    const st = stack.getBoundingClientRect();
    overlay.setInsets({
      top: bar.el.getBoundingClientRect().bottom - r.top,
      bottom: Math.max(0, r.bottom - sb.top),
      left: 0,
      right: r.right - st.left,
    });
  }
  sheet.subscribe(() => setTimeout(layout, 300));
  const ro = new ResizeObserver(layout);
  for (const el of [root, bar.el, stack]) ro.observe(el);

  const api = {
    ...app,
    shell: 'mobile',
    /** Place a component: bar | barEnd | layers | view | intel | setup | target | stack | strip | stripEnd | notify | float */
    mount(slot, el) {
      if (!el) return;
      if (slot === 'bar') bar.add(el, 'start');
      else if (slot === 'barEnd') bar.add(el, 'end');
      else if (slot === 'strip' || slot === 'stripEnd') panes.intel.prepend(el);
      else if (slot === 'stack') stack.appendChild(el);
      else if (slot === 'notify') notify.appendChild(el);
      else if (slot === 'float') floatEl.appendChild(el);
      else if (panes[slot]) panes[slot].appendChild(el);
      else root.appendChild(el);
      layout();
    },
    attachOverlay(o) {
      overlay = o;
      layout();
    },
    /** A target was selected: show its card at half height. */
    focusTarget(on) {
      if (on) {
        tabs.select('target');
        if (sheet.state() === 'peek') sheet.open();
      }
    },
    showTab: (id) => tabs.select(id),
    /** Clean view: hide the interface, leaving the globe and the overlay. */
    setClean(on) {
      clean = Boolean(on);
      root.classList.toggle('argus-clean', clean);
      layout();
    },
    // "Around Me": fly to the device location at a regional altitude.
    aroundMe: (camera) =>
      api.selfPosition
        ? flyToSelf(api.selfPosition, camera, { altitude: 120_000 })
        : locateAndFly(camera, { altitude: 120_000 }),
    // The observer for satellite pass predictions: the phone's own position.
    observer: async () => {
      const fix = await api.selfPosition?.locate({ timeoutMs: 8000 });
      return fix ? { latitude: fix.lat, longitude: fix.lon } : null;
    },
    // GEO: centre on the user (street level), a second tap follows. The
    // compass feeds the marker's heading while the position is in use.
    geo: (camera, opts = {}) => {
      if (!api.selfPosition) return null;
      attachSelfCompass(api.selfPosition);
      return createGeoControl({ selfPosition: api.selfPosition, camera, ...opts });
    },
    // Point-at-sky mode: DeviceOrientation drives the camera. main provides the
    // camera controls plus how to identify and lock the aimed contact.
    enableCompass: (deps) => {
      const compass = createCompass(deps);
      panes.view.prepend(h('div.argus-compass-row', {}, compass.button));
      root.appendChild(compass.reticle);
      return compass;
    },
  };
  return api;
}

export const shellName = 'mobile';
