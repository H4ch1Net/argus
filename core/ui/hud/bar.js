import './bar.css';
import { h, DIAMOND_SVG } from '../dom.js';

// The ctOS bar (design/ctos Bar): a 37px strip on the ground colour with a 1px
// ctosGray outline, split by 1px dividers, every segment held in a CornerFrame.
// The lockup sits at the left: a ctosGray block carrying the diamond and "AR" in
// the ground colour, then a large thin "GUS". The same component builds the
// bottom status strip (no lockup).

/**
 * @param {{ lockup?: boolean, className?: string }} [opts]
 * @returns {{ el: HTMLElement, start: HTMLElement, end: HTMLElement,
 *   add: (seg: { el: HTMLElement }, side?: 'start'|'end') => void }}
 */
export function createBar({ lockup = true, className = '' } = {}) {
  const start = h('div.ct-bar__side');
  const end = h('div.ct-bar__side.ct-bar__side--end');
  const el = h(
    `div.ct-bar${className ? `.${className}` : ''}`,
    { role: 'toolbar' },
    lockup ? createLockup() : null,
    start,
    h('div.ct-bar__spacer'),
    end,
  );
  return {
    el,
    start,
    end,
    add(seg, side = 'start') {
      (side === 'end' ? end : start).appendChild(seg.el ?? seg);
    },
  };
}

/** The Argus lockup in the ctOS shape. */
export function createLockup({ size = 'bar' } = {}) {
  return h(
    `div.ct-lockup.ct-lockup--${size}`,
    { 'aria-label': 'Argus' },
    h(
      'span.ct-lockup__bar',
      { html: DIAMOND_SVG(size === 'bar' ? 18 : 26, '#0e0e0e') },
      h('b', {}, 'AR'),
    ),
    h('span.ct-lockup__os', {}, 'GUS'),
  );
}

/**
 * One framed segment: an optional label (textSecondary) and a value
 * (textPrimary). Clickable when onClick is given.
 * @param {{ label?: string, value?: string, title?: string, onClick?: Function,
 *   className?: string, meter?: boolean }} opts
 */
export function createSegment({
  label,
  value = '',
  title,
  onClick,
  className = '',
  meter = false,
} = {}) {
  const labelEl = label ? h('span.ct-seg__label', {}, label) : null;
  const valueEl = h('span.ct-seg__value', {}, value);
  const fill = meter ? h('i') : null;
  const body = h('span.ct-seg__body', {}, labelEl, valueEl);
  const inner = h(
    onClick ? 'button.ct-seg__frame.ct-frame' : 'span.ct-seg__frame.ct-frame',
    onClick
      ? { type: 'button', onclick: onClick, title, 'aria-label': title || label }
      : { title },
    meter
      ? h('span.ct-seg__stack', {}, body, h('span.ct-meter.ct-seg__meter', {}, fill))
      : body,
  );
  const el = h(`span.ct-seg${className ? `.${className}` : ''}`, {}, inner);
  return {
    el,
    button: onClick ? inner : null,
    set(v) {
      if (valueEl.textContent !== v) valueEl.textContent = v;
    },
    setLabel(v) {
      if (labelEl && labelEl.textContent !== v) labelEl.textContent = v;
    },
    setMeter(frac) {
      if (fill) fill.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
    },
    setHtml(html) {
      valueEl.innerHTML = html;
    },
    setState(state) {
      el.dataset.state = state || '';
    },
  };
}

/**
 * Workspace-style cells (the bar's five squares): each a CornerFrame holding a
 * short code; the active one shows the 9px crosshair. Used for presets.
 * @param {{ items: { id: string, code: string, title: string }[], onSelect: (id: string) => void }} opts
 */
export function createCells({ items, onSelect }) {
  const el = h('span.ct-cells', { role: 'group', 'aria-label': 'Presets' });
  const buttons = new Map();
  for (const it of items) {
    const b = h(
      'button.ct-cell.ct-frame',
      {
        type: 'button',
        title: it.title,
        'aria-pressed': 'false',
        onclick: () => onSelect(it.id),
      },
      h('i.ct-cell__cross'),
      h('span', {}, it.code),
    );
    buttons.set(it.id, b);
    el.appendChild(b);
  }
  return {
    el,
    setActive(id) {
      for (const [key, b] of buttons) b.setAttribute('aria-pressed', String(key === id));
    },
  };
}
