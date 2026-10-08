// The phone's bottom sheet, ctOS-styled: a square panel on the translucent
// ground with a ctosGray top rule, snapping between three heights within
// thumb reach: peek (the tab row only), half, and full. Drag the grip or the
// tab row; a tap on the grip steps through the states. Selecting a target
// opens it to half so the card is visible without hiding the map.

const SNAP = { peek: 0, half: 0.5, full: 0.84 };

/**
 * @param {{ peekHeight?: number }} [opts] px visible when collapsed
 */
export function createBottomSheet({ peekHeight = 64 } = {}) {
  const el = document.createElement('div');
  el.className = 'argus-sheet';

  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'argus-sheet__handle';
  handle.setAttribute('aria-label', 'Resize panel');
  handle.innerHTML = '<span class="argus-sheet__grip"></span>';

  const head = document.createElement('div');
  head.className = 'argus-sheet__head';
  const content = document.createElement('div');
  content.className = 'argus-sheet__content ct-scroll';

  el.append(handle, head, content);

  let state = 'peek';
  let current = 0;
  let drag = null;
  const listeners = new Set();

  const fullHeight = () => Math.round(window.innerHeight * SNAP.full);
  const heightOf = (s) =>
    s === 'peek' ? peekHeight : Math.round(window.innerHeight * SNAP[s]);

  function apply(px) {
    const full = fullHeight();
    current = Math.min(full, Math.max(peekHeight, px));
    el.style.height = `${full}px`;
    el.style.transform = `translateY(${full - current}px)`;
    el.dataset.state = state;
  }

  function snap(next) {
    state = next;
    el.classList.add('is-animating');
    apply(heightOf(next));
    listeners.forEach((fn) => fn(state, current));
  }

  const start = (e) => {
    drag = {
      y: e.clientY,
      h: current,
      moved: false,
      id: e.pointerId,
      target: e.currentTarget,
    };
    el.classList.remove('is-animating');
  };
  const move = (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dy) < 6) return;
    if (!drag.moved) {
      drag.moved = true;
      try {
        drag.target.setPointerCapture(drag.id);
      } catch {
        // capture is best effort (the pointer may already be gone)
      }
    }
    apply(drag.h - dy);
  };
  const end = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.moved) {
      if (d.target === handle)
        snap(state === 'peek' ? 'half' : state === 'half' ? 'full' : 'peek');
      return;
    }
    // Snap to the nearest state, biased by the drag direction.
    const dy = e.clientY - d.y;
    const order = ['peek', 'half', 'full'];
    let best = order.reduce((a, b) =>
      Math.abs(heightOf(b) - current) < Math.abs(heightOf(a) - current) ? b : a,
    );
    if (best === state && Math.abs(dy) > 40) {
      const i = order.indexOf(state) + (dy < 0 ? 1 : -1);
      best = order[Math.max(0, Math.min(2, i))];
    }
    snap(best);
  };
  for (const t of [handle, head]) {
    t.addEventListener('pointerdown', start);
    t.addEventListener('pointermove', move);
    t.addEventListener('pointerup', end);
    t.addEventListener('pointercancel', end);
  }
  window.addEventListener('resize', () => apply(heightOf(state)));

  requestAnimationFrame(() => snap('peek'));

  return {
    el,
    head,
    content,
    snap,
    open: () => snap('half'),
    expand: () => snap('full'),
    collapse: () => snap('peek'),
    isOpen: () => state !== 'peek',
    state: () => state,
    /** fn(state, visibleHeightPx) after each snap. */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
