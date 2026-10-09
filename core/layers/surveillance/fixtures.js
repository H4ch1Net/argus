// Real Overpass answers for the surveillance query (./parse.js), trimmed for
// the tests: a handful of elements each, and tags the layer does not read
// removed. Fetched 2026-10-09 from the OSM Overpass mirrors (overpass.kumi.systems
// for Atlanta and San Francisco, maps.mail.ru for Paris). Atlanta: Flock and
// Genetec ALPR readers and Flock Raven gunshot detectors (DeFlock's mapping);
// San Francisco: dome, PTZ and fixed cameras, a toll gantry, a guard post;
// central Paris: speed cameras and the enforcement relations whose "device"
// members they are, in the order Overpass returns them (devices twice).

/** man_made=surveillance nodes, Atlanta (33.70,-84.45,33.85,-84.30) and SF. */
export const ATLANTA_SF = {
  elements: [
    {
      type: 'node',
      id: 5059352113,
      lat: 33.7815621,
      lon: -84.3841495,
      tags: {
        'camera:mount': 'traffic_signals',
        'camera:type': 'fixed',
        direction: '165',
        man_made: 'surveillance',
        manufacturer: 'Flock Safety',
        'manufacturer:wikidata': 'Q108485435',
        'surveillance:type': 'ALPR',
      },
    },
    {
      type: 'node',
      id: 12463726485,
      lat: 33.7827302,
      lon: -84.4174,
      tags: {
        'camera:mount': 'pole',
        'camera:type': 'fixed',
        direction: '170',
        man_made: 'surveillance',
        manufacturer: 'Flock Safety',
        'manufacturer:wikidata': 'Q108485435',
        surveillance: 'public',
        'surveillance:type': 'ALPR',
        'surveillance:zone': 'traffic',
      },
    },
    {
      type: 'node',
      id: 13203032257,
      lat: 33.757911,
      lon: -84.393667,
      tags: {
        'camera:type': 'fixed',
        direction: '200',
        man_made: 'surveillance',
        manufacturer: 'Genetec',
        'manufacturer:wikidata': 'Q30295174',
        'surveillance:type': 'ALPR',
      },
    },
    {
      type: 'node',
      id: 13328961401,
      lat: 33.8299392,
      lon: -84.3875794,
      tags: {
        brand: 'Flock Safety',
        'brand:wikidata': 'Q108485435',
        man_made: 'surveillance',
        surveillance: 'public',
        'surveillance:type': 'gunshot_detector',
      },
    },
    {
      type: 'node',
      id: 13346581001,
      lat: 33.7765439,
      lon: -84.3949225,
      tags: {
        brand: 'Flock Safety',
        'brand:wikidata': 'Q108485435',
        man_made: 'surveillance',
        name: 'Raven',
        surveillance: 'public',
        'surveillance:type': 'gunshot_detector',
      },
    },
    {
      type: 'node',
      id: 708463495,
      lat: 37.7713397,
      lon: -122.3986395,
      tags: {
        'camera:mount': 'building',
        'camera:type': 'dome',
        man_made: 'surveillance',
        surveillance: 'public',
        'surveillance:type': 'camera',
        'surveillance:zone': 'public',
      },
    },
    {
      type: 'node',
      id: 2801122357,
      lat: 37.7752639,
      lon: -122.4701831,
      tags: {
        'camera:mount': 'building',
        'camera:type': 'panning',
        man_made: 'surveillance',
        surveillance: 'public',
        'surveillance:type': 'camera',
        'surveillance:zone': 'street',
      },
    },
    {
      type: 'node',
      id: 14020916321,
      lat: 37.7817645,
      lon: -122.3897461,
      tags: {
        'camera:mount': 'wall',
        'camera:type': 'panorama_with_ptz',
        man_made: 'surveillance',
        surveillance: 'outdoor',
        'surveillance:type': 'camera',
        'surveillance:zone': 'entrance',
      },
    },
    {
      type: 'node',
      id: 65374006,
      lat: 37.8071685,
      lon: -122.475654,
      tags: {
        'camera:type': 'fixed',
        highway: 'toll_gantry',
        man_made: 'surveillance',
        name: 'Golden Gate Bridge Automated Toll Plaza',
        operator: 'Golden Gate Bridge Highway and Transportation District',
        'operator:wikidata': 'Q5579434',
        surveillance: 'public',
        'surveillance:type': 'ALPR',
        'surveillance:zone': 'traffic',
      },
    },
    {
      type: 'node',
      id: 10869399691,
      lat: 37.7632843,
      lon: -122.481017,
      tags: {
        man_made: 'surveillance',
        surveillance: 'public',
        'surveillance:type': 'guard',
        'surveillance:zone': 'entrance',
      },
    },
    {
      type: 'node',
      id: 1607241531,
      lat: 37.7825584,
      lon: -122.3941002,
      tags: {
        'camera:direction': '240',
        'camera:mount': 'wall',
        'camera:type': 'fixed',
        man_made: 'surveillance',
        surveillance: 'public',
        'surveillance:type': 'camera',
        'surveillance:zone': 'entrance',
      },
    },
  ],
};

