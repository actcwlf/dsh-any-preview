/** Pure CSV A2 matcher: occurrences inside cells, results as rows. */
import { forEachMatch, SEARCH_PAGE_SIZE } from '../../kernel/search.ts'
import type { MatchRange, SearchOccurrence } from '../../kernel/search.ts'

/** Occurrences kept for navigation; the total count is always complete. */
export const CSV_OCCURRENCE_LIMIT = SEARCH_PAGE_SIZE

/** Occurrences kept for navigation in a complete in-memory table. */
export const CSV_LOCAL_LIMIT = 20_000

/** The result of matching one CSV body. */
export interface CsvSearchResult {
  readonly pattern: RegExp | undefined
  /** Body rows that contain at least one occurrence, in file order. */
  readonly rows: readonly number[]
  /** First occurrences, capped for navigation. */
  readonly occurrences: readonly SearchOccurrence[]
  /** First occurrence of each following page, for lazy navigation. */
  readonly pages: readonly SearchOccurrence[]
  /** Total occurrences, including those beyond the navigation cap. */
  readonly total: number
}

/** Empty result with a stable shape. */
export const EMPTY_CSV_SEARCH: CsvSearchResult = {
  pattern: undefined,
  rows: [],
  occurrences: [],
  pages: [],
  total: 0,
}

/**
 * Match cell occurrences across a set of CSV body rows.
 * @param rows - body rows; the header is already excluded.
 * @param pattern - compiled query.
 * @param limit - occurrences to keep for navigation.
 * @returns matching rows, capped occurrences and the complete count.
 */
export function matchCsvRows(
  rows: readonly (readonly string[])[],
  pattern: RegExp,
  limit = CSV_OCCURRENCE_LIMIT,
): CsvSearchResult {
  const matching: number[] = []
  const occurrences: SearchOccurrence[] = []
  const pages: SearchOccurrence[] = []
  let total = 0
  for (let row = 0; row < rows.length; row += 1) {
    let matched = false
    const cells = rows[row] ?? []
    for (let cell = 0; cell < cells.length; cell += 1) {
      const count = forEachMatch(cells[cell] ?? '', pattern, (range: MatchRange) => {
        const occurrence = { row, cell, start: range.start, end: range.end }
        if (total > 0 && total % limit === 0) pages.push(occurrence)
        total += 1
        if (occurrences.length < limit) occurrences.push(occurrence)
      })
      if (count > 0) matched = true
    }
    if (matched) matching.push(row)
  }
  return { pattern, rows: matching, occurrences, pages, total }
}

/** Compare two occurrences in scan order. */
function compareOccurrence(left: SearchOccurrence, right: SearchOccurrence): number {
  if (left.row !== right.row) return left.row - right.row
  if (left.cell !== right.cell) return left.cell - right.cell
  if (left.start !== right.start) return left.start - right.start
  return left.end - right.end
}

/**
 * Collect one page of occurrences at or after `cursor`.
 * @param rows - body rows.
 * @param pattern - compiled query.
 * @param cursor - first occurrence wanted.
 * @param limit - page size.
 * @returns occurrences in file order.
 */
export function matchCsvPage(
  rows: readonly (readonly string[])[],
  pattern: RegExp,
  cursor: SearchOccurrence,
  limit: number,
): SearchOccurrence[] {
  const page: SearchOccurrence[] = []
  for (let row = 0; row < rows.length && page.length < limit; row += 1) {
    const cells = rows[row] ?? []
    for (let cell = 0; cell < cells.length && page.length < limit; cell += 1) {
      let stop = false
      forEachMatch(cells[cell] ?? '', pattern, (range: MatchRange) => {
        if (stop) return
        const occurrence = { row, cell, start: range.start, end: range.end }
        if (compareOccurrence(occurrence, cursor) < 0) return
        page.push(occurrence)
        if (page.length >= limit) stop = true
      })
    }
  }
  return page
}
