// Navigation and geostationary constellations: the CelesTrak groups the
// reference project loads beside the space stations (about 700 satellites in
// all). Each group is one cached proxy request (CelesTrak's ~2 h update policy
// applies per group). Pure: no satellite.js here, so it is testable anywhere.

export const CONSTELLATION_GROUPS = [
  { group: 'gps-ops', label: 'GPS', color: '#4fc3f7' },
  { group: 'galileo', label: 'Galileo', color: '#ffd54f' },
  // CelesTrak's GLONASS group is glo-ops ("glonass-operational" is a 404).
  { group: 'glo-ops', label: 'GLONASS', color: '#ef9a9a' },
  { group: 'geo', label: 'Geostationary', color: '#a5d6a7' },
];

export const groupInfo = (group) =>
  CONSTELLATION_GROUPS.find((g) => g.group === group) ?? {
    group,
    label: group,
    color: '#e0e0e0',
  };

/**
 * Fetch every group's TLE text through the proxy; a failing group is skipped,
 * all failing is an error.
 * @returns {(query?: object, signal?: AbortSignal) => Promise<{ group: string, text: string }[]>}
 */
export function createConstellationSource({
  proxyClient,
  groups = CONSTELLATION_GROUPS,
}) {
  return async (_query, signal) => {
    const results = await Promise.allSettled(
      groups.map(async ({ group }) => ({
        group,
        text: await proxyClient.getText('celestrak', '/gp.php', {
          params: { GROUP: group, FORMAT: 'tle' },
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
 * Normalize every group, tagging each satellite with its group. A satellite in
 * two groups (a navigation satellite is never geostationary, but GEO lists can
 * overlap) keeps the first, in CONSTELLATION_GROUPS order.
 * @param {{ group: string, text: string }[]} results
 * @param {(text: string) => object[]} toNormalized  tleToNormalized (satellite.js)
 */
export function mergeGroups(results, toNormalized) {
  const order = (g) => {
    const i = CONSTELLATION_GROUPS.findIndex((x) => x.group === g);
    return i < 0 ? CONSTELLATION_GROUPS.length : i;
  };
  const sorted = [...(results || [])].sort((a, b) => order(a.group) - order(b.group));
  const seen = new Set();
  const out = [];
  for (const { group, text } of sorted) {
    const info = groupInfo(group);
    for (const n of toNormalized(text)) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      out.push({ ...n, meta: { ...n.meta, group, groupLabel: info.label } });
    }
  }
  return out;
}
