import './targetPanel.css';
import { formatDistance } from '../settings/store.js';
import { formatTcpa } from '../geo/cpa.js';
import { h, id2 } from './dom.js';
import { createTrackWidget } from './trackWidget.js';
import { layerTile } from './layerGlyphs.js';

// The target panel: what a click on the map opens. On top, the tracking widget
// (Bagley's node graph, live); then the target's name, class and source, its
// fields as ctOS label/value rows, a camera still where there is one, source
// links, and actions (FOLLOW, COCKPIT, FLY TO, ...). Underneath, CONTACTS: the
// nearest contacts with the same two-digit IDs the map shows, each one tap to
// select. With nothing selected it reads SCAN: the widget and the contacts
// nearest the middle of the view.

const fmtDistMetric = (m) =>
  m >= 100_000
    ? `${Math.round(m / 1000)}KM`
    : m >= 1000
      ? `${(m / 1000).toFixed(1)}KM`
      : `${Math.round(m)}M`;
const fmtBrg = (d) =>
  d == null ? '' : `${String(Math.round(d) % 360).padStart(3, '0')}°`;

/**
 * @param {{ onClose?: () => void, onPickContact?: (c: object) => void }} opts
 */
export function createTargetPanel({
  onClose,
  onPickContact,
  onHoverContact,
  prefs = null,
} = {}) {
  // Contact distances in the units the settings ask for.
  const fmtDist = (m) => {
    if (m == null) return '';
    const units = prefs?.get('units') ?? 'metric';
    return units === 'metric'
      ? fmtDistMetric(m)
      : formatDistance(m, units).replace(' ', '');
  };
  const widget = createTrackWidget({
    onHover: (c) => onHoverContact?.(c),
    onPick: (c) => onPickContact?.(c),
  });
  const stateEl = h('span.ct-target__state', {}, 'SCAN');
  const closeBtn = h(
    'button.ct-target__close.ct-btn',
    {
      type: 'button',
      title: 'Release target (Esc)',
      'aria-label': 'Release target',
      onclick: () => onClose?.(),
    },
    'ESC',
  );
  const titleEl = h('div.ct-target__title');
  const subEl = h('div.ct-target__sub');
  const tagsEl = h('div.ct-target__tags');
  const imageEl = h('img.ct-target__image', {
    alt: '',
    referrerpolicy: 'no-referrer',
    hidden: true,
  });
  imageEl.addEventListener('error', () => (imageEl.hidden = true));
  const rowsEl = h('dl.ct-kv.ct-target__rows');
  const linksEl = h('div.ct-target__links');
  const actionsEl = h('div.ct-seg.ct-target__actions');
  const hintEl = h(
    'div.ct-target__hint',
    {},
    'TAP A CONTACT ON THE MAP, OR PICK ONE BELOW',
  );
  const card = h(
    'div.ct-target__card',
    { hidden: true },
    titleEl,
    subEl,
    tagsEl,
    imageEl,
    rowsEl,
    linksEl,
    actionsEl,
  );
  const contactsCount = h('span.ct-head__val');
  const contactsEl = h('div.ct-target__contacts');
  // PREV / NEXT: walk the contacts one by one (N / P on a keyboard).
  let stepper = null;
  const stepEl = h(
    'span.ct-target__step',
    { hidden: true },
    h(
      'button.ct-btn',
      { type: 'button', title: 'Previous contact (P)', onclick: () => stepper?.(-1) },
      '◀',
    ),
    h(
      'button.ct-btn',
      { type: 'button', title: 'Next contact (N)', onclick: () => stepper?.(1) },
      '▶',
    ),
  );

  const el = h(
    'section.ct-target',
    { 'aria-label': 'Target' },
    h(
      'header.ct-target__head',
      {},
      h('span.ct-sq'),
      stateEl,
      h('span.ct-target__spacer'),
      closeBtn,
    ),
    h('div.ct-target__widget', {}, widget.el),
    hintEl,
    card,
    h('div.ct-head', {}, 'CONTACTS', contactsCount, stepEl),
    contactsEl,
  );

  let selected = false;
  let actionsSig = '';
  let currentActions = [];
  let blobUrl = null;
  let lastContactsKey = '';

  // The card refreshes every second: an image is (re)loaded only when its
  // source changes. A still that arrives as JSON wrapping a base64 JPEG (format
  // 'json-base64-jpeg', TxDOT) is fetched, decoded and shown via a Blob URL.
  let imageKey = null;
  let imageAbort = null;
  function showBlob(blob, alt) {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = URL.createObjectURL(blob);
    imageEl.src = blobUrl;
    imageEl.alt = alt || '';
    imageEl.hidden = false;
  }
  function setImage(img) {
    const url = /^https?:\/\//i.test(img?.url || '') ? img.url : null;
    const key = img?.blob ?? (url ? `${img.format ?? ''}|${url}` : null);
    if (key === imageKey) return;
    imageKey = key;
    imageAbort?.abort();
    imageAbort = null;
    if (img?.blob) return showBlob(img.blob, img.alt);
    if (!url) {
      imageEl.hidden = true;
      imageEl.removeAttribute('src');
      return;
    }
    if (img.format === 'json-base64-jpeg') {
      imageEl.hidden = true;
      const ac = (imageAbort = new AbortController());
      Promise.all([
        fetch(url, { signal: ac.signal }).then((r) => (r.ok ? r.json() : null)),
        import('../layers/trafficcams/format.js'),
      ])
        .then(([json, fmt]) => {
          const bytes = json && fmt.jpegFromSnapshotJson(json, img.field);
          if (ac.signal.aborted || !bytes) return;
          showBlob(new Blob([bytes], { type: 'image/jpeg' }), img.alt);
        })
        .catch(() => {});
      return;
    }
    imageEl.alt = img.alt || '';
    imageEl.src = url;
    imageEl.hidden = false;
  }

  return {
    el,
    widget,
    get isTarget() {
      return selected;
    },
    /**
     * @param {{ title: string, subtitle?: string, rows?: [string, string][],
     *   sections?: { title: string, rows: [string, string][] }[], image?: object,
     *   links?: { label: string, url: string }[], tags?: { text: string, kind?: string }[] }} model
     * @param {{ label: string, onClick: Function, pressed?: boolean, title?: string }[]} [actions]
     */
    showTarget(model, actions = []) {
      selected = true;
      el.classList.add('is-target');
      card.hidden = false;
      hintEl.hidden = true;
      closeBtn.hidden = false;
      titleEl.textContent = model.title ?? '';
      subEl.textContent = model.subtitle ?? '';
      subEl.hidden = !model.subtitle;
      tagsEl.innerHTML = '';
      for (const t of model.tags || [])
        tagsEl.appendChild(
          h(`span.ct-tag${t.kind ? `.ct-tag--${t.kind}` : ''}`, {}, t.text),
        );
      tagsEl.hidden = !(model.tags || []).length;
      rowsEl.innerHTML = '';
      const addRows = (rows) => {
        for (const [k, v] of rows || [])
          rowsEl.append(h('dt', { title: k }, k), h('dd', {}, v ?? '—'));
      };
      addRows(model.rows);
      for (const s of model.sections || []) {
        rowsEl.append(h('dt.ct-kv__section', {}, s.title), h('dd.ct-kv__section'));
        addRows(s.rows);
      }
      setImage(model.image);
      const links = (model.links || []).filter((x) => /^https?:\/\//i.test(x?.url || ''));
      const linkSig = links.map((l) => l.url).join('|');
      if (linkSig !== linksEl.dataset.sig) linksEl.innerHTML = '';
      linksEl.dataset.sig = linkSig;
      for (const l of linksEl.children.length ? [] : links) {
        linksEl.appendChild(
          h(
            'a.ct-btn.ct-target__link',
            { href: l.url, target: '_blank', rel: 'noopener noreferrer' },
            `${l.label} ↗`,
          ),
        );
      }
      linksEl.hidden = !linksEl.children.length;
      // Rebuild the buttons only when they change: the card refreshes every
      // second, and replacing a button mid-press would swallow the click.
      currentActions = actions;
      const sig = actions.map((a) => `${a.label}:${a.pressed}`).join('|');
      if (sig === actionsSig) return;
      actionsSig = sig;
      actionsEl.innerHTML = '';
      for (const [i, a] of actions.entries()) {
        actionsEl.appendChild(
          h(
            `button.ct-btn${a.ok ? '.ct-btn--ok' : ''}`,
            {
              type: 'button',
              title: a.title || a.label,
              'aria-pressed': a.pressed === undefined ? false : String(a.pressed),
              // The latest actions, not the ones the button was built with:
              // two targets can share labels, and a kept button must act on
              // the current one.
              onclick: (e) => currentActions[i]?.onClick?.(e),
            },
            a.label,
          ),
        );
      }
      actionsEl.hidden = !actions.length;
    },
    clearTarget() {
      selected = false;
      actionsSig = '';
      el.classList.remove('is-target');
      card.hidden = true;
      hintEl.hidden = false;
      closeBtn.hidden = true;
      setImage(null);
    },
    /** fn(+1 | -1): what PREV / NEXT on the contacts header do. */
    setStepper(fn) {
      stepper = fn;
      stepEl.hidden = !fn;
    },
    /** The overlay summary: drives the widget, the state and the contacts. */
    setSummary(s, { quality = 0, hubPos } = {}) {
      stateEl.textContent = s.state;
      el.dataset.state = s.state;
      widget.update({
        state: s.state,
        quality,
        total: s.total,
        layers: s.layers,
        contacts: s.contacts,
        hubPos: hubPos ?? [0.5, 0.5],
      });
      const list = s.contacts.slice(0, 10);
      const key = list
        .map(
          (c) =>
            `${c.id}:${c.label}:${Math.round((c.distanceM ?? 0) / 100)}:${c.conflict ? 1 : 0}:${Math.round((c.tcpaS ?? 0) / 5)}`,
        )
        .join('|');
      if (key === lastContactsKey) return;
      lastContactsKey = key;
      contactsCount.textContent = String(list.length).padStart(2, '0');
      contactsEl.innerHTML = '';
      for (const c of list) {
        // A closing contact shows its closest approach (distance and time);
        // one on a conflicting pass is marked (core/geo/cpa.js limits).
        // (Within ten minutes and 20 km: a pass an hour or a country away is
        // noise, not information.)
        const cpa =
          c.cpaM != null && (c.conflict || (c.tcpaS < 600 && c.cpaM < 20_000))
            ? `CPA ${fmtDist(c.cpaM)} ${formatTcpa(c.tcpaS)}`
            : null;
        contactsEl.appendChild(
          h(
            `button.ct-row.ct-target__contact${c.conflict ? '.is-conflict' : ''}`,
            {
              type: 'button',
              onclick: () => onPickContact?.(c),
              onpointerenter: () => onHoverContact?.(c),
              onpointerleave: () => onHoverContact?.(null),
            },
            h('span.ct-target__cid', {}, id2(c.id)),
            h('span.ct-tile', {}, layerTile(c.key)),
            h('span.ct-row__label', {}, c.label || c.key.toUpperCase()),
            h(
              'span.ct-row__meta',
              {},
              [cpa ?? fmtDist(c.distanceM), cpa ? null : fmtBrg(c.bearingDeg)]
                .filter(Boolean)
                .join(' '),
            ),
          ),
        );
      }
      if (!list.length)
        contactsEl.appendChild(h('div.ct-target__empty', {}, 'NO CONTACTS IN VIEW'));
    },
  };
}
