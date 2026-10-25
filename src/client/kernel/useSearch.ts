/** Match navigation state on top of a compiled query. */
import { useMemo, useState } from 'react'
import { compileSearch, matchingIndices } from './search.ts'
import type { SearchOptions } from './search.ts'

/** What a body renders from one search field. */
export interface SearchState {
  /** Compiled query; undefined for an empty or invalid pattern. */
  readonly pattern: RegExp | undefined
  /** Row indices that match, in order. */
  readonly matches: readonly number[]
  /** Position within {@link matches}; -1 when nothing matches. */
  readonly index: number
  /** Row index the navigation points at. */
  readonly activeRow: number | undefined
  /** Move to the next match, wrapping. */
  readonly next: () => void
  /** Move to the previous match, wrapping. */
  readonly prev: () => void
}

/**
 * Search one row model.
 * @param texts - searchable text per row; identity or length changes re-run the scan.
 * @param options - query, regex mode, case sensitivity.
 * @returns the pattern, matches and navigation callbacks.
 */
export function useSearch(texts: readonly string[], options: SearchOptions): SearchState {
  const pattern = useMemo(
    () => compileSearch(options),
    [options.query, options.regex, options.caseSensitive],
  )
  const matches = useMemo(
    () => (pattern === undefined ? [] : matchingIndices(texts, pattern)),
    [texts, texts.length, pattern],
  )
  const [active, setActive] = useState(0)
  const count = matches.length
  const index = count === 0 ? -1 : Math.min(active, count - 1)
  return {
    pattern,
    matches,
    index,
    activeRow: index < 0 ? undefined : matches[index],
    next: (): void => {
      if (count > 0) setActive((index + 1) % count)
    },
    prev: (): void => {
      if (count > 0) setActive((index - 1 + count) % count)
    },
  }
}
