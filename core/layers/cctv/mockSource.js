// Dev-only mock CCTV source: a small fixed set of cameras with generated
// placeholder "stream" images (a real deployment would use public snapshot URLs).
// Dev-gated + dynamic-imported. No real footage, and never any analysis of it.

const CAMERAS = [
  { id: 'cam-1', name: 'Downtown & 5th', lon: -122.4194, lat: 37.7749, heading: 60 },
  { id: 'cam-2', name: 'Harbor Bridge', lon: -74.006, lat: 40.7128, heading: 210 },
  { id: 'cam-3', name: 'Ring Road N', lon: 2.3522, lat: 48.8566, heading: 300 },
  { id: 'cam-4', name: 'Motorway M1', lon: 139.6917, lat: 35.6895, heading: 120 },
  { id: 'cam-5', name: 'Port Approach', lon: 151.2093, lat: -33.8688, heading: 15 },
];

function placeholderImage(label, hue) {
  const c = document.createElement('canvas');
  c.width = 160;
  c.height = 90;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 90);
  grad.addColorStop(0, `hsl(${hue}, 40%, 45%)`);
  grad.addColorStop(1, `hsl(${hue}, 45%, 18%)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 160, 90);
  g.strokeStyle = 'rgba(255,255,255,0.15)';
  for (let y = 60; y < 90; y += 6) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(160, y - 20);
    g.stroke();
  }
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.fillRect(0, 0, 160, 16);
  g.fillStyle = '#e8f1ff';
  g.font = '11px monospace';
  g.fillText(`● LIVE  ${label}`, 6, 12);
  g.strokeStyle = 'rgba(255,255,255,0.35)';
  g.strokeRect(0.5, 0.5, 159, 89);
  return c;
}

export function createCctvMockSource() {
  return async () =>
    CAMERAS.map((cam, i) => ({
      ...cam,
      image: placeholderImage(cam.name, (i * 67) % 360),
    }));
}
