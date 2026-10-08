import { h } from './dom.js';

// The cockpit briefing strip: while riding along in cockpit mode, three pages
// rotate every 9 s under the exit button: LIVE SIGNALS (the nearest contacts,
// tap to select), REGIONAL NEWS (headlines about the place below, linked) and
// LOCAL INFO (place, weather). Fetched through the proxy for the point under
// the subject, again after 5 min or 25 km. Text only (textContent, never
// markup), each page with its credit. Adapted from gods-eye-view
// src/ui/cockpitBriefing.js (MIT).

/**
 * @param {{ proxyClient: object|null, getSubject: () => ({ latitude: number,
 *   longitude: number }|null), getContacts: () => object[],
 *   onPickContact: (c: object) => void, onBrief?: (brief: object|null) => void }} deps
 */
export function createBriefingStrip({
  proxyClient,
  getSubject,
  getContacts,
  onPickContact,
  onBrief,
}) {
  const title = h('span.ct-brief__title');
  const dots = h('span.ct-brief__dots');
  const lines = h('div.ct-brief__lines');
  const credit = h('div.ct-brief__credit');
  const el = h(
    'div.ct-brief.ct-panel',
    { hidden: true, 'aria-live': 'polite' },
    h('div.ct-brief__head', {}, h('span.ct-sq'), title, dots),
    lines,
    credit,
  );
  let mod = null;
  let brief = null;
  let last = null;
  let page = 0;
  let pageTimer = null;
  let pollTimer = null;
  let aborter = null;

  async function refresh() {
    mod ??= await import('../cockpit/briefing.js');
    const where = getSubject();
    if (!where) return;
    if (proxyClient && mod.needsRefresh(last, where)) {
      last = { at: Date.now(), point: where };
      aborter?.abort();
      aborter = new AbortController();
      try {
        brief = await mod.fetchBriefing({
          proxyClient,
          ...where,
          signal: aborter.signal,
        });
      } catch {
        brief = brief ?? null;
      }
      onBrief?.(brief);
    }
    render();
  }

  function render() {
    if (!mod) return;
    const contacts = mod.nearestContacts(getSubject(), getContacts(), { limit: 5 });
    const pages = mod.briefingPages({ ...(brief ?? {}), contacts });
    const p = pages[page % pages.length];
    title.textContent = p.title;
    dots.textContent = pages
      .map((_, i) => (i === page % pages.length ? '■' : '□'))
      .join('');
    lines.innerHTML = '';
    for (const l of p.lines.slice(0, 5)) {
      const row = l.url
        ? h('a.ct-brief__line', {
            href: l.url,
            target: '_blank',
            rel: 'noopener noreferrer',
          })
        : l.target
          ? h('button.ct-brief__line', {
              type: 'button',
              onclick: () => onPickContact(l),
            })
          : h('div.ct-brief__line');
      row.append(h('span', {}, l.text), l.detail ? h('span.ct-muted', {}, l.detail) : '');
      lines.appendChild(row);
    }
    credit.innerHTML = '';
    if (p.credit?.url) {
      credit.appendChild(
        h(
          'a',
          { href: p.credit.url, target: '_blank', rel: 'noopener noreferrer' },
          p.credit.text,
        ),
      );
    } else if (!proxyClient) credit.textContent = 'NEWS AND WEATHER NEED THE LIVE PROXY';
  }

  return {
    el,
    show() {
      el.hidden = false;
      page = 0;
      refresh();
      pageTimer = setInterval(() => {
        page += 1;
        render();
      }, 9000);
      pollTimer = setInterval(refresh, 15_000);
    },
    hide() {
      el.hidden = true;
      clearInterval(pageTimer);
      clearInterval(pollTimer);
      aborter?.abort();
    },
  };
}
