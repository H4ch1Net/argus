// Parse TLE text (CelesTrak GP FORMAT=tle) into { name, line1, line2 } records.
// Pure: no satellite.js, no Cesium. Handles the 3-line form (name + two element
// lines) and the 2-line form (element lines only, name defaulted).

/**
 * @param {string} text
 * @returns {{ name: string, line1: string, line2: string }[]}
 */
export function parseTle(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.length > 0);

  const sats = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('1 ') && lines[i + 1]?.startsWith('2 ')) {
      sats.push({ name: `SAT ${l.slice(2, 7).trim()}`, line1: l, line2: lines[i + 1] });
      i += 2;
    } else if (lines[i + 1]?.startsWith('1 ') && lines[i + 2]?.startsWith('2 ')) {
      sats.push({ name: l.trim(), line1: lines[i + 1], line2: lines[i + 2] });
      i += 3;
    } else {
      i += 1; // skip a stray line
    }
  }
  return sats;
}
