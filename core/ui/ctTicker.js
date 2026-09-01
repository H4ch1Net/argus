import './ctTicker.css';

// Certificate Transparency firehose ticker: "the internet building itself in real
// time." CT has no geography, so this is a live issuance list, not a globe layer.
// Off by default; toggling it connects/disconnects the feed (via onToggle) so the
// upstream websocket is only held while the user is watching.
//
// SECURITY: cert domains are attacker-controllable (anyone can obtain a cert for a
// name they craft), so every value is HTML-escaped before it reaches the DOM.

const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const MAX_ROWS = 14;

/**
 * @param {{ onToggle?: (active: boolean) => void }} [opts]
 */
export function createCtTicker({ onToggle } = {}) {
  const el = document.createElement('div');
  el.className = 'argus-ct';
  el.innerHTML = `
    <div class="argus-ct__head">
      <button class="argus-ct__toggle" type="button" aria-pressed="false">CT firehose</button>
      <span class="argus-ct__rate" data-role="rate">off</span>
    </div>
    <div class="argus-ct__list" data-role="list"></div>
  `;
  const toggleBtn = el.querySelector('.argus-ct__toggle');
  const rateEl = el.querySelector('[data-role="rate"]');
  const listEl = el.querySelector('[data-role="list"]');

  let active = false;
  let rows = [];
  let windowCount = 0;
  let rateTimer = null;

  const renderList = () => {
    listEl.innerHTML = rows
      .map(
        (c) =>
          `<div class="argus-ct__row"><span class="argus-ct__domain">${esc(c.domain)}</span>` +
          `<span class="argus-ct__meta">${esc(c.ca)}${c.domains > 1 ? ` · +${c.domains - 1} SAN` : ''}</span></div>`,
      )
      .join('');
  };

  function setActive(on, fromUser = false) {
    if (active === on) return;
    active = on;
    toggleBtn.setAttribute('aria-pressed', String(on));
    el.classList.toggle('argus-ct--on', on);
    if (on) {
      rateEl.textContent = '0/s';
      rateTimer = setInterval(() => {
        rateEl.textContent = `${windowCount}/s`;
        windowCount = 0;
      }, 1000);
    } else {
      clearInterval(rateTimer);
      rateTimer = null;
      rows = [];
      windowCount = 0;
      rateEl.textContent = 'off';
      renderList();
    }
    if (fromUser) onToggle?.(on);
  }

  toggleBtn.addEventListener('click', () => setActive(!active, true));

  return {
    el,
    /** @param {{ domain: string, domains: number, ca: string }[]} certs */
    push(certs) {
      if (!active || !certs?.length) return;
      windowCount += certs.length;
      rows = [...certs.slice().reverse(), ...rows].slice(0, MAX_ROWS);
      renderList();
    },
    setActive,
  };
}
