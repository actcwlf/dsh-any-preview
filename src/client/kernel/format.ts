/** Byte formatting shared by the formats that show a size. */

/**
 * Format a byte count for display.
 * @param bytes - size in bytes; absent or invalid yields an empty string.
 * @returns a short human-readable size (`512 B`, `4.2 KB`, `36 MB`).
 */
export function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${String(Math.trunc(bytes))} B`
  const units = ['KB', 'MB', 'GB', 'TB'] as const
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]!}`
}
