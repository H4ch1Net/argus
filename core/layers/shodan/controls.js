import { SHODAN_SNAPSHOTS } from './snapshots.js';

// The Shodan layer's options (LAYERS, beside its row): which curated snapshot
// the density map shows, and the opt-in
// host sample. A change re-fetches the layer once (the proxy answers from its
// 12 hour cache when it can); nothing here searches on pan.

/**
 * @param {{ settings: object, manager: object,
 *   ui: { section: Function, createChoice: Function, createSwitch: Function, h: Function } }} deps
 */
export function createShodanSection({ settings, manager, ui }) {
  const refresh = () => {
    if (manager.isEnabled('shodan')) manager.getLayer('shodan')?.refresh?.();
  };
  const choice = ui.createChoice({
    caption: 'Snapshot',
    options: SHODAN_SNAPSHOTS.map((s) => ({ id: s.id, label: s.short, title: s.label })),
    current: settings?.get('shodanSnapshot') ?? 'web',
    onSelect: (id) => {
      settings?.set('shodanSnapshot', id);
      refresh();
    },
  });
  const sample = ui.createSwitch({
    label: 'Host sample',
    on: Boolean(settings?.get('shodanSample')),
    title:
      'One page of hosts for the snapshot, placed on the map (one Shodan query credit, cached 12 h)',
    onToggle: (on) => {
      settings?.set('shodanSample', on);
      refresh();
    },
  });
  // Counts by country are credit-free snapshots, never a live search; the
  // host sample costs one query credit per snapshot (its switch says so).
  return ui.section('SHODAN', choice.el, sample.el);
}
