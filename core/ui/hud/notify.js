import './notify.css';
import { h } from '../dom.js';
import { isFailureNotice } from '../logs.js';

// mako-style notifications (design/ctos Notification): top-right, 360px, the
// translucent panel, a 1px border, square corners. Normal ctosGray, low
// backgroundBright, critical error with no timeout. One-line titles; the body
// says what happened in plain words. A repeated key replaces its previous
// notice instead of stacking.
//
// Failures (a feed, the proxy, a stream or a still that could not be reached)
// are not popped up at all when a `log` is given: they go to the LOGS store
// (core/ui/logs.js isFailureNotice), so a flaky network never fills the screen.
// Critical notices (no proxy at all, the GPU dropping the globe) always show.

const TIMEOUT_MS = 6000;
const MAX_VISIBLE = 4;

/**
 * @param {{ log?: (entry: { level: string, source: string, title: string,
 *   body?: string }) => void }} [opts]
 */
export function createNotifier({ log = null } = {}) {
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
   *   key?: string, timeoutMs?: number, action?: { label: string, onClick: Function },
   *   kind?: 'failure'|'notice' }} n  kind forces the log ('failure') or a
   *   popup ('notice'); without it the notice is judged by its words.
   */
  function push(n = {}) {
    const { title, body = '', level = 'normal', key, timeoutMs, action } = n;
    if (log && isFailureNotice(n)) {
      log({ level: 'warn', source: key ? String(key) : 'app', title, body });
      return () => {};
    }
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
    // Past the limit, the oldest cards go now (not after the fade-out, or the
    // count would never drop inside this loop).
    const live = [...el.children].filter((c) => !c.classList.contains('is-out'));
    for (const c of live.slice(MAX_VISIBLE)) {
      dismiss(c);
      c.remove();
    }
    const ms = timeoutMs ?? (level === 'critical' ? 0 : TIMEOUT_MS);
    if (ms > 0) setTimeout(() => dismiss(card), ms);
    return () => dismiss(card);
  }

  return { el, push, clear: (key) => byKey.has(key) && dismiss(byKey.get(key)) };
}
