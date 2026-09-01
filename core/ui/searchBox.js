import './searchBox.css';

// Global search box: an input plus a results dropdown. Debounced; core provides
// the element, the shell places it. onQuery(q) -> results[]; onSelect(result).

const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/**
 * @param {{ onQuery: (q: string) => Promise<object[]>, onSelect: (result: object) => void }} opts
 */
export function createSearchBox({ onQuery, onSelect }) {
  const el = document.createElement('div');
  el.className = 'argus-search';

  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'argus-search__input';
  input.placeholder = 'Search callsign, ship, satellite, place...';
  input.setAttribute('aria-label', 'Global search');

  const list = document.createElement('div');
  list.className = 'argus-search__results';
  list.hidden = true;

  el.append(input, list);

  let timer = null;
  let seq = 0;

  const render = (results) => {
    if (!results.length) {
      list.hidden = true;
      list.innerHTML = '';
      return;
    }
    list.innerHTML = results
      .map(
        (r, i) =>
          `<button type="button" class="argus-search__item" data-i="${i}">` +
          `<span class="argus-search__label">${esc(r.label)}</span>` +
          `<span class="argus-search__sub">${esc(r.sub)}</span></button>`,
      )
      .join('');
    for (const btn of list.querySelectorAll('.argus-search__item')) {
      btn.addEventListener('click', () => {
        onSelect(results[Number(btn.dataset.i)]);
        input.value = '';
        render([]);
      });
    }
    list.hidden = false;
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value;
    if (!q.trim()) return render([]);
    timer = setTimeout(async () => {
      const mine = ++seq;
      const results = await onQuery(q);
      if (mine === seq) render(results); // ignore stale responses
    }, 300);
  });

  return { el, input };
}
