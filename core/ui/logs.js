// LOGS: where feed, network and layer failures go instead of popups. A small
// in-memory ring (nothing persisted): a repeat of the same source and title
// folds into one entry with a count and its latest time, so a feed failing
// every poll is one line, not hundreds. The store is pure (the terminal and
// tests use it); the panel below renders it only while it is open, at most
// a few times a second.

import { h } from './dom.js';

export const LOG_LEVELS = Object.freeze(['info', 'warn', 'error']);

const clip = (v, n) =>
  String(v ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);

/**
 * @param {{ capacity?: number, now?: () => number }} [opts]
 */
export function createLogStore({ capacity = 300, now = () => Date.now() } = {}) {
  const byKey = new Map(); // source + title -> entry; insertion order = recency
  const listeners = new Set();
  let ids = 0;
  let seq = 0;
  let queued = false;

  // Listeners hear once per burst (a microtask), however many adds it held.
  const emit = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      for (const fn of listeners) {
        try {
          fn();
        } catch {
          // a broken listener must not stop the others
        }
      }
    });
  };

  return {
    /**
     * @param {{ level?: 'info'|'warn'|'error', source?: string, title: string,
     *   body?: string, t?: number }} entry
     * @returns {object} the stored entry (a copy)
     */
    add({ level = 'info', source = '', title, body = '', t } = {}) {
      const lv = LOG_LEVELS.includes(level) ? level : 'info';
      const src = clip(source, 40);
      const ttl = clip(title, 160) || 'UNTITLED';
      const at = Number.isFinite(t) ? t : now();
      const key = `${src}\u0000${ttl}`;
      let e = byKey.get(key);
      if (e) {
        byKey.delete(key); // re-insert: it becomes the newest
        e.count += 1;
        e.t = Math.max(e.t, at);
        e.level = lv;
        if (body) e.body = clip(body, 600);
      } else {
        ids += 1;
        e = { id: ids, level: lv, source: src, title: ttl, body: clip(body, 600) };
        Object.assign(e, { first: at, t: at, count: 1 });
      }
      byKey.set(key, e);
      while (byKey.size > capacity) byKey.delete(byKey.keys().next().value);
      seq += 1;
      emit();
      return { ...e };
    },

    /** Entries, newest first (copies). `level` keeps that level only. */
    list({ level } = {}) {
      const out = [];
      for (const e of byKey.values()) if (!level || e.level === level) out.push({ ...e });
      return out.reverse();
    },

    clear() {
      byKey.clear();
      seq += 1;
      emit();
    },

    /** fn() after changes (batched); returns unsubscribe. */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** { info, warn, error, total }; `since` counts entries seen after it only. */
    counts({ since = -Infinity } = {}) {
      const c = { info: 0, warn: 0, error: 0, total: 0 };
      for (const e of byKey.values()) {
        if (e.t <= since) continue;
        c[e.level] += 1;
        c.total += 1;
      }
      return c;
    },

    /** Bumps on every change (cheap "anything new?" checks). */
    get seq() {
      return seq;
    },

    get size() {
      return byKey.size;
    },

    /** Every entry as plain text, oldest first, for COPY ALL. */
    toText() {
      return [...byKey.values()].map(formatLine).join('\n');
    },
  };
}

const LEVEL_TAG = { info: 'INFO', warn: 'WARN', error: 'ERR ' };

/** "2026-10-09 06:00:12Z WARN [chp] CHP INCIDENTS STALE (x3): body". */
export function formatLine(e) {
  const time = new Date(e.t).toISOString().slice(0, 19).replace('T', ' ');
  const count = e.count > 1 ? ` (x${e.count})` : '';
  const src = e.source ? ` [${e.source}]` : '';
  return `${time}Z ${LEVEL_TAG[e.level] ?? 'INFO'}${src} ${e.title}${count}${e.body ? `: ${e.body}` : ''}`;
}

// A notice about something that could not be reached or loaded (a feed, the
// proxy, a stream, a still): those belong in the log, not a popup. Prompts and
// results of the user's own actions ("SELECT A CONTACT FIRST", "LINK COPIED")
// are not matched and stay notices.
const FAILURE_TITLE =
  /\b(FAILED|FAILURE|ERROR|UNREACHABLE|OFFLINE|TIMED OUT|TIMEOUT|NOT SAVED|NO STILL|STALE)\b/i;
const FAILURE_BODY =
  /responded \d{3}|upstream|did not answer|not answering|timed out|timeout|failed to fetch|fetch failed|network ?error|unreachable|not reachable|\bHTTP \d{3}\b|ECONN\w*|ENOTFOUND|EAI_AGAIN|needs the live proxy/i;

/** True when a notifier notice is a failure that should go to the log. */
export function isFailureNotice(n) {
  if (!n || n.level === 'critical') return false;
  if (n.kind === 'failure') return true;
  if (n.kind) return false;
  return (
    FAILURE_TITLE.test(String(n.title ?? '')) || FAILURE_BODY.test(String(n.body ?? ''))
  );
}

/** Copy text: the clipboard API, else a selected textarea (older WebViews). */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // denied or not allowed here: fall back
  }
  const ta = h('textarea', {
    readonly: true,
    style: { position: 'fixed', opacity: '0' },
  });
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

