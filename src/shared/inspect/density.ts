/**
 * Row density, measured the same way by the preview and by the inspect tool.
 *
 * A file's rows are not all the same length — a CSV's ids and notes grow as the file goes
 * on — so the only honest estimate is an average over windows spread across the file,
 * and the spread between those windows is what says how much a byte offset can be trusted.
 */

/** One probe: rows counted in a byte window. */
export interface DensityProbe {
  readonly rows: number
  readonly bytes: number
}

/** Probes that actually saw complete rows. */
function usable(probes: readonly DensityProbe[]): DensityProbe[] {
  return probes.filter(probe => probe.rows > 0 && probe.bytes > 0)
}

/**
 * Rows per byte, averaged over the probes.
 * @param probes - one per sampled window, in file order.
 */
export function rowsPerByte(probes: readonly DensityProbe[]): number {
  const seen = usable(probes)
  if (seen.length === 0) return 0
  return seen.reduce((sum, probe) => sum + probe.rows / probe.bytes, 0) / seen.length
}

/**
 * Bytes one row takes on average.
 * @param probes - one per sampled window.
 */
export function bytesPerRow(probes: readonly DensityProbe[]): number {
  const density = rowsPerByte(probes)
  return density > 0 ? 1 / density : 1
}

/**
 * Rows a file of `size` bytes holds at this density; never less than one.
 * @param size - file size in bytes.
 * @param probes - one per sampled window.
 */
export function rowsAt(size: number, probes: readonly DensityProbe[]): number {
  const density = rowsPerByte(probes)
  if (density <= 0) return Math.max(1, Math.round(size))
  return Math.max(1, Math.round(size * density))
}

/** Shortest and longest average row seen, in bytes. */
export function rowLengthRange(probes: readonly DensityProbe[]): { readonly min: number, readonly max: number } {
  const seen = usable(probes)
  if (seen.length === 0) return { min: 0, max: 0 }
  const lengths = seen.map(probe => probe.bytes / probe.rows)
  return { min: Math.min(...lengths), max: Math.max(...lengths) }
}

/**
 * How much the probes disagree: the longest average row over the shortest. 1 means
 * uniform; 1.2 means rows are 20 % longer somewhere, so a byte offset infers rows to ±20 %.
 * @param probes - one per sampled window.
 */
export function densitySpread(probes: readonly DensityProbe[]): number {
  const range = rowLengthRange(probes)
  if (range.min <= 0) return 1
  return range.max / range.min
}
