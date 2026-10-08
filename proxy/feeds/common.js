// Shared helpers for the feed registry modules (proxy/feeds.js and the
// per-area files beside it). Server side only.

// Every upstream sees who is calling: OSM, CelesTrak, adsb.lol, Radio Browser,
// Entur and NOAA all ask clients to name the app and give a contact point.
export const USER_AGENT =
  'Argus/0.2 (+https://github.com/H4ch1Net/argus; personal public-data research)';
export const UA = { 'user-agent': USER_AGENT };

/** An allowPaths entry matching exactly this upstream pathname. */
export const exactPath = (p) =>
  new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
