// Radio station styling + card. Pure.

const NEWSY = /news|talk|weather|emergency|scanner|aviation|marine|traffic/i;

/** Information stations (news, talk, scanners, aviation...) stand out. */
export function radioColorHex(n) {
  return n.meta.tags.some((t) => NEWSY.test(t)) ? '#ffcc80' : '#b39ddb';
}

export function describeRadio(n) {
  const m = n.meta;
  const where = [m.state, m.country].filter(Boolean).join(', ');
  return {
    id: n.id,
    title: m.name,
    subtitle: where || m.countryCode || '',
    rows: [
      ['Tags', m.tags.length ? m.tags.join(', ') : '—'],
      ['Language', m.language || '—'],
      [
        'Stream',
        [m.codec, m.bitrate ? `${m.bitrate} kbps` : null].filter(Boolean).join(' ') ||
          '—',
      ],
      [
        'Popularity',
        m.clicks != null ? `${m.clicks.toLocaleString('en-US')} recent plays` : '—',
      ],
      ['Source', 'Radio Browser (public domain directory)'],
      // Honest about the one thing that leaves the proxy: listening is a direct
      // connection from this device to the broadcaster, who sees its IP.
      ['Note', 'Listening connects this device directly to the broadcaster'],
    ],
    links: [
      { label: 'Listen (opens the stream)', url: m.stream },
      ...(m.homepage ? [{ label: 'Station website', url: m.homepage }] : []),
    ],
  };
}

export const radioSearchText = (n) =>
  `${n.meta.name} ${n.meta.tags.join(' ')} ${n.meta.country || ''} ${n.meta.state || ''} radio`;