/** highway=speed_camera nodes, their devices again, then type=enforcement relations. */
export const PARIS_ENFORCEMENT = {
  elements: [
    {
      type: 'node',
      id: 414997089,
      lat: 48.8791473,
      lon: 2.3474694,
      tags: {
        highway: 'speed_camera',
        maxspeed: '30',
      },
    },
    {
      type: 'node',
      id: 1160275695,
      lat: 48.8537201,
      lon: 2.3564387,
      tags: {
        enforcement: 'maxspeed',
        highway: 'speed_camera',
        maxspeed: '30',
        type: 'enforcement',
      },
    },
    {
      type: 'node',
      id: 1160283849,
      lat: 48.8658546,
      lon: 2.3540003,
      tags: {
        highway: 'speed_camera',
        maxspeed: '50',
      },
    },
    {
      type: 'node',
      id: 6773693244,
      lat: 48.8471533,
      lon: 2.3606575,
      tags: {
        enforcement: 'maxspeed',
        highway: 'speed_camera',
        maxspeed: '30',
        type: 'enforcement',
      },
    },
    {
      type: 'node',
      id: 7128024105,
      lat: 48.8603182,
      lon: 2.3327979,
      tags: {
        enforcement: 'traffic_signals',
        highway: 'speed_camera',
        maxspeed: '50',
        type: 'enforcement',
      },
    },
    {
      type: 'node',
      id: 414997089,
      lat: 48.8791473,
      lon: 2.3474694,
      tags: {
        highway: 'speed_camera',
        maxspeed: '30',
      },
    },
    {
      type: 'node',
      id: 1160275695,
      lat: 48.8537201,
      lon: 2.3564387,
      tags: {
        enforcement: 'maxspeed',
        highway: 'speed_camera',
        maxspeed: '30',
        type: 'enforcement',
      },
    },
    {
      type: 'node',
      id: 1160283849,
      lat: 48.8658546,
      lon: 2.3540003,
      tags: {
        highway: 'speed_camera',
        maxspeed: '50',
      },
    },
    {
      type: 'node',
      id: 2211556513,
      lat: 48.8569116,
      lon: 2.3485663,
      tags: {
        enforcement: 'check',
      },
    },
    {
      type: 'relation',
      id: 151744,
      members: [
        {
          type: 'node',
          ref: 414997089,
          role: 'device',
        },
        {
          type: 'node',
          ref: 414997090,
          role: 'to',
        },
        {
          type: 'node',
          ref: 414997472,
          role: 'from',
        },
      ],
      tags: {
        enforcement: 'maxspeed',
        maxspeed: '30',
        name: 'Paris 9e - Rue de Maubeuge',
        type: 'enforcement',
      },
    },
    {
      type: 'relation',
      id: 1230740,
      members: [
        {
          type: 'node',
          ref: 2211556513,
          role: 'device',
        },
        {
          type: 'node',
          ref: 676872460,
          role: 'from',
        },
        {
          type: 'node',
          ref: 3980067636,
          role: 'force',
        },
        {
          type: 'node',
          ref: 644160,
          role: 'to',
        },
      ],
      tags: {
        enforcement: 'traffic_signals',
        name: 'Paris - Quai de Gesvres',
        type: 'enforcement',
      },
    },
    {
      type: 'relation',
      id: 1434727,
      members: [
        {
          type: 'node',
          ref: 1160275695,
          role: 'device',
        },
        {
          type: 'node',
          ref: 1160275685,
          role: 'to',
        },
        {
          type: 'node',
          ref: 4877380022,
          role: 'from',
        },
      ],
      tags: {
        enforcement: 'maxspeed',
        maxspeed: '30',
        name: "Paris - Quai de l'Hôtel de Ville",
        type: 'enforcement',
      },
    },
    {
      type: 'relation',
      id: 1434737,
      members: [
        {
          type: 'node',
          ref: 1160283849,
          role: 'device',
        },
        {
          type: 'node',
          ref: 1160283808,
          role: 'to',
        },
        {
          type: 'node',
          ref: 1160283855,
          role: 'from',
        },
        {
          type: 'node',
          ref: 244131552,
          role: 'from',
        },
      ],
      tags: {
        enforcement: 'maxspeed',
        maxspeed: '50',
        name: 'Paris - Rue Réaumur',
        type: 'enforcement',
      },
    },
  ],
};
