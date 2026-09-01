// A draggable bottom sheet with two snap points (peek / open), master plan 6.7.
// Drag or tap the handle to move between snaps. Built on Pointer Events (the repo
// standard); pointer capture keeps the drag going if the finger leaves the handle.

/**
 * @param {{ peekHeight?: number }} [opts] peekHeight = px visible when collapsed
 */
export function createBottomSheet({ peekHeight = 112 } = {}) {
  const el = document.createElement('div');
  el.className = 'argus-sheet';

  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'argus-sheet__handle';
  handle.setAttribute('aria-label', 'Toggle panel');
  handle.innerHTML = '<span class="argus-sheet__grip"></span>';

  const content = document.createElement('div');
  content.className = 'argus-sheet__content';

  el.append(handle, content);

  let open = true;
  let currentTranslate = 0;
  let dragging = false;
  let startY = 0;
  let startTranslate = 0;

  const maxTranslate = () => Math.max(0, el.offsetHeight - peekHeight);

  function setTranslate(y) {
    currentTranslate = Math.min(maxTranslate(), Math.max(0, y));
    el.style.transform = `translateY(${currentTranslate}px)`;
  }

  function snap(toOpen) {
    open = toOpen;
    el.classList.add('is-animating');
    el.classList.toggle('is-open', toOpen);
    setTranslate(toOpen ? 0 : maxTranslate());
  }

  handle.addEventListener('pointerdown', (e) => {
    dragging = true;
    startY = e.clientY;
    startTranslate = currentTranslate;
    el.classList.remove('is-animating');
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (dragging) setTranslate(startTranslate + (e.clientY - startY));
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    const moved = Math.abs(e.clientY - startY);
    // A tap (barely moved) toggles; a drag snaps to the nearer point.
    if (moved < 6) snap(!open);
    else snap(currentTranslate < maxTranslate() / 2);
    try {
      handle.releasePointerCapture(e.pointerId);
    } catch {
      // pointer already released
    }
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);

  // Settle into the open position once laid out (offsetHeight is known then).
  requestAnimationFrame(() => snap(true));

  return {
    el,
    content,
    open: () => snap(true),
    collapse: () => snap(false),
    isOpen: () => open,
  };
}
