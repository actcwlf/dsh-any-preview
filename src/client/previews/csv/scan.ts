/**
 * CSV whole-file search: one explicit run at a time, started where the reader is, with
 * occurrences published as they are found and a stop that keeps what it already found.
 *
 * Typing only searches the rows already in memory (that is the caller's own search); this
 * hook owns the expensive run and the navigation that takes over once it has occurrences.
 * Page navigation itself is shared with log/JSONL through {@link usePagedResults}.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { SEARCH_PAGE_SIZE } from '../../kernel/search.ts'
import type { SearchOccurrence } from '../../kernel/search.ts'
import { usePagedResults } from '../../kernel/usePagedResults.ts'
import { NO_OCCURRENCES, scanState as scanReducer } from './state.ts'
import type { ScanState } from './state.ts'

/** One request for a whole-file search: what to look for. */
export interface ScanRequest {
  readonly query: string
}

/** Runs one scan; a file source or the delivered text, whichever the caller has. */
export type ScanRunner = (
  pattern: RegExp,
  options: {
    readonly signal: AbortSignal
    readonly from: number
    readonly lineLimit: number
    readonly onSlice: (progress: number, matches: number, occurrences: readonly SearchOccurrence[]) => void
  },
) => Promise<{
  readonly matches: number
  readonly occurrences: readonly SearchOccurrence[]
  readonly pages: readonly SearchOccurrence[]
}>

/** Loads one page at or after a cursor. */
export type PageRunner = (
  pattern: RegExp,
  cursor: SearchOccurrence,
  signal: AbortSignal,
  limit: number,
) => Promise<readonly SearchOccurrence[]>

/** What the arrows walk: scanned occurrences, or in-memory occurrences until there are any. */
export interface ScanNavigation {
  readonly activeOccurrence: SearchOccurrence | undefined
  readonly activeRow: number | undefined
  readonly index: number
  readonly count: number
  readonly next: () => void
  readonly prev: () => void
}

/** The scan plus the navigation it drives. */
export interface WholeFileScan extends ScanNavigation {
  readonly state: ScanState | undefined
  /** True while a later page is being read. */
  readonly loadingPage: boolean
  /** True when the last page read failed. */
  readonly pageError: boolean
  /** Zero-based current page and page count. */
  readonly page: number
  readonly pageCount: number
  /** Jump to a zero-based result page. */
  readonly goToPage: (page: number) => void
  /** Start a run from where the reader is (Enter, or the toolbar button). */
  readonly start: () => void
  /** Stop the run; the occurrences already on screen stay usable. */
  readonly stop: () => void
  /** Enter: start the scan, or walk the occurrences once there are any. */
  readonly commit: () => void
}

/** What the scan hook needs from the preview. */
export interface WholeFileScanOptions {
  /** Absent when the file is small enough to search from the rows in memory. */
  readonly scan: ScanRunner | undefined
  /** Loads the next page at a cursor; absent when only the first page is available. */
  readonly loadPage?: PageRunner
  readonly query: string
  readonly regex: boolean
  readonly caseSensitive: boolean
  /** Bumps when the text behind the scan changes; restarts a run. */
  readonly revision: number
  /** 'file' or 'text': a change of source restarts the run on the new one. */
  readonly sourceKey: string
  /** Occurrences for the rows already in memory, used until the scan finds any. */
  readonly fallback: ScanNavigation
}

/** Compile the current query once for the scan and its page loads. */
function compile(query: string, regex: boolean, caseSensitive: boolean): RegExp | undefined {
  const flags = caseSensitive ? 'gu' : 'giu'
  try {
    return regex
      ? new RegExp(query, flags)
      : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), flags)
  } catch {
    return undefined
  }
}

/**
 * Own the whole-file search for one CSV.
 * @param options - the runner, the query and how to fall back to in-memory occurrences.
 * @returns the scan state, its navigation, and the three triggers.
 */
