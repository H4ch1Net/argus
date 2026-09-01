import './metadataCard.css';

// The metadata card: core provides the element and content; each shell decides
// where it sits (bottom sheet on mobile, side panel on desktop). Hidden until an
// entity is tracked.

const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/**
 * @param {{ onClose?: () => void }} [opts]
 */
export function createMetadataCard({ onClose } = {}) {
  const el = document.createElement('div');
  el.className = 'argus-card';
  el.hidden = true;
  el.innerHTML = `
    <button class="argus-card__close" type="button" aria-label="Close">&times;</button>
    <div class="argus-card__title" data-role="title"></div>
    <div class="argus-card__subtitle" data-role="subtitle"></div>
    <div class="argus-card__rows" data-role="rows"></div>
    <div class="argus-card__actions" data-role="actions" hidden></div>
  `;

  const titleEl = el.querySelector('[data-role="title"]');
  const subtitleEl = el.querySelector('[data-role="subtitle"]');
  const rowsEl = el.querySelector('[data-role="rows"]');
  const actionsEl = el.querySelector('[data-role="actions"]');

  el.querySelector('.argus-card__close').addEventListener('click', () => onClose?.());

  return {
    el,
    /**
     * @param {object} model
     * @param {{ label: string, onClick: () => void }[]} [actions]
     */
    show(model, actions = []) {
      titleEl.textContent = model.title;
      subtitleEl.textContent = model.subtitle || '';
      subtitleEl.hidden = !model.subtitle;
      const rowHtml = ([k, v]) =>
        `<div class="argus-card__row"><span>${esc(k)}</span><span>${esc(v)}</span></div>`;
      // Flat rows, then optional titled sections (used by the OSINT correlation
      // view to show one asset across several sources at once).
      const flat = (model.rows || []).map(rowHtml).join('');
      const sections = (model.sections || [])
        .map(
          (s) =>
            `<div class="argus-card__section">${esc(s.title)}</div>` +
            (s.rows || []).map(rowHtml).join(''),
        )
        .join('');
      rowsEl.innerHTML = flat + sections;
      actionsEl.innerHTML = '';
      for (const action of actions) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'argus-card__action';
        btn.textContent = action.label;
        btn.addEventListener('click', action.onClick);
        actionsEl.appendChild(btn);
      }
      actionsEl.hidden = actions.length === 0;
      el.hidden = false;
    },
    hide() {
      el.hidden = true;
    },
  };
}
