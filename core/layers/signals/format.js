// Traffic-light card and search text. Pure.

import { osmLink } from '../overpass/parse.js';

const MODE = {
  signal: 'Signals',
  blinker: 'Flashing (blinker)',
  emergency: 'Emergency (fire station exit)',
  ramp_meter: 'Ramp meter',
  level_crossing: 'Level crossing',
  lane_control: 'Lane control',
  continuous_green: 'Continuous green',
  cyclist_waiting_aid: 'Cyclist waiting aid',
};
const DIRECTION = {
  forward: 'Along the way',
  backward: 'Against the way',
  both: 'Both directions',
};
const yesNo = (v) => (v === 'yes' ? 'Yes' : v === 'no' ? 'No' : null);

export function describeSignal(n) {
  const t = n.meta.tags || {};
  const crossing = n.meta.kind === 'crossing';
  const rows = [['Type', crossing ? 'Pedestrian crossing signals' : 'Junction signals']];
  const add = (label, value) => value && rows.push([label, String(value).slice(0, 50)]);
  add('Mode', MODE[t.traffic_signals] ?? t.traffic_signals);
  add(
    'Faces',
    DIRECTION[t['traffic_signals:direction']] ?? t['traffic_signals:direction'],
  );
  add('Name', t.name || t.ref);
  add('Sound', yesNo(t['traffic_signals:sound']));
  add('Vibration', yesNo(t['traffic_signals:vibration']));
  add('Button', yesNo(t.button_operated));
  add('Countdown', yesNo(t['traffic_signals:countdown']));
  if (t.crossing && crossing)
    add('Crossing', t['crossing:markings'] ? `marked (${t['crossing:markings']})` : null);
  add('Island', yesNo(t['crossing:island']));
  add('Operator', t.operator);
  rows.push(['Source', 'OpenStreetMap']);
  rows.push([
    'Coordinates',
    `${n.position.latitude.toFixed(5)}, ${n.position.longitude.toFixed(5)}`,
  ]);
  const link = osmLink(n);
  return {
    id: n.id,
    title: crossing ? 'Crossing signals' : 'Traffic signals',
    subtitle: t.name || '',
    rows,
    links: link ? [link] : [],
  };
}

export function signalSearchText(n) {
  const t = n.meta.tags || {};
  return `traffic signals ${n.meta.kind} ${t.name || ''} ${t.ref || ''}`;
}
