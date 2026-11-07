/** Pure CSV A2 matcher: occurrences inside cells, results as rows. */
import { forEachMatch } from '../../kernel/search.ts'
import type { MatchRange, SearchOccurrence } from '../../kernel/search.ts'

/** Occurrences kept for navigation; the total count is always complete. */
export const CSV_OCCURRENCE_LIMIT = 5_000

/** The result of matching one CSV body. */
export interface CsvSearchResult {
  readonly pattern: RegExp | undefined
  /** Body rows that contain at least one occurrence, in file order. */
  readonly rows: readonly number[]
  /** First occurrences, capped for navigation. */
  readonly occurrences: readonly SearchOccurrence[]
  /** Total occurrences, including those beyond the navigation cap. */
  readonly total: number
}

/** Empty result with a stable shape. */
export const EMPTY_CSV_SEARCH: CsvSearchResult = {
  pattern: undefined,
  rows: [],
  occurrences: [],
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
  let total = 0
  for (let row = 0; row < rows.length; row += 1) {
    let matched = false
    const cells = rows[row] ?? []
    for (let cell = 0; cell < cells.length; cell += 1) {
      const count = forEachMatch(cells[cell] ?? '', pattern, (range: MatchRange) => {
        total += 1
        if (occurrences.length < limit) occurrences.push({ row, cell, ...range })
      })
      if (count > 0) matched = true
    }
    if (matched) matching.push(row)
  }
  return { pattern, rows: matching, occurrences, total }
}
