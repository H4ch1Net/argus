import { bootGlobe } from '../core/index.js';
import { locateAndFly } from '../core/geo/geolocate.js';
import { h } from '../core/ui/dom.js';
import { createBar } from '../core/ui/hud/bar.js';
import { createTabs } from '../core/ui/tabs.js';
import { createBottomSheet } from './bottomSheet.js';
import { createCompass } from './compass.js';
import '../core/ui/theme.css';
import '../core/ui/readout.css';
import './shell.css';

// Mobile shell (S25-tuned), ctOS layout: a compact bar at the top (lockup,
// search, feed state), the view stack at the right edge in thumb reach, and a
// bottom sheet with kitty tabs: LAYERS / TARGET / VIEW / INTEL. Selecting a
// contact opens the sheet to half on TARGET, so the card is visible with the
// map still in view. Sensors are shell inputs: this shell reads GPS and the
// compass and calls core's camera; core never imports sensor code.

/**
 * @param {HTMLElement} root
 */
export async function mountShell(root) {
  root.classList.add('argus-shell-mobile');

  const globeEl = h('div.argus-globe');
  const hud = h('div.argus-hud');
  root.append(globeEl, hud);

  const app = await bootGlobe(globeEl);

  const bar = createBar();
  const panes = {
    layers: h('div.argus-pane'),
    target: h('div.argus-pane'),
    view: h('div.argus-pane'),
    intel: h('div.argus-pane'),
  };
  const sheet = createBottomSheet({ peekHeight: 58 });
  const tabs = createTabs({
    tabs: [
      { id: 'layers', label: 'LAYERS', pane: panes.layers },
      { id: 'target', label: 'TARGET', pane: panes.target },
      { id: 'view', label: 'VIEW', pane: panes.view },
      { id: 'intel', label: 'INTEL', pane: panes.intel },
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
  function layout() {
    if (!overlay) return;
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

  return {
    ...app,
    shell: 'mobile',
    /** Place a component: bar | barEnd | layers | view | intel | target | stack | strip | stripEnd | notify | float */
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
    // "Around Me": fly to the device location at a regional altitude.
    aroundMe: (camera) => locateAndFly(camera, { altitude: 120_000 }),
    // GEO: zoom in closer to the user's position (city level).
    locate: (camera, report) =>
      locateAndFly(camera, { altitude: 12_000, onStatus: report }),
    // Point-at-sky mode: DeviceOrientation drives the camera. main provides the
    // camera controls plus how to identify and lock the aimed contact.
    enableCompass: (deps) => {
      const compass = createCompass(deps);
      panes.view.prepend(h('div.argus-compass-row', {}, compass.button));
      root.appendChild(compass.reticle);
      return compass;
    },
  };
}

export const shellName = 'mobile';
