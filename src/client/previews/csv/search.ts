/**
 * CSV search: matches are occurrences inside cells, results are rows.
 *
 * This is deliberately CSV-local. The other text previews still use the simpler
 * one-cell row search, because their row model and navigation needs differ.
 */
import { useMemo, useState } from 'react'
import { compileSearch } from '../../kernel/search.ts'
import type { SearchOccurrence, SearchOptions } from '../../kernel/search.ts'
import { parseCsvSlice } from './parse.ts'
import {
  CSV_OCCURRENCE_LIMIT,
  EMPTY_CSV_SEARCH,
  matchCsvRows,
} from './match.ts'
import type { CsvSearchResult } from './match.ts'

export { CSV_OCCURRENCE_LIMIT, EMPTY_CSV_SEARCH, matchCsvRows }
export type { CsvSearchResult }

/** State and navigation for one CSV's local search. */
export interface CsvSearchState {
  readonly pattern: RegExp | undefined
  readonly result: CsvSearchResult
  /** Total occurrences. */
  readonly matches: number
  /** Matching body rows. */
  readonly rows: readonly number[]
  /** Position within the capped occurrence list; -1 when none. */
  readonly index: number
  readonly activeOccurrence: SearchOccurrence | undefined
  readonly activeRow: number | undefined
  readonly next: () => void
  readonly prev: () => void
}

/**
 * Compile and apply the CSV cell matcher, then navigate its occurrences.
 * @param rows - body rows.
 * @param options - query modes.
 * @returns matches, their rows and wrapped occurrence navigation.
 */
export function useCsvSearch(
  rows: readonly (readonly string[])[],
  options: SearchOptions,
): CsvSearchState {
  const pattern = useMemo(
    () => compileSearch(options),
    [options.query, options.regex, options.caseSensitive],
  )
  const result = useMemo(
    () => (pattern === undefined ? EMPTY_CSV_SEARCH : matchCsvRows(rows, pattern)),
    [rows, rows.length, pattern],
  )
  const [active, setActive] = useState(0)
  const count = result.occurrences.length
  const index = result.total === 0 || count === 0 ? -1 : Math.min(active, count - 1)
  const activeOccurrence = index < 0 ? undefined : result.occurrences[index]
  return {
    pattern,
    result,
    matches: result.total,
    rows: result.rows,
    index,
    activeOccurrence,
    activeRow: activeOccurrence?.row,
    next: (): void => {
      if (count > 0) setActive((index + 1) % count)
    },
    prev: (): void => {
      if (count > 0) setActive((index - 1 + count) % count)
    },
  }
}

/** Options for the in-memory CSV scan. */
export interface CsvScanOptions {
  readonly signal: AbortSignal
  readonly from?: number
  readonly lineLimit?: number
  readonly onSlice?: (progress: number, matches: number, occurrences: readonly SearchOccurrence[]) => void
}

/** Result of scanning the delivered CSV text. */
export interface CsvScanResult {
  readonly matches: number
  readonly occurrences: readonly SearchOccurrence[]
  readonly completed: boolean
}

/**
 * Scan the whole delivered CSV by parsing rows and applying the cell matcher.
 * @param text - the complete delivered text.
 * @param pattern - compiled query.
 * @param options - abort and progress hooks.
 * @param delimiter - the detected field separator.
 * @returns occurrence count and the first navigation occurrences.
 */
export async function scanCsvText(
  text: string,
  pattern: RegExp,
  options: CsvScanOptions,
  delimiter: string,
): Promise<CsvScanResult> {
  if (options.signal.aborted) return { matches: 0, occurrences: [], completed: false }
  const parsed = parseCsvSlice(text, delimiter)
  const body = parsed.rows.slice(1)
  const result = matchCsvRows(body, pattern, options.lineLimit ?? CSV_OCCURRENCE_LIMIT)
  options.onSlice?.(1, result.total, result.occurrences)
  return { matches: result.total, occurrences: result.occurrences, completed: true }
}
