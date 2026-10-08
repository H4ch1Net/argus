import './terminal.css';
import { h } from './dom.js';

// The in-app terminal, kitty-style (design/ctos Terminal): a floating window on
// term-bg, a powerline tab " 1:argus ", the ctOS banner on first open, and a
// two-line prompt whose ❯ is success green after a good command and error red
// after a failed one. It drives the app and runs the passive lookups already
// built (public indexes only, never traffic at a host). Toggle: the backtick
// key or the bar's TERM segment.

const TIPS = [
  'layers  /  layer flights on',
  'track BAW123',
  'goto london',
  'query 1.1.1.1  /  correlate example.com',
  'preset sky',
];

/**
 * @param {{ run: (line: string) => Promise<string[]> }} deps
 */
export function createTerminal({ run }) {
  const out = h('div.ct-term__out.ct-scroll');
  const input = h('input.ct-term__input', {
    type: 'text',
    spellcheck: 'false',
    autocomplete: 'off',
    autocapitalize: 'off',
    'aria-label': 'Terminal command',
  });
  const caret = h('span.ct-term__caret', {}, '❯');
  const closeBtn = h(
    'button.ct-term__close',
    { type: 'button', 'aria-label': 'Close terminal', onclick: () => setOpen(false) },
    '×',
  );
  const el = h(
    'div.ct-term',
    { hidden: true, role: 'dialog', 'aria-label': 'Terminal' },
    h(
      'div.ct-term__tabs',
      {},
      h('span.ct-term__tab', {}, ' 1:argus '),
      h('span.ct-term__fill'),
      closeBtn,
    ),
    out,
    h(
      'div.ct-term__in',
      {},
      h('div.ct-term__path', {}, h('span.ct-muted', {}, '~/'), 'argus'),
      h('div.ct-term__row', {}, caret, input),
    ),
  );

  const history = [];
  let hIndex = -1;
  const started = Date.now();

  const line = (text, cls = '') => {
    out.appendChild(h(`div.ct-term__line${cls ? `.${cls}` : ''}`, {}, text));
    out.scrollTop = out.scrollHeight;
  };

  function banner() {
    const rule = '─'.repeat(40);
    line(`┌─[ ARGUS ]${rule}`, 'is-dim');
    out.appendChild(
      h('div.ct-term__line', {}, '│ ▨ operator@argus  ', h('span.ct-ok', {}, '● ONLINE')),
    );
    const up = Math.round((Date.now() - started) / 1000);
    out.appendChild(
      h(
        'div.ct-term__line',
        {},
        h('span.ct-muted', {}, '│ UPTIME '),
        `${Math.floor(up / 60)}m ${up % 60}s`,
      ),
    );
    out.appendChild(
      h(
        'div.ct-term__line',
        {},
        h('span.ct-muted', {}, '│ TIP    '),
        TIPS[Math.floor(Math.random() * TIPS.length)],
      ),
    );
    line(`└${'─'.repeat(50)}`, 'is-dim');
    line('type "help" for commands', 'is-dim');
  }

  function setOpen(open) {
    el.hidden = !open;
    if (open) {
      if (!out.childElementCount) banner();
      requestAnimationFrame(() => input.focus());
    } else input.blur();
  }

  async function submit() {
    const cmd = input.value.trim();
    if (!cmd) return;
    input.value = '';
    history.push(cmd);
    hIndex = history.length;
    line(`❯ ${cmd}`, 'is-cmd');
    if (cmd.toLowerCase() === 'clear') {
      out.innerHTML = '';
      return;
    }
    let ok = true;
    try {
      const res = await run(cmd);
      for (const l of res) {
        const bad = /^(error|unknown|no |not )/i.test(l);
        if (bad) ok = false;
        line(l, bad ? 'is-err' : '');
      }
    } catch (err) {
      ok = false;
      line(`error: ${err?.message || err}`, 'is-err');
    }
    caret.classList.toggle('is-err', !ok);
  }

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
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  });

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if (e.key === '`' && !typing) {
      e.preventDefault();
      setOpen(el.hidden);
    }
  });

  return { el, setOpen, toggle: () => setOpen(el.hidden), isOpen: () => !el.hidden };
}
