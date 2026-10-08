import './notify.css';
import { h } from '../dom.js';

// mako-style notifications (design/ctos Notification): top-right, 360px, the
// translucent panel, a 1px border, square corners. Normal ctosGray, low
// backgroundBright, critical error with no timeout. One-line titles; the body
// says what happened in plain words. A repeated key replaces its previous
// notice instead of stacking (a layer that keeps failing shows one card).

const TIMEOUT_MS = 6000;
const MAX_VISIBLE = 4;

export function createNotifier() {
  const el = h('div.ct-notify', { role: 'status', 'aria-live': 'polite' });
  const byKey = new Map();

  function dismiss(card) {
    if (!card.isConnected) return;
    card.classList.add('is-out');
    setTimeout(() => card.remove(), 120);
    for (const [k, c] of byKey) if (c === card) byKey.delete(k);
  }

  /**
   * @param {{ title: string, body?: string, level?: 'low'|'normal'|'critical',
   *   key?: string, timeoutMs?: number, action?: { label: string, onClick: Function } }} n
   */
  function push({ title, body = '', level = 'normal', key, timeoutMs, action } = {}) {
    if (key && byKey.has(key)) dismiss(byKey.get(key));
    const card = h(
      `div.ct-note.ct-note--${level}`,
      { onclick: (e) => e.target.closest('button') || dismiss(card) },
      h('div.ct-note__title', {}, title),
      body ? h('div.ct-note__body', {}, body) : null,
      action
        ? h(
            'button.ct-btn.ct-note__action',
            {
              type: 'button',
              onclick: () => {
                action.onClick();
                dismiss(card);
              },
            },
            action.label,
          )
        : null,
    );
    el.prepend(card);
    if (key) byKey.set(key, card);
    while (el.children.length > MAX_VISIBLE) dismiss(el.lastElementChild);
    const ms = timeoutMs ?? (level === 'critical' ? 0 : TIMEOUT_MS);
    if (ms > 0) setTimeout(() => dismiss(card), ms);
    return () => dismiss(card);
  }

  return { el, push, clear: (key) => byKey.has(key) && dismiss(byKey.get(key)) };
}
