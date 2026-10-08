import { bootGlobe } from '../core/index.js';
import { locateAndFly } from '../core/geo/geolocate.js';
import { h } from '../core/ui/dom.js';
import { createBar, createSegment } from '../core/ui/hud/bar.js';
import { createTabs } from '../core/ui/tabs.js';
import '../core/ui/theme.css';
import '../core/ui/readout.css';
import './shell.css';

// Desktop shell (Linux / Windows), ctOS layout: the bar across the top, a
// tabbed menu panel on the left (LAYERS / VIEW / INTEL), the target panel on the
// right (the tracking widget, the selected target's card, nearest contacts),
// the view stack at the right edge and a status strip along the bottom. Mouse
// and keyboard: M toggles the menu, T the target panel, / or Ctrl+K search,
// backtick the terminal, F follow, Esc release. One-shot geolocation only;
// the continuous orientation sensor stays mobile-only.

/**
 * @param {HTMLElement} root
 */
export async function mountShell(root) {
  root.classList.add('argus-shell-desktop');

  const globeEl = h('div.argus-globe');
  const hud = h('div.argus-hud');
  root.append(globeEl, hud);

  const app = await bootGlobe(globeEl);

  const bar = createBar();
  const panes = {
    layers: h('div.argus-pane.ct-scroll'),
    view: h('div.argus-pane.ct-scroll'),
    intel: h('div.argus-pane.ct-scroll'),
  };
  const tabs = createTabs({
    tabs: [
      { id: 'layers', label: 'LAYERS', pane: panes.layers },
      { id: 'view', label: 'VIEW', pane: panes.view },
      { id: 'intel', label: 'INTEL', pane: panes.intel },
    ],
  });
  const left = h(
    'aside.argus-left.ct-panel',
    { 'aria-label': 'Menu' },
    tabs.bar,
    tabs.panes,
  );
  const right = h('aside.argus-right.ct-panel.ct-scroll', { 'aria-label': 'Target' });
  const stack = h('div.argus-stack');
  const strip = createBar({ lockup: false, className: 'ct-bar--strip' });
  const notify = h('div.argus-notify');
  const floatEl = h('div.argus-float');
  hud.append(bar.el, left, right, stack, strip.el, notify, floatEl);

  // Panel toggles in the bar (and on the keyboard).
  const setPanel = (el, on) => {
    el.hidden = !on;
    layout();
  };
  const menuSeg = createSegment({
    label: 'MENU',
    value: 'M',
    title: 'Show or hide the menu (M)',
    onClick: () => setPanel(left, left.hidden),
  });
  bar.add(menuSeg, 'start');
  const tgtSeg = createSegment({
    label: 'TGT',
    value: 'T',
    title: 'Show or hide the target panel (T)',
    onClick: () => setPanel(right, right.hidden),
  });
  document.addEventListener('keydown', (e) => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'm' || e.key === 'M') setPanel(left, left.hidden);
    else if (e.key === 't' || e.key === 'T') setPanel(right, right.hidden);
  });

  // The tracking overlay draws inside the free area between the panels.
  let overlay = null;
  function layout() {
    if (!overlay) return;
    const r = root.getBoundingClientRect();
    const b = (el) => (el.hidden ? null : el.getBoundingClientRect());
    const lb = b(left);
    const rb = b(right);
    const sb = b(stack);
    const top = bar.el.getBoundingClientRect().bottom - r.top;
    const bottom = r.bottom - strip.el.getBoundingClientRect().top;
    overlay.setInsets({
      top,
      bottom,
      left: lb ? lb.right - r.left : 0,
      right: r.right - Math.min(rb ? rb.left : Infinity, sb ? sb.left : Infinity),
    });
  }
  const ro = new ResizeObserver(layout);
  for (const el of [root, bar.el, left, right, stack, strip.el]) ro.observe(el);

  return {
    ...app,
    shell: 'desktop',
    /** Place a component: bar | barEnd | layers | view | intel | target | stack | strip | stripEnd | notify | float */
    mount(slot, el) {
      if (!el) return;
      if (slot === 'bar') bar.add(el, 'start');
      else if (slot === 'barEnd') bar.add(el, 'end');
      else if (slot === 'strip') strip.add(el, 'start');
      else if (slot === 'stripEnd') strip.add(el, 'end');
      else if (slot === 'target') right.appendChild(el);
      else if (slot === 'stack') stack.appendChild(el);
      else if (slot === 'notify') notify.appendChild(el);
      else if (slot === 'float') floatEl.appendChild(el);
      else if (panes[slot]) panes[slot].appendChild(el);
      else root.appendChild(el);
      layout();
    },
    attachOverlay(o) {
      overlay = o;
      bar.add(tgtSeg, 'end');
      layout();
    },
    /** A target was selected or released: make sure its panel is visible. */
    focusTarget(on) {
      if (on && right.hidden) setPanel(right, true);
    },
    showTab: (id) => tabs.select(id),
    // "Around Me" preset fly-to (regional) and the GEO button (city level).
    aroundMe: (camera) => locateAndFly(camera, { altitude: 120_000 }),
    locate: (camera, report) =>
      locateAndFly(camera, { altitude: 12_000, onStatus: report }),
  };
}

export const shellName = 'desktop';
