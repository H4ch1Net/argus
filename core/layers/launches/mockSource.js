// Dev / demo-only launches: an LL2-shaped payload with a few simulated launches
// around real pad locations, relative to now, so the layer works offline.

const PADS = [
  { id: 1, name: 'Demo pad (Cape Canaveral)', latitude: 28.56, longitude: -80.58 },
  { id: 2, name: 'Demo pad (Vandenberg)', latitude: 34.63, longitude: -120.61 },
  { id: 3, name: 'Demo pad (Baikonur)', latitude: 45.92, longitude: 63.34 },
  { id: 4, name: 'Demo pad (Kourou)', latitude: 5.24, longitude: -52.77 },
];

export function createLaunchMockSource() {
  return async () => {
    const now = Date.now();
    const at = (h) => new Date(now + h * 3600_000).toISOString();
    const launch = (i, pad, h, abbrev) => ({
      id: `demo-${i}`,
      name: `Demo Rocket | Demo Mission ${i}`,
      net: at(h),
      status: { name: abbrev === 'Go' ? 'Go for Launch' : abbrev, abbrev },
      launch_service_provider: { name: 'Demo Launch Co. (simulated)' },
      rocket: { configuration: { full_name: 'Demo Rocket' } },
      mission: { name: `Demo Mission ${i}`, orbit: { name: 'Low Earth Orbit' } },
      pad,
    });
    return {
      demo: true,
      results: [
        launch(1, PADS[0], -50, 'Success'),
        launch(2, PADS[0], 6, 'Go'),
        launch(3, PADS[1], 72, 'Go'),
        launch(4, PADS[2], 200, 'TBD'),
        launch(5, PADS[3], -120, 'Success'),
      ],
    };
  };
}
