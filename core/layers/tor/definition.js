import { ink } from '../sdk/colors.js';
import { parseOnionoo } from './parse.js';
import { describeTor, torRole, torSearchText, torNote } from './format.js';

// Tor relays (Onionoo, keyless) as a Layer SDK point layer: exits, guards and
// middles by glyph. The running-relay list is global and changes hourly, so it
// is fetched whole once an hour (the proxy caches it an hour for every client)
// and Cesium's BillboardCollection draws the few thousand glyphs in one call.

let lastNote = '';

export const torDefinition = {
  id: 'tor',
  fetch: { mode: 'poll', intervalMs: 60 * 60_000, viewportBounded: false },
  interpolate: false,
  maxEntities: 9000,
  normalize: (raw) => {
    const list = parseOnionoo(raw);
    lastNote = torNote(list);
    return list;
  },
  statusNote: () => lastNote,
  render: {
    renderType: 'point',
    style: (n) => {
      const role = torRole(n);
      return { glyph: role.glyph, pixelSize: role.px, color: ink(role.ink) };
    },
  },
  describe: (n) => describeTor(n),
  searchText: torSearchText,
};
