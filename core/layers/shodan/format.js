// Shodan density styling + card. Counts span many orders of magnitude, so size
// and color are on a log scale. Pure.

const logCount = (count) => Math.log10(Math.max(1, count || 0));

export function shodanPixelSize(count) {
  return Math.min(42, 8 + logCount(count) * 5);
}

export function shodanColorHex(count) {
  const l = logCount(count);
  if (l < 2) return '#5fd3ff';
  if (l < 4) return '#e3d357';
  if (l < 5) return '#e3a857';
  return '#ff5a3f';
}

export function describeShodan(n) {
  return {
    id: n.id,
    title: n.meta.country,
    subtitle: 'exposed hosts (Shodan snapshot)',
    rows: [
      ['Country', n.meta.country],
      ['Exposed hosts', (n.meta.count ?? 0).toLocaleString('en-US')],
    ],
  };
}
