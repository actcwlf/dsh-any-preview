/**
 * Window arithmetic for the CSV table.
 *
 * Rows have a fixed height, so `scrollTop` maps to a row index exactly; only the window's
 * *content* has to be read. Keeping this arithmetic pure makes the two-tier loading easy to
 * test: which window is needed, and what to render while it is missing.
 */

/** Which rows a viewport needs. */
export interface WindowPlan {
  /** Zero-based first row that must be read. */
  readonly start: number
  /** Rows to read; includes overscan above and below. */
  readonly count: number
  /** Window number, used as the cache key. */
  readonly window: number
  /** Row the cache lookup starts at, aligned to the window grid. */
  readonly alignedStart: number
}

/** Rows rendered above and below the viewport to cover momentum scrolling. */
export const DEFAULT_OVERSCAN = 40

/**
 * Compute the window a viewport needs.
 * @param scrollTop - scroller offset in pixels.
 * @param viewportHeight - visible height in pixels.
 * @param rowHeight - fixed row height in pixels.
 * @param windowSize - rows per cached window.
 * @param totalRows - known or estimated row count, used for clamping.
 * @param overscan - extra rows above and below.
 */
export function planWindow(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  windowSize: number,
  totalRows: number,
  overscan = DEFAULT_OVERSCAN,
): WindowPlan {
  const firstVisible = Math.floor(scrollTop / rowHeight)
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + 1
  const rawStart = firstVisible - overscan
  const start = Math.max(0, Math.min(rawStart, Math.max(0, totalRows - 1)))
  const alignedStart = Math.max(0, Math.floor(start / windowSize) * windowSize)
  const end = Math.min(totalRows, firstVisible + visibleCount + overscan)
  const count = Math.max(0, Math.min(windowSize, end - alignedStart))
  return { start, count, window: Math.floor(alignedStart / windowSize), alignedStart }
}

/**
 * Placeholder rows for a window that is still loading.
 * @param count - how many rows to stand in for.
 */
export function placeholderRows(count: number): string[][] {
  return Array.from({ length: Math.max(0, count) }, () => [])
}

/**
 * How many windows the cache should keep: enough to make a short drag back instant.
 * @param windowSize - rows per window.
 */
export function cacheCapacity(windowSize: number): number {
  // 32 windows of 5,000 rows is 160,000 rows retained, bounded regardless of file size.
  return Math.max(4, Math.min(32, Math.floor(160_000 / Math.max(1, windowSize))))
}
