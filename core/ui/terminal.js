import './terminal.css';

// In-app terminal UI: a collapsible console that runs commands against the app
// (see core/osint/terminal/commands.js). Off by default; the header toggles it.
// Command output can include feed-derived strings (entity labels, place names),
// so every printed line is HTML-escaped.

const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/**
 * @param {{ run: (line: string) => Promise<string[]> }} deps
 */
export function createTerminal({ run }) {
  const el = document.createElement('div');
  el.className = 'argus-term';
  el.innerHTML = `
    <div class="argus-term__head">
      <button class="argus-term__toggle" type="button" aria-pressed="false">Terminal</button>
      <span class="argus-term__hint" data-role="hint">help</span>
    </div>
    <div class="argus-term__body" data-role="body" hidden>
      <div class="argus-term__out" data-role="out"></div>
      <div class="argus-term__inrow">
        <span class="argus-term__prompt">&gt;</span>
        <input class="argus-term__input" type="text" spellcheck="false"
          autocomplete="off" autocapitalize="off" aria-label="Terminal command" />
      </div>
    </div>
  `;
  const toggleBtn = el.querySelector('.argus-term__toggle');
  const body = el.querySelector('[data-role="body"]');
  const out = el.querySelector('[data-role="out"]');
  const input = el.querySelector('.argus-term__input');

  const history = [];
  let hIndex = -1;

  const append = (line, cls = '') => {
    const div = document.createElement('div');
    div.className = `argus-term__line${cls ? ` ${cls}` : ''}`;
    div.innerHTML = esc(line);
    out.appendChild(div);
    out.scrollTop = out.scrollHeight;
  };

  const setOpen = (open) => {
    body.hidden = !open;
    toggleBtn.setAttribute('aria-pressed', String(open));
    el.classList.toggle('argus-term--on', open);
    if (open) {
      if (!out.childElementCount)
        append('type "help" for commands', 'argus-term__line--dim');
      input.focus();
    }
  };
  toggleBtn.addEventListener('click', () => setOpen(body.hidden));

  const submit = async () => {
    const line = input.value.trim();
    if (!line) return;
    input.value = '';
    history.push(line);
    hIndex = history.length;
    append(`> ${line}`, 'argus-term__line--cmd');
    if (line.toLowerCase() === 'clear') {
      out.innerHTML = '';
      return;
    }
    for (const outputLine of await run(line)) append(outputLine);
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (hIndex > 0) input.value = history[--hIndex];
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (hIndex < history.length - 1) input.value = history[++hIndex];
      else {
        hIndex = history.length;
        input.value = '';
      }
    }
  });

  return { el, setOpen };
}
