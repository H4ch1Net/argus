import './shortcuts.css';
import { h } from './dom.js';
import { SHORTCUTS } from './keymap.js';

export { SHORTCUTS, actionForKey, bindShortcuts } from './keymap.js';

/** The "?" overlay: every shortcut in two columns, ctOS styled. */
export function createShortcutHelp({ desktop = true } = {}) {
  const list = h('dl.ct-keys__list');
  for (const s of SHORTCUTS) {
    if (s.desktop && !desktop) continue;
    list.append(
      h(
        'dt',
        {},
        ...s.keys.map((k) => (k === '…' ? h('span.ct-muted', {}, '…') : h('kbd', {}, k))),
      ),
      h('dd', {}, s.label.toUpperCase()),
    );
  }
  const closeBtn = h(
    'button.ct-btn',
    { type: 'button', onclick: () => close(), title: 'Close (Esc)' },
    'ESC',
  );
  const panel = h(
    'div.ct-keys.ct-panel',
    { role: 'dialog', 'aria-label': 'Keyboard shortcuts' },
    h('div.ct-keys__head', {}, h('span.ct-sq'), 'KEYBOARD', closeBtn),
    list,
  );
  const el = h(
    'div.ct-keys__backdrop',
    { hidden: true, onclick: (e) => e.target === el && close() },
    panel,
  );
  const onKey = (e) => {
    if (e.key === 'Escape' || e.key === '?') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  function open() {
    el.hidden = false;
    document.addEventListener('keydown', onKey, true);
    closeBtn.focus();
  }
  function close() {
    el.hidden = true;
    document.removeEventListener('keydown', onKey, true);
  }
  return { el, open, close, toggle: () => (el.hidden ? open() : close()) };
}
