// Navigation readouts in the ctOS style: upper case, rounded the way a driver
// reads them (a turn "350 M" away, not 347). Pure: the panels, the car and the
// terminal share it.

const M_PER_MI = 1609.344;
const M_PER_FT = 0.3048;

/**
 * A distance for the turn banner and the strip: metres in 10s under 100 m,
 * 50s under 1 km, then 0.1 km to 10 km and whole km past it; imperial in feet
 * (50s) under 0.1 mi, then 0.1 mi, then whole miles. Nautical units read as
 * metric on the road.
 */
export function formatNavDistance(m, units = 'metric') {
  if (!Number.isFinite(m) || m < 0) return '--';
  if (units === 'imperial') {
    if (m < M_PER_MI * 0.1)
      return `${Math.max(0, Math.round(m / M_PER_FT / 50) * 50)} FT`;
    const mi = m / M_PER_MI;
    return mi < 10 ? `${mi.toFixed(1)} MI` : `${Math.round(mi)} MI`;
  }
  if (m < 100) return `${Math.round(m / 10) * 10} M`;
  if (m < 1000) return `${Math.min(1000, Math.round(m / 50) * 50)} M`;
  return m < 10_000 ? `${(m / 1000).toFixed(1)} KM` : `${Math.round(m / 1000)} KM`;
}

/** "45 S", "12 MIN", "1 H 05". */
export function formatNavDuration(s) {
  if (!Number.isFinite(s) || s < 0) return '--';
  if (s < 60) return `${Math.round(s)} S`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} MIN`;
  return `${Math.floor(min / 60)} H ${String(min % 60).padStart(2, '0')}`;
}

/** "+4 MIN" for a delay, "" when under half a minute. */
export function formatDelay(s) {
  if (!Number.isFinite(s) || s < 30) return '';
  return `+${formatNavDuration(s)}`;
}

/** Local wall-clock time of an epoch ms, "14:32". */
export function formatClock(ms, date = new Date(ms)) {
  if (!Number.isFinite(ms)) return '--:--';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * One line per route for the preview list:
 * { eta, duration, distance, delay, signals, via } as strings.
 * `now` is the departure time (epoch ms).
 */
export function routeFacts(route, { now = Date.now(), units = 'metric' } = {}) {
  const total = (route?.durationS ?? 0) + (route?.signalDelayS ?? 0);
  return {
    eta: formatClock(now + total * 1000),
    duration: formatNavDuration(total),
    distance: formatNavDistance(route?.distanceM ?? NaN, units),
    delay: formatDelay(route?.trafficDelayS),
    signals: Number.isFinite(route?.signals) ? String(route.signals) : '',
    via: String(route?.summary ?? '').toUpperCase(),
  };
}
