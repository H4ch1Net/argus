import './module.css';

// Groups the named control parts (built in main.js) into labelled ops-terminal
// modules. Both shells route their controls through this, so the module layout,
// ordering, and headers stay identical across desktop and mobile while each shell
// still owns where the resulting column of modules is placed.

/**
 * Build one titled module wrapping a body element.
 * @param {string} title
 * @param {HTMLElement} body
 * @returns {HTMLElement}
 */
export function createModule(title, body) {
  const section = document.createElement('section');
  section.className = 'argus-module';
  section.dataset.module = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  const bar = document.createElement('header');
  bar.className = 'argus-module__bar';
  bar.innerHTML =
    '<span class="argus-module__led"></span>' +
    `<span class="argus-module__title">${title}</span>` +
    '<span class="argus-module__rule"></span>';

  const bodyEl = document.createElement('div');
  bodyEl.className = 'argus-module__body';
  bodyEl.appendChild(body);

  section.append(bar, bodyEl);
  return section;
}

// Which part keys belong in which module, and in what order. A module appears
// only if at least one of its parts is present, so shells that omit a part
// (e.g. no compass on desktop) never render an empty frame.
const MODULES = [
  { title: 'SEARCH / QUERY', keys: ['search'] },
  { title: 'PRESETS', keys: ['presetBar'] },
  { title: 'DATA FEEDS', keys: ['layerToggles'] },
  { title: 'DISPLAY', keys: ['imagery', 'terrain', 'sensorControls'] },
  { title: 'GEO', keys: ['locate'] },
  { title: 'INTEL // CT STREAM', keys: ['ct'] },
  { title: 'TERMINAL', keys: ['terminal'] },
  { title: 'TIMELINE', keys: ['scrubber'] },
];

// Parts rendered above the modules as plain alert strips, not framed as modules.
const ALERTS = ['demoBanner', 'notice'];

/**
 * @param {Record<string, HTMLElement|undefined>} parts
 * @returns {HTMLElement[]} ordered elements (alerts first, then modules)
 */
export function buildControlModules(parts) {
  const out = [];
  for (const key of ALERTS) {
    if (parts[key]) {
      parts[key].classList.add('argus-alert');
      out.push(parts[key]);
    }
  }
  for (const { title, keys } of MODULES) {
    const present = keys.map((k) => parts[k]).filter(Boolean);
    if (!present.length) continue;
    const body = document.createElement('div');
    body.className = 'argus-module__stack';
    for (const el of present) body.appendChild(el);
    out.push(createModule(title, body));
  }
  return out;
}
