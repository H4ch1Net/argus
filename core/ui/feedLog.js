// What a layer's status change adds to LOGS (core/ui/logs.js), kept light:
//   error  a feed failure, every time (the log folds repeats into a count);
//   busy   a busy or failing source (429, 5xx, a timeout): one calm line when
//          it starts, not one per poll (the layer keeps what it had);
//   stale  the proxy served its last good copy: one line when it starts;
//   back   only after one of those, and only on a real answer: "BACK: N
//          items", or "no items here" when the view is empty (never a
//          recovery claimed for a layer that just has nothing in view).
// Pure: main.js feeds it the manager's status stream.

const BUSY_STATUS = new Set([429, 500, 502, 503, 504]);
const BUSY_TEXT = /responded (429|50[0-4])\b|timed out|is busy|queue/i;
// A 502 the proxy writes itself for a missing key is not "busy": it is set-up.
const NOT_CONFIGURED = /not configured/i;

/** The state a status stands for in the log: ok | stale | busy | error | other. */
export function feedState(s) {
  const st = s?.state;
  if (st === 'ok') return s.stale != null ? 'stale' : 'ok';
  if (st !== 'error') return st ?? 'off';
  const msg = String(s.message ?? '');
  if (NOT_CONFIGURED.test(msg)) return 'error';
  return BUSY_STATUS.has(Number(s.status)) || BUSY_TEXT.test(msg) ? 'busy' : 'error';
}

const PROBLEMS = new Set(['error', 'busy', 'stale']);

/**
 * @param {string|undefined} was  the state logged before (feedState of the last status)
 * @param {object} s              the new status
 * @param {string} label          the layer's name, upper case
 * @param {string} key            the layer key (the log source)
 * @returns {{ state: string, entry: object|null }}
 *   state: what to remember for the next call (a status that is neither a
 *   recovery nor a problem keeps the earlier problem)
 */
export function feedLogEntry(was, s, label, key) {
  const state = feedState(s);
  const source = key;
  if (state === 'error')
    return {
      state,
      entry: {
        level: 'error',
        source,
        title: `${label} FEED ERROR`,
        body: s.message || 'The feed did not answer.',
      },
    };
  if (state === 'busy')
    return {
      state,
      entry:
        was === 'busy'
          ? null
          : {
              level: 'warn',
              source,
              title: `${label} SOURCE BUSY`,
              body: `${String(s.message || 'The source did not answer').replace(/\.$/, '')}. Showing what the layer already had; asking again shortly.`,
            },
    };
  if (state === 'stale')
    return {
      state,
      entry:
        was === 'stale'
          ? null
          : {
              level: 'warn',
              source,
              title: `${label} STALE`,
              body: String(s.note ?? '').replace(/^STALE: /, ''),
            },
    };
  if (state === 'ok') {
    if (!PROBLEMS.has(was)) return { state, entry: null };
    const count = Number(s.count) || 0;
    if (count > 0)
      return {
        state,
        entry: { level: 'info', source, title: `${label} BACK`, body: `${count} items.` },
      };
    // Nothing drawn: only a real answer ends the problem, and it says so plainly.
    if (!s.answered) return { state: was, entry: null };
    return {
      state,
      entry: {
        level: 'info',
        source,
        title: `${label} ANSWERING`,
        body: 'The source answers again; no items here.',
      },
    };
  }
  // loading, off, unavailable: not news; a problem stays remembered while
  // the layer loads (so its recovery is still reported), and is forgotten
  // when it is switched off.
  return { state: state === 'off' ? 'off' : was, entry: null };
}
