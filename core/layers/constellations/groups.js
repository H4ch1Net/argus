// Constellations: the CelesTrak groups the reference project loads beside the
// space stations (navigation, geostationary and the brightest "visual"
// objects, about 850 satellites in all), plus an optional dense mode that adds
// the whole Starlink shell (thousands of points). Each group is one cached
// proxy request (CelesTrak's ~2 h update policy applies per group). Groups,
// dense mode and classes adapted from gods-eye-view
// src/layers/satellites/policy.js and src/data/satelliteClass.js (MIT).
// Pure: no satellite.js here, so it is testable anywhere.

import { Tier } from '../../capability/tier.js';
import {
  satelliteClassOf,
  satelliteClassColor,
  satelliteClassLabel,
  STATION_NORAD,
} from '../satellites/classes.js';

const group = (g, label) =>
  Object.freeze({ group: g, label, color: satelliteClassColor(g) });

// In dedupe priority order: a satellite listed in two groups keeps the first,
// so the specific constellations win over the catch-all visual group.
export const CONSTELLATION_GROUPS = Object.freeze([
  group('gps-ops', 'GPS'),
  group('galileo', 'Galileo'),
  // CelesTrak's GLONASS group is glo-ops ("glonass-operational" is a 404).
  group('glo-ops', 'GLONASS'),
  group('geo', 'Geostationary'),
  group('visual', 'Visual (brightest)'),
]);

// Dense mode: the Starlink shell as small points, no labels. Thousands of
// satellites, so it is never on by default and never on a phone: the layer
// propagates it round-robin (roundRobin.js) and the caller gates it by tier.
export const STARLINK_GROUP = Object.freeze({
  ...group('starlink', 'Starlink'),
  dense: true,
});

/**
 * The dense-mode gate: only the FULL capability tier (real GPU and thermal
 * headroom) may turn on dense mode; a phone lands at BALANCED or below, so it
 * never can. Capability is runtime state: branch on the tier, not on "mobile".
 */
export const STARLINK_DENSE = Object.freeze({
  group: STARLINK_GROUP.group,
  minTier: Tier.FULL,
  defaultOn: false,
});
export const denseAllowedForTier = (tier) => tier === STARLINK_DENSE.minTier;

const ALL_GROUPS = [...CONSTELLATION_GROUPS, STARLINK_GROUP];

export const groupInfo = (g) =>
  ALL_GROUPS.find((x) => x.group === g) ?? {
    group: g,
    label: g,
    color: satelliteClassColor(g),
  };

/** The groups to fetch: the core set, plus Starlink when dense mode is on. */
export const constellationGroups = ({ dense = false } = {}) =>
  dense ? ALL_GROUPS : [...CONSTELLATION_GROUPS];

/**
 * Fetch every group's TLE text through the proxy; a failing group is skipped,
 * all failing is an error. `dense` may be a boolean or a function read on every
 * fetch, so toggling dense mode takes effect on the next poll.
 * @param {{ proxyClient: object, groups?: object[], dense?: boolean | (() => boolean) }} opts
 * @returns {(query?: object, signal?: AbortSignal) => Promise<{ group: string, text: string }[]>}
 */
export function createConstellationSource({ proxyClient, groups = null, dense = false }) {
  return async (_query, signal) => {
    const on = typeof dense === 'function' ? Boolean(dense()) : Boolean(dense);
    const list = groups ?? constellationGroups({ dense: on });
    const results = await Promise.allSettled(
      list.map(async ({ group: g }) => ({
        group: g,
        text: await proxyClient.getText('celestrak', '/gp.php', {
          params: { GROUP: g, FORMAT: 'tle' },
          signal,
        }),
      })),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (!ok.length && results.length) throw results[0].reason;
    return ok;
  };
}

/**
 * Normalize every group, tagging each satellite with its group and class. A
 * satellite in two groups keeps the first, in priority order. Crewed stations
 * (the ISS is also in `visual`) are left to the satellites layer, which loads
 * the stations group, so they are never drawn twice.
 * @param {{ group: string, text: string }[]} results
 * @param {(text: string) => object[]} toNormalized  tleToNormalized (satellite.js)
 */
export function mergeGroups(results, toNormalized) {
  const order = (g) => {
    const i = ALL_GROUPS.findIndex((x) => x.group === g);
    return i < 0 ? ALL_GROUPS.length : i;
  };
  const sorted = [...(results || [])].sort((a, b) => order(a.group) - order(b.group));
  const seen = new Set();
  const out = [];
  for (const { group: g, text } of sorted) {
    const info = groupInfo(g);
    for (const n of toNormalized(text)) {
      if (seen.has(n.id) || STATION_NORAD[n.id]) continue;
      seen.add(n.id);
      const opts = { norad: n.id };
      out.push({
        ...n,
        meta: {
          ...n.meta,
          group: g,
          groupLabel: info.label,
          klass: satelliteClassOf(g, opts).klass,
          classLabel: satelliteClassLabel(g, opts),
          dense: Boolean(info.dense),
        },
      });
    }
  }
  return out;
}
