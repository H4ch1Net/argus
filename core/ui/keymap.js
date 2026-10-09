// The keyboard shortcut map (the "?" list is core/ui/shortcuts.js). As in the
// reference: H HUD, O orbit, V clean view, D detection density and number keys
// (looks there, presets here), plus Argus's own. Every one is also a control
// in the menus: the keyboard is a shortcut, never the only way (phones have
// none). Typing in a field keeps its keys. Pure, no DOM. Adapted from
// gods-eye-view src/ui/applicationShortcuts.js (MIT).

/** What the help lists, in order. Keys other modules own are listed too. */
export const SHORTCUTS = Object.freeze([
  { keys: ['/', 'Ctrl K'], label: 'Search contacts, places, assets' },
  { keys: ['`'], label: 'Terminal' },
  { keys: ['M'], label: 'Menu', desktop: true },
  { keys: ['T'], label: 'Target panel', desktop: true },
  { keys: ['G'], label: 'Where to (navigation)' },
  { keys: ['1', '…', '6'], label: 'Presets (Near, Sky, Haz, Env, Watch, Net)' },
  { keys: ['N', 'P'], label: 'Next / previous contact' },
  { keys: ['F'], label: 'Follow the target' },
  { keys: ['C'], label: 'Cockpit (ride along)' },
  { keys: ['O'], label: 'Orbit the middle of the view' },
  { keys: ['H'], label: 'Intel HUD' },
  { keys: ['D'], label: 'Tracking box density' },
  { keys: ['V'], label: 'Clean view (hide the interface)' },
  { keys: ['Esc'], label: 'Release the target, close, stop' },
  { keys: ['?'], label: 'This list' },
]);

const TYPING = /^(INPUT|TEXTAREA|SELECT)$/;

/**
 * The action a key press asks for, or null. Pure (takes a KeyboardEvent-like
 * object), so the mapping is testable.
 * @returns {string|{ preset: number }|null}
 */
export function actionForKey(e) {
  if (!e || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (TYPING.test(e.target?.tagName ?? '') || e.target?.isContentEditable) return null;
  if (e.key === '?') return 'help';
  if (/^[1-9]$/.test(e.key)) return { preset: Number(e.key) - 1 };
  switch (String(e.key).toLowerCase()) {
    case 'h':
      return 'hud';
    case 'o':
      return 'orbit';
    case 'v':
      return 'clean';
    case 'd':
      return 'density';
    case 'n':
    case ']':
      return 'next';
    case 'p':
    case '[':
      return 'prev';
    default:
      return null;
  }
}

/**
 * @param {{ help?: Function, hud?: Function, orbit?: Function, clean?: Function,
 *   density?: Function, next?: Function, prev?: Function,
 *   preset?: (index: number) => void }} actions  missing ones are ignored
 * @returns {() => void} unbind
 */
export function bindShortcuts(actions, doc = document) {
  const onKey = (e) => {
    const a = actionForKey(e);
    if (!a) return;
    const fn = typeof a === 'string' ? actions[a] : actions.preset;
    if (!fn) return;
    e.preventDefault();
    if (typeof a === 'string') fn();
    else fn(a.preset);
  };
  doc.addEventListener('keydown', onKey);
  return () => doc.removeEventListener('keydown', onKey);
}
