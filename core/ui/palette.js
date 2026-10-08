// The ctOS map palette (design/ctos). Map data draws in grays plus the Mono
// Glow terminal teals and mint, so the globe reads like the rest of the UI.
// Green and red are state colours only: green for live / verified / locked,
// red for hazards and critical severity (an active fire, an M6+ quake, an
// attack arc). Neither is ever decoration.
//
// Plain CSS strings, no Cesium: definitions wrap them with
// Cesium.Color.fromCssColorString, the DOM and the overlay canvas use them as is.

export const INK = Object.freeze({
  white: '#ffffff', // textPrimary
  gray: '#d9d9d9', // ctosGray (chrome)
  dim: '#cacaca', // textPrimaryDim
  dimmer: '#c3c3c3', // textPrimaryDimmer
  muted: '#7a7a7a', // textSecondary
  slate: '#708090', // term-url / ansi9
  pale: '#deeeed', // ansi1
  teal: '#66b2b2', // ansi5
  cyan: '#49c4c4', // ansi13
  mint: '#a6ffc9', // ansi10
  success: '#00fa9a',
  error: '#fc3e38',
  ground: '#0e0e0e', // background
  raised: '#202020', // backgroundBright
});

/** One colour per layer key, for markers, legends and menu tiles. */
export const LAYER_INK = Object.freeze({
  flights: INK.white,
  military: INK.mint,
  localadsb: INK.pale,
  satellites: INK.dimmer,
  constellations: INK.slate,
  launches: INK.white,
  transit: INK.teal,
  bikeshare: INK.muted,
  ships: INK.cyan,
  quakes: INK.gray,
  fires: INK.error,
  cyclones: INK.white,
  clouds: INK.dimmer,
  radar: INK.cyan,
  lightning: INK.white,
  surveillance: INK.gray,
  landmarks: INK.dimmer,
  cctv: INK.white,
  trafficcams: INK.teal,
  datacenters: INK.cyan,
  cables: INK.slate,
  installations: INK.mint,
  radio: INK.teal,
  shodan: INK.gray,
  threats: INK.error,
  bgp: INK.cyan,
  goes: INK.dimmer,
  cyclonecones: INK.white,
  cyclonetracks: INK.white,
  perimeters: INK.error,
  dams: INK.teal,
  imagery: INK.dimmer,
  trafficflow: INK.teal,
  wind: INK.gray,
});

/** Layer ink by key, falling back to ctosGray for layers added later. */
export const inkFor = (key) => LAYER_INK[key] ?? INK.gray;
