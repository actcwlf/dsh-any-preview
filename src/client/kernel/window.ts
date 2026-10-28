/**
 * Window arithmetic for fixed-height row lists.
 *
 * Kept out of the component so the edge cases — an empty list, a viewport taller
 * than the data, a scroll position past the end, the last partial screen — are
 * testable without a DOM.
 */

/** Geometry of one windowed list. */
export interface WindowInput {
  /** Current scroll offset in pixels. */
  readonly scrollTop: number
  /** Visible height in pixels; 0 before the element is measured. */
  readonly viewportHeight: number
  /** Number of rows available after filtering. */
  readonly rowCount: number
  /** Fixed height of one row in pixels. */
  readonly rowHeight: number
  /** Extra rows rendered above and below the viewport. */
  readonly overscan?: number
}

/** Which rows to render, and how much filler to keep above and below. */
export interface WindowRange {
  /** First rendered row (inclusive). */
  readonly first: number
  /** Last rendered row (exclusive). */
  readonly last: number
  /** Pixel height of the filler above the rendered rows. */
  readonly topPad: number
  /** Pixel height of the filler below the rendered rows. */
  readonly bottomPad: number
}

/**
 * Compute the rows a fixed-height list should render.
 * @param input - scroll geometry and row count.
 * @returns the half-open row range plus filler heights.
 */
export function windowRange(input: WindowInput): WindowRange {
  const { scrollTop, viewportHeight, rowCount, rowHeight } = input
  const overscan = input.overscan ?? 0
  if (rowCount <= 0 || rowHeight <= 0) return { first: 0, last: 0, topPad: 0, bottomPad: 0 }

  const clampedTop = Math.max(0, scrollTop)
  const visibleFirst = Math.floor(clampedTop / rowHeight)
  const visibleLast = Math.ceil((clampedTop + Math.max(0, viewportHeight)) / rowHeight)
  const first = Math.min(rowCount, Math.max(0, visibleFirst - overscan))
  const last = Math.min(rowCount, Math.max(first, visibleLast + overscan))

  return {
    first,
    last,
    topPad: first * rowHeight,
    bottomPad: (rowCount - last) * rowHeight,
  }
}
