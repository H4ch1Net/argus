// The state of named VIEW controls (./controls.js switches and choices), read
// and re-applied by their visible label, for session memory
// (core/share/session.js). Applying presses the control exactly as a person
// would, so its own handler does the work (and repaints): nothing here knows
// what a control does. Only the labels in the allowlists are touched.

const text = (el) => String(el?.textContent ?? '').trim();

function* switches(roots) {
  for (const root of roots)
    for (const el of root?.querySelectorAll?.('button.ct-switch') ?? [])
      yield [text(el.querySelector('.ct-switch__label')), el];
}

function* choices(roots) {
  for (const root of roots)
    for (const seg of root?.querySelectorAll?.('.ct-seg[aria-label]') ?? [])
      yield [seg.getAttribute('aria-label'), seg];
}

const pressed = (el) => el.getAttribute('aria-pressed') === 'true';

/**
 * @param {Iterable<Element>} roots  the VIEW sections
 * @param {{ switches: string[], choices: string[] }} allow
 * @returns {{ switches: Record<string, boolean>, choices: Record<string, string> }}
 */
export function readControls(roots, allow) {
  const list = [...roots];
  const out = { switches: {}, choices: {} };
  for (const [label, el] of switches(list))
    if (allow.switches.includes(label) && !(label in out.switches))
      out.switches[label] = pressed(el);
  for (const [label, seg] of choices(list)) {
    if (!allow.choices.includes(label) || label in out.choices) continue;
    const on = [...seg.querySelectorAll('button')].find(pressed);
    if (on) out.choices[label] = text(on);
  }
  return out;
}

/**
 * Press the controls whose state differs from `saved`. Returns the labels
 * pressed (for the log and tests).
 */
export function applyControls(roots, saved, allow) {
  const list = [...roots];
  const done = [];
  const seen = new Set();
  for (const [label, el] of switches(list)) {
    if (seen.has(`s:${label}`) || !allow.switches.includes(label)) continue;
    seen.add(`s:${label}`);
    const want = saved?.switches?.[label];
    if (typeof want === 'boolean' && want !== pressed(el)) {
      el.click();
      done.push(label);
    }
  }
  for (const [label, seg] of choices(list)) {
    if (seen.has(`c:${label}`) || !allow.choices.includes(label)) continue;
    seen.add(`c:${label}`);
    const want = saved?.choices?.[label];
    if (typeof want !== 'string') continue;
    const btn = [...seg.querySelectorAll('button')].find((b) => text(b) === want);
    if (btn && !pressed(btn)) {
      btn.click();
      done.push(label);
    }
  }
  return done;
}
