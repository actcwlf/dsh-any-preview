/**
 * Window arithmetic for the CSV table.
 *
 * Rows have a fixed height, so `scrollTop` maps to a row index exactly; only the window's
 * *content* has to be read. Keeping this arithmetic pure makes the two-tier loading easy to
 * test: which window is needed, what it must cover, and what to paint while it is missing.
 */

/** Which rows a viewport needs. */
export interface WindowPlan {
  /** First row to read: the start of the aligned window. */
  readonly start: number
  /** Rows to read, always the whole window plus the band below it. */
  readonly count: number
  /** Window number, used as the cache key. */
  readonly window: number
  /** Row the cache lookup starts at, aligned to the window grid. */
  readonly alignedStart: number
}

/** Rows read past the viewport below it, so a short drag stays inside one window. */
export const DEFAULT_OVERSCAN = 40

/**
 * Compute the window a viewport needs.
 *
 * The window that holds the viewport's first row is the cache unit, so the read covers
 * that whole window *and* the band the viewport can reach past its end. A read sized only
 * to the viewport would be cached for the window and then fall short everywhere else in
 * that window, which reads as blank rows.
 * @param scrollTop - scroller offset in pixels.
 * @param viewportHeight - visible height in pixels.
 * @param rowHeight - fixed row height in pixels.
 * @param windowSize - rows per cached window.
 * @param totalRows - known or estimated row count, used for clamping.
 * @param overscan - extra rows read below the viewport.
 */
export function planWindow(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  windowSize: number,
  totalRows: number,
  overscan = DEFAULT_OVERSCAN,
): WindowPlan {
  const firstVisible = Math.floor(Math.max(0, scrollTop) / rowHeight)
  const visibleCount = Math.ceil(Math.max(0, viewportHeight) / rowHeight) + 1
  const window = Math.max(0, Math.floor(firstVisible / windowSize))
  const alignedStart = window * windowSize
  const count = Math.max(0, Math.min(totalRows - alignedStart, windowSize + visibleCount + overscan))
  return { start: alignedStart, count, window, alignedStart }
}

/**
 * How many windows the cache should keep: enough to make a short drag back instant.
 * @param windowSize - rows per window.
 */
export function cacheCapacity(windowSize: number): number {
  // 32 windows of 5,000 rows is 160,000 rows retained, bounded regardless of file size.
  return Math.max(4, Math.min(32, Math.floor(160_000 / Math.max(1, windowSize))))
}

/**
 * Row height for a table of `rows` body rows.
 *
 * An element's scroll height stops growing near 2^24 px in current browsers, so past
 * about 762,000 rows at 22px the rows shrink proportionally: the scrollbar then still
 * spans the real row count and the file's end stays reachable. Below the cap the height
 * is exactly `rowHeight`, so ordinary files are not scaled at all.
 * @param rows - body rows in the table.
 * @param rowHeight - natural height of one row in pixels.
 * @param limitPx - the scroll height the browser will honour.
 * @param minHeight - floor, so a huge table does not collapse to a hairline.
 */
export function scaledRowHeight(rows: number, rowHeight: number, limitPx: number, minHeight: number): number {
  const natural = rows * rowHeight
  if (rows <= 0 || natural <= limitPx) return rowHeight
  return Math.max(minHeight, (limitPx / natural) * rowHeight)
}

/** One painted row: its body index and its cells, or no cells while loading. */
export interface BodyRow {
  readonly index: number
  readonly cells: readonly string[] | null
}

/** Rows a windowed table paints, plus the filler that holds the scrollbar's length. */
export interface WindowedBody {
  readonly rows: readonly BodyRow[]
  readonly topPad: number
  readonly bottomPad: number
}

/**
 * Pad a windowed row to the header's width so the grid stays aligned. A row with more
 * fields than the header keeps them: a column of data is never dropped, even when the
 * header was decided from the rows that had already arrived.
 * @param row - cells of one row.
 * @param columns - width of the header.
 */
export function fitColumns(row: readonly string[], columns: number): readonly string[] {
  return row.length >= columns ? row : [...row, ...Array<string>(columns - row.length).fill('')]
}

/**
 * Paint the rows a viewport shows out of one read window.
 *
 * File row 0 is the header, which the table draws once above its body, so body row `i`
 * is file row `i + 1` and lives at `i + 1 - startRow` inside the read rows. Only the
 * viewport band is painted; the filler above and below keeps the scrollbar the length of
 * the whole file, so a 300,000-row table still costs one screen of elements.
 * @param read - rows the window returned, file row `startRow` first.
 * @param startRow - file row the window starts at.
 * @param totalRows - file rows known so far, header included.
 * @param slice - body rows to paint, `[first, last)`.
 * @param rowHeight - height of one row in pixels.
 * @param loading - true when the window has not been read yet.
 * @param columns - width of the header.
 */
export function windowedBodyRows(
  read: readonly (readonly string[])[],
  startRow: number,
  totalRows: number,
  slice: { readonly first: number, readonly last: number },
  rowHeight: number,
  loading: boolean,
  columns: number,
): WindowedBody {
  const rows: BodyRow[] = []
  for (let index = slice.first; index < slice.last; index += 1) {
    const offset = index + 1 - startRow
    const cells = loading || offset < 0 || offset >= read.length ? null : fitColumns(read[offset] ?? [], columns)
    rows.push({ index, cells })
  }
  const bodyRows = Math.max(0, totalRows - 1)
  return {
    rows,
    topPad: slice.first * rowHeight,
    bottomPad: Math.max(0, bodyRows - slice.last) * rowHeight,
  }
}
