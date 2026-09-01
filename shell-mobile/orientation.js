// Map a DeviceOrientation reading to a Cesium camera aim (degrees). Pure, so the
// mapping is testable without a real sensor; the precise feel still needs a real
// device (see the compass controller). Convention: portrait viewfinder, where
// holding the phone vertical looks at the horizon and tilting the top back looks
// toward the zenith.

/**
 * @param {{ alpha?: number, beta?: number, gamma?: number, webkitCompassHeading?: number }} event
 * @param {number} [screenAngle] screen.orientation.angle (0/90/180/270)
 * @returns {{ heading: number, pitch: number, roll: number }}
 */
export function deviceToCamera(event, screenAngle = 0) {
  // Heading: iOS gives a true compass heading directly; elsewhere alpha is a
  // counter-clockwise yaw, so convert to a clockwise-from-north compass heading.
  const compass =
    typeof event.webkitCompassHeading === 'number'
      ? event.webkitCompassHeading
      : (360 - (event.alpha ?? 0)) % 360;
  const heading = (((compass + screenAngle) % 360) + 360) % 360;

  // Pitch: beta 90 (phone vertical) = horizon; toward 180 (tilting back) = up.
  const pitch = Math.max(-90, Math.min(90, (event.beta ?? 90) - 90));

  return { heading, pitch, roll: 0 };
}