const FILTERS = [
  { id: 'all', label: 'ALL' },
  { id: 'error', label: 'ERR' },
  { id: 'warn', label: 'WARN' },
  { id: 'info', label: 'INFO' },
];
const ROWS_MAX = 150;
const RENDER_MS = 250;
const BADGE_MS = 1000;

/**
 * The LOGS section: collapsed by default, a count badge of warnings and errors
 * not yet seen, filter by level, CLEAR, COPY ALL. Nothing is built while it is
 * closed; while open it re-renders at most every RENDER_MS.
 * @param {ReturnType<typeof createLogStore>} store
 */
export function createLogsPanel(store, { open: startOpen = false } = {}) {
  let open = false;
  let filter = 'all';
  let seenAt = Date.now();
  let renderTimer = null;
  let badgeTimer = null;

  const badge = h('span.ct-tag.ct-logs__badge', { hidden: true });
  const caret = h('span.ct-logs__caret', {}, '[+]');
  const head = h(
    'button.ct-head.ct-logs__head',
    { type: 'button', 'aria-expanded': 'false', onclick: () => setOpen(!open) },
    h('span', {}, 'LOGS'),
    badge,
    caret,
  );
  const list = h('div.ct-logs__list.ct-scroll', { role: 'log', 'aria-live': 'off' });
  const status = h('div.ct-section__note');
  const filterBtns = new Map();
  const filters = h(
    'div.ct-seg',
    { role: 'group', 'aria-label': 'Log level' },
    FILTERS.map((f) => {
      const b = h(
        'button.ct-btn',
        {
          type: 'button',
          'aria-pressed': String(f.id === filter),
          onclick: () => {
            filter = f.id;
            for (const [id, x] of filterBtns)
              x.setAttribute('aria-pressed', String(id === filter));
            render();
          },
        },
        f.label,
      );
      filterBtns.set(f.id, b);
      return b;
    }),
  );
  const copyBtn = h(
    'button.ct-btn',
    {
      type: 'button',
      onclick: async () => {
        const ok = await copyText(store.toText() || '(no log entries)');
        status.textContent = ok ? 'Copied to the clipboard.' : 'Copy is blocked here.';
      },
    },
    'COPY ALL',
  );
  const clearBtn = h(
    'button.ct-btn',
    {
      type: 'button',
      onclick: () => {
        store.clear();
        status.textContent = '';
      },
    },
    'CLEAR',
  );
  const body = h(
    'div.ct-section__body.ct-logs__body',
    { hidden: true },
    filters,
    list,
    h('div.ct-seg', {}, clearBtn, copyBtn),
    status,
    h(
      'div.ct-section__note',
      {},
      'Feeds that fail or answer late land here instead of popups. Kept in memory on this device only (the last 300).',
    ),
  );
  const el = h('section.ct-section.ct-logs', {}, head, body);

  // Titles name their subject already ("CHP INCIDENTS STALE"); the source key
  // is in the title attribute and in COPY ALL.
  function row(e) {
    const time = new Date(e.t).toISOString().slice(11, 19);
    return h(
      'div.ct-logs__row',
      { dataset: { level: e.level }, title: e.source || '' },
      h('span.ct-logs__time', {}, time),
      h('span.ct-logs__lvl', {}, LEVEL_TAG[e.level].trim()),
      h(
        'span.ct-logs__title',
        {},
        e.title,
        e.count > 1 ? h('b.ct-logs__count', {}, ` x${e.count}`) : null,
      ),
      e.body ? h('span.ct-logs__text', {}, e.body) : null,
    );
  }

  function render() {
    clearTimeout(renderTimer);
    renderTimer = null;
    if (!open) return;
    const entries = store.list(filter === 'all' ? {} : { level: filter });
    const frag = document.createDocumentFragment();
    for (const e of entries.slice(0, ROWS_MAX)) frag.appendChild(row(e));
    if (!entries.length)
      frag.appendChild(h('div.ct-section__note', {}, 'Nothing logged.'));
    else if (entries.length > ROWS_MAX)
      frag.appendChild(
        h(
          'div.ct-section__note',
          {},
          `${entries.length - ROWS_MAX} older not shown (COPY ALL has them).`,
        ),
      );
    list.replaceChildren(frag);
    seenAt = Date.now();
    paintBadge();
  }

  function paintBadge() {
    clearTimeout(badgeTimer);
    badgeTimer = null;
    const c = store.counts({ since: open ? Infinity : seenAt });
    const n = c.warn + c.error;
    badge.hidden = n === 0;
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.classList.toggle('ct-tag--err', c.error > 0);
  }

  store.subscribe(() => {
    if (open) {
      renderTimer ??= setTimeout(render, RENDER_MS);
    } else {
      badgeTimer ??= setTimeout(paintBadge, BADGE_MS);
    }
  });

  function setOpen(v) {
    open = Boolean(v);
    head.setAttribute('aria-expanded', String(open));
    caret.textContent = open ? '[-]' : '[+]';
    body.hidden = !open;
    if (open) render();
    else {
      list.replaceChildren(); // nothing kept in the DOM while closed
      seenAt = Date.now();
      paintBadge();
    }
  }

  if (startOpen) setOpen(true);
  else paintBadge();
  return { el, setOpen, isOpen: () => open };
}
