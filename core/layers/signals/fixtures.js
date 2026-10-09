// A real Overpass answer for the traffic-signals query (./parse.js), trimmed:
// junction signals and signalled pedestrian crossings in downtown San
// Francisco (37.780,-122.420,37.790,-122.405), fetched 2026-10-09 from the
// maps.mail.ru Overpass mirror.

export const SF_SIGNALS = {
  elements: [
    {
      type: 'node',
      id: 65293741,
      lat: 37.7817636,
      lon: -122.4097034,
      tags: {
        highway: 'traffic_signals',
        traffic_signals: 'signal',
        'traffic_signals:direction': 'both',
      },
    },
    {
      type: 'node',
      id: 65293743,
      lat: 37.7814098,
      lon: -122.4092596,
      tags: {
        highway: 'traffic_signals',
        traffic_signals: 'signal',
        'traffic_signals:direction': 'both',
      },
    },
    {
      type: 'node',
      id: 65293746,
      lat: 37.7809779,
      lon: -122.4087215,
      tags: {
        highway: 'traffic_signals',
      },
    },
    {
      type: 'node',
      id: 65303538,
      lat: 37.7896352,
      lon: -122.4054347,
      tags: {
        highway: 'traffic_signals',
      },
    },
    {
      type: 'node',
      id: 65303541,
      lat: 37.7894357,
      lon: -122.4069817,
      tags: {
        highway: 'traffic_signals',
      },
    },
    {
      type: 'node',
      id: 552853367,
      lat: 37.7882806,
      lon: -122.4085313,
      tags: {
        button_operated: 'yes',
        crossing: 'traffic_signals',
        'crossing:markings': 'ladder',
        'crossing:signals': 'yes',
        highway: 'crossing',
        tactile_paving: 'no',
        'traffic_signals:sound': 'yes',
      },
    },
    {
      type: 'node',
      id: 763026589,
      lat: 37.7821448,
      lon: -122.4101928,
      tags: {
        button_operated: 'no',
        crossing: 'traffic_signals',
        'crossing:island': 'no',
        'crossing:markings': 'zebra',
        'crossing:signals': 'yes',
        highway: 'crossing',
        tactile_paving: 'no',
        'traffic_signals:sound': 'no',
        'traffic_signals:vibration': 'no',
      },
    },
    {
      type: 'node',
      id: 1064740944,
      lat: 37.7895166,
      lon: -122.4069976,
      tags: {
        button_operated: 'no',
        crossing: 'traffic_signals',
        'crossing:markings': 'ladder',
        'crossing:signals': 'yes',
        highway: 'crossing',
        tactile_paving: 'yes',
        'traffic_signals:sound': 'no',
        'traffic_signals:vibration': 'no',
      },
    },
  ],
};
