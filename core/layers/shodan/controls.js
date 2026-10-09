import { SHODAN_SNAPSHOTS } from './snapshots.js';

// VIEW > SHODAN: which curated snapshot the density map shows, and the opt-in
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
  return ui.section(
    'SHODAN',
    choice.el,
    sample.el,
    ui.h(
      'div.ct-section__note',
      {},
      'Counts by country are credit-free snapshots, never a live search. The host sample costs one query credit per snapshot; tap a host for its InternetDB exposure.',
    ),
  );
}
