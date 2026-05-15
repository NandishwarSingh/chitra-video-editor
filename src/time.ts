export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function formatClock(totalSeconds: number) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return '00:00.00';
  }

  // Round to the nearest centisecond first, then carry into seconds/minutes.
  // Working in pure-integer "totalCentiseconds" space avoids the binary float
  // drift that made `1.7999999999` truncate to `1.79` instead of rounding
  // up to `1.80`.
  let totalCentis = Math.round(totalSeconds * 100);
  const centiseconds = totalCentis % 100;
  totalCentis = (totalCentis - centiseconds) / 100;
  const seconds = totalCentis % 60;
  const minutes = (totalCentis - seconds) / 60;

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(
    centiseconds,
  ).padStart(2, '0')}`;
}

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;

  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}
