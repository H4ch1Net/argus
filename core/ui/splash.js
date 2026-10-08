import './theme.css';
import { h } from './dom.js';
import { createLockup } from './hud/bar.js';

// Boot splash in the ctOS lock-screen idiom: the lockup in an accent frame,
// a thin progress bar with INITIALIZING and a count, and a terse boot log in
// textPrimaryDimmer. Reduced motion skips the animation and shows the final
// state. Removed once the globe and its controls are up.

export function createSplash() {
  const fill = h('i');
  const pct = h('span', {}, '000%');
  const log = h('div.ct-splash__log');
  const el = h(
    'div.ct-splash',
    { role: 'status', 'aria-live': 'polite' },
    h(
      'div.ct-splash__center',
      {},
      h('div.ct-accents', {}, createLockup({ size: 'splash' })),
      h('div.ct-splash__bar.ct-meter', {}, fill),
      h(
        'div.ct-splash__label',
        {},
        h('span', {}, 'INITIALIZING'),
        h('span.ct-splash__dots', {}, '...'),
        pct,
      ),
    ),
    log,
    h('div.ct-splash__disc', {}, 'Public data only. Nothing here acts on a target.'),
  );
  let value = 0;
  return {
    el,
    step(message, to) {
      value = Math.max(value, to);
      fill.style.width = `${value}%`;
      pct.textContent = `${String(Math.round(value)).padStart(3, '0')}%`;
      if (message) log.appendChild(h('div', {}, message));
    },
    done() {
      this.step('REGION_LINK_ESTABLISHED : ARGUS', 100);
      el.classList.add('is-out');
      setTimeout(() => el.remove(), 380);
    },
  };
}
