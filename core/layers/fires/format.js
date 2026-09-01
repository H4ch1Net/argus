// Fire styling + card model. Pure. Fires are colored and sized by radiative
// power (FRP, in megawatts): faint yellow for a small hotspot up to deep red for
// an intense one.

export function fireColorHex(frp) {
  if (frp == null) return '#ff8c3f';
  if (frp < 5) return '#ffd257';
  if (frp < 20) return '#ff9d3f';
  if (frp < 50) return '#ff5a2f';
  return '#ff2a1f';
}

export function firePixelSize(frp) {
  if (frp == null) return 6;
  return Math.min(24, Math.max(5, 5 + Math.sqrt(Math.max(0, frp)) * 1.5));
}

const conf = (c) => {
  if (c == null || c === '') return '—';
  if (c === 'n') return 'nominal';
  if (c === 'l') return 'low';
  if (c === 'h') return 'high';
  return c; // MODIS reports a 0-100 percentage
};

export function describeFire(n) {
  const m = n.meta;
  return {
    id: n.id,
    title: 'Fire detection',
    subtitle: m.daynight === 'N' ? 'night pass' : m.daynight === 'D' ? 'day pass' : '',
    rows: [
      ['Radiative power', m.frp != null ? `${m.frp.toFixed(1)} MW` : '—'],
      ['Brightness', m.brightness != null ? `${Math.round(m.brightness)} K` : '—'],
      ['Confidence', conf(m.confidence)],
      ['Acquired', m.acqDate ? `${m.acqDate} ${formatTime(m.acqTime)} UTC` : '—'],
      [
        'Coordinates',
        `${n.position.latitude.toFixed(2)}, ${n.position.longitude.toFixed(2)}`,
      ],
    ],
  };
}

// FIRMS acq_time is an HHMM string, e.g. "0742" becomes "07:42".
function formatTime(t) {
  if (t == null) return '';
  const s = String(t).padStart(4, '0');
  return `${s.slice(0, 2)}:${s.slice(2, 4)}`;
}
