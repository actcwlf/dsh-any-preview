/**
 * Window arithmetic for a row-windowed table.
 *
 * Rows have a fixed height, so `scrollTop` maps to a row index exactly; only the window's
 * *content* has to be read. Keeping this arithmetic pure makes the two-tier loading easy to
 * test: which window is needed, what it must cover, and what to paint while it is missing.
 *
 * Nothing here knows about delimiters or columns beyond "a row is a list of cells"; a log
 * row is simply one cell.
 */
import { toFileRow } from './row-numbering.ts'

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
 * Scroll geometry for a file too tall to position row by row.
 *
 * An element's scroll height stops growing near 2^24 px, so a table past about 727,000
 * rows at 22px cannot map its scrollbar to rows one-to-one any more. Shrinking the rows
 * to fit would make the text unreadable (and a table row cannot be shorter than its line
 * box), so the table keeps its natural row height and the *scrollbar* becomes
 * proportional: the content is a fixed-height spacer, and a scroll position selects a
 * row instead of a pixel offset. The file's end stays reachable and the row numbers stay
 * exact; the content moves `rowHeight / pitch` pixels per scrolled pixel, which is the
 * trade-off this mode is for.
 * @param bodyRows - body rows in the table (header excluded).
 * @param viewportHeight - visible height in pixels.
 * @param rowHeight - natural height of one row in pixels.
 * @param limitPx - the scroll height the browser will honour.
 */
export interface ProportionalGeometry {
  /** Height the scroller's content gets; fixed, and inside the browser's cap. */
  readonly contentHeight: number
  /** Scrollable distance in pixels. */
  readonly maxScroll: number
  /** Scroll pixels per body row. */
  readonly pitch: number
  /** Body rows that fit in the viewport at the natural height. */
  readonly visibleRows: number
}

/**
 * Compute the proportional scroller's geometry.
 *
 * The header occupies the top of the viewport but the rows start below it, so only the
 * part of the viewport a header does not cover can hold whole rows. Leaving it out put
 * the last screen one row too low: at full scroll the final row was clipped by the
 * header's height and the viewport showed it half-cut.
 * @param bodyRows - body rows in the table (header excluded).
 * @param viewportHeight - visible height in pixels.
 * @param rowHeight - natural height of one row in pixels.
 * @param limitPx - the scroll height the browser will honour.
 * @param headerHeight - pixels the header covers at the top of the viewport.
 */
export function proportionalGeometry(
  bodyRows: number,
  viewportHeight: number,
  rowHeight: number,
  limitPx: number,
  headerHeight = 0,
): ProportionalGeometry {
  const contentHeight = Math.max(viewportHeight + 1, limitPx)
  const rowsHeight = Math.max(0, viewportHeight - Math.max(0, headerHeight))
  const visibleRows = Math.max(1, Math.floor(rowsHeight / rowHeight))
  const maxScroll = Math.max(0, contentHeight - viewportHeight)
  // The last screen must be reachable: progress 1 has to land on row `bodyRows - visibleRows`.
  const travel = Math.max(1, bodyRows - visibleRows)
  return { contentHeight, maxScroll, pitch: maxScroll / travel, visibleRows }
}

/**
 * Body row a scroll offset asks for, as a fraction: the pinned window uses the integer
 * part as its top row and the fraction as the pixel shift that keeps motion smooth.
 * @param scrollTop - scroller offset in pixels.
 * @param geometry - geometry for this table.
 * @param bodyRows - body rows in the table (header excluded).
 */
export function logicalRow(scrollTop: number, geometry: ProportionalGeometry, bodyRows: number): number {
  if (geometry.maxScroll <= 0) return 0
  const progress = Math.min(1, Math.max(0, scrollTop / geometry.maxScroll))
  return progress * Math.max(0, bodyRows - geometry.visibleRows)
}

/** Rows the pinned window paints, and how far up its block is shifted. */
export interface StickyBand {
  /** First painted body row. */
  readonly first: number
  /** Rows painted, clamped to the table. */
  readonly count: number
  /** Pixels the block is translated up by, so the fractional row lines up. */
  readonly offset: number
}

/**
 * Place the pinned band for one logical scroll position.
 * @param logicalTop - body row at the viewport's top, as a fraction.
 * @param bodyRows - body rows in the table (header excluded).
 * @param visibleRows - body rows the viewport shows.
 * @param rowHeight - natural height of one row in pixels.
 * @param overscan - extra rows painted above and below.
 */
export function stickyBand(
  logicalTop: number,
  bodyRows: number,
  visibleRows: number,
  rowHeight: number,
  overscan: number,
): StickyBand {
  const top = Math.min(Math.max(0, bodyRows - visibleRows), Math.max(0, logicalTop))
  const base = Math.floor(top)
  const fraction = top - base
  const first = Math.max(0, base - overscan)
  const count = Math.max(0, Math.min(bodyRows - first, visibleRows + (base - first) + overscan + 1))
  return { first, count, offset: (base - first) * rowHeight + fraction * rowHeight }
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
 * Take rows `[first, last)` out of one read window.
 * @param read - rows the window returned, file row `startRow` first.
 * @param startRow - file row the window starts at.
 * @param first - first body row wanted.
 * @param last - one past the last body row wanted.
 * @param loading - true when the window has not been read yet.
 * @param columns - width of the header.
 */
export function bandRows(
  read: readonly (readonly string[])[],
  startRow: number,
  first: number,
  last: number,
  loading: boolean,
  columns: number,
): BodyRow[] {
  const rows: BodyRow[] = []
  for (let index = first; index < last; index += 1) {
    // Body row `i` is file row `i + 1` and lives that far into the read rows.
    const offset = toFileRow(index) - startRow
    const cells = loading || offset < 0 || offset >= read.length ? null : fitColumns(read[offset] ?? [], columns)
    rows.push({ index, cells })
  }
  return rows
}

/**
 * Paint the rows a viewport shows out of one read window, positioned by index.
 *
 * Only used while the table is short enough for exact positions; the filler above and
 * below keeps the scrollbar the length of the whole file, so a 300,000-row table still
 * costs one screen of elements.
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
  const bodyRows = Math.max(0, totalRows - 1)
  return {
    rows: bandRows(read, startRow, slice.first, slice.last, loading, columns),
    topPad: slice.first * rowHeight,
    bottomPad: Math.max(0, bodyRows - slice.last) * rowHeight,
  }
}