export function useWholeFileScan(options: WholeFileScanOptions): WholeFileScan {
  const { scan, loadPage, query, regex, caseSensitive, revision, sourceKey, fallback } = options
  const [request, setRequest] = useState<ScanRequest | undefined>(undefined)
  const [state, dispatchScan] = useReducer(scanReducer, undefined)
  const abortRef = useRef<AbortController | null>(null)
  const patternRef = useRef<RegExp | undefined>(undefined)
  const runnerRef = useRef(scan)
  const loaderRef = useRef(loadPage)
  runnerRef.current = scan
  loaderRef.current = loadPage

  useEffect(() => {
    const runner = runnerRef.current
    if (request === undefined || runner === undefined) {
      dispatchScan({ type: 'clear' })
      return undefined
    }
    const pattern = compile(request.query, regex, caseSensitive)
    if (pattern === undefined) {
      dispatchScan({ type: 'clear' })
      return undefined
    }
    const controller = new AbortController()
    abortRef.current = controller
    patternRef.current = pattern
    dispatchScan({ type: 'start', query: request.query })
    const report = (progress: number, matches: number, occurrences: readonly SearchOccurrence[]): void => {
      dispatchScan({ type: 'slice', progress, matches, occurrences })
    }
    void runner(pattern, {
      signal: controller.signal,
      // File order: line 1 is body row 0; the header is skipped by the scanner.
      from: 1,
      lineLimit: SEARCH_PAGE_SIZE,
      onSlice: report,
    }).then((result) => {
      if (controller.signal.aborted) return
      dispatchScan({
        type: 'done',
        matches: result.matches,
        occurrences: result.occurrences,
        pages: result.pages,
      })
    }).catch(() => { /* stopped, or the file went away */ })
    return () => { controller.abort() }
  }, [request, regex, caseSensitive, revision, sourceKey])

  // Editing the query drops hits that belong to the old one.
  useEffect(() => {
    if (request === undefined) return
    if (request.query !== query.trim()) {
      setRequest(undefined)
      dispatchScan({ type: 'clear' })
    }
  }, [query, request])

  const pageLoader = useCallback((cursor: SearchOccurrence, signal: AbortSignal, limit: number) => {
    const loader = loaderRef.current
    const pattern = patternRef.current
    if (loader === undefined || pattern === undefined) return Promise.resolve<readonly SearchOccurrence[]>([])
    return loader(pattern, cursor, signal, limit)
  }, [])
  const pager = usePagedResults<SearchOccurrence, SearchOccurrence>({
    total: state?.matches ?? 0,
    pageSize: SEARCH_PAGE_SIZE,
    pageStarts: state?.pages ?? [],
    initial: state?.occurrences ?? NO_OCCURRENCES,
    resetKey: `${sourceKey}:${String(revision)}:${state?.query ?? ''}`,
    enabled: state !== undefined,
    loadPage: pageLoader,
  })

  const occurrences = pager.items
  const navigating = occurrences.length > 0
  const activeOccurrence = navigating ? pager.active : fallback.activeOccurrence
  const activeRow = activeOccurrence?.row ?? fallback.activeRow

  const start = (): void => {
    const text = query.trim()
    if (text === '') return
    pager.cancel()
    dispatchScan({ type: 'clear' })
    // A fresh request object, so asking again with the same query restarts the scan.
    setRequest({ query: text })
  }
  const stop = (): void => {
    abortRef.current?.abort()
    pager.cancel()
    dispatchScan({ type: 'stop' })
  }
  const next = (): void => {
    if (navigating) pager.next()
    else fallback.next()
  }
  const prev = (): void => {
    if (navigating) pager.prev()
    else fallback.prev()
  }
  const commit = (): void => {
    if (navigating) next()
    else start()
  }

  return {
    state,
    activeOccurrence,
    activeRow,
    index: navigating ? pager.index : fallback.index,
    count: navigating ? (state?.matches ?? occurrences.length) : fallback.count,
    loadingPage: pager.loading,
    pageError: pager.error,
    page: pager.page,
    pageCount: pager.pageCount,
    goToPage: pager.goToPage,
    next,
    prev,
    start,
    stop,
    commit,
  }
}
