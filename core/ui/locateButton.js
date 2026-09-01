import './locateButton.css';

// "Center on my location" control. Pure UI: it holds no sensor code and just calls
// the injected onLocate (a shell wires that to device geolocation). Shows a brief
// pending/denied state so a denied or slow permission prompt is legible.

/**
 * @param {{ onLocate: (report: (status: 'ok'|'denied'|'unavailable') => void) => void }} opts
 */
export function createLocateButton({ onLocate }) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'argus-locate';
  el.title = 'Center on my location';
  el.setAttribute('aria-label', 'Center on my location');
  el.innerHTML = '<span class="argus-locate__dot" aria-hidden="true"></span>My location';

  let pending = false;
  const report = (status) => {
    pending = false;
    el.classList.remove('is-pending');
    if (status === 'denied' || status === 'unavailable') {
      el.classList.add('is-error');
      el.title =
        status === 'denied'
          ? 'Location permission denied'
          : 'Location unavailable on this device';
      setTimeout(() => el.classList.remove('is-error'), 2500);
    } else {
      el.title = 'Center on my location';
    }
  };

  el.addEventListener('click', () => {
    if (pending) return;
    pending = true;
    el.classList.add('is-pending');
    el.classList.remove('is-error');
    onLocate(report);
  });

  return { el };
}
