/**
 * CSV whole-file search: one explicit run at a time, started where the reader is, with
 * occurrences published as they are found and a stop that keeps what it already found.
 *
 * Typing only searches the rows already in memory (that is the caller's own search); this
 * hook owns the expensive run and the navigation that takes over once it has occurrences.
 * The first page is kept for navigation; later pages are loaded from cursors captured by
 * the scan, so the 5,000 cap is a page size rather than a navigable limit.
 */
import { useEffect, useReducer, useRef, useState } from 'react'
import type { SearchOccurrence } from '../../kernel/search.ts'
import { NO_OCCURRENCES, scanState as scanReducer } from './state.ts'
import type { ScanState } from './state.ts'

/** Occurrences kept per navigation page; the total count stays whole. */
const SCAN_PAGE_SIZE = 5_000

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
  const [index, setIndex] = useState(0)
  const [pageIndex, setPageIndex] = useState(0)
  const [pageOccurrences, setPageOccurrences] = useState<readonly SearchOccurrence[] | undefined>(undefined)
  const [loadingPage, setLoadingPage] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const pageAbortRef = useRef<AbortController | null>(null)
  const pageCache = useRef(new Map<number, readonly SearchOccurrence[]>())
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
    pageAbortRef.current?.abort()
    pageAbortRef.current = null
    pageCache.current.clear()
    patternRef.current = pattern
    setPageIndex(0)
    setPageOccurrences(undefined)
    setLoadingPage(false)
    setIndex(0)
    dispatchScan({ type: 'start', query: request.query })
    const report = (progress: number, matches: number, occurrences: readonly SearchOccurrence[]): void => {
      dispatchScan({ type: 'slice', progress, matches, occurrences })
    }
    void runner(pattern, {
      signal: controller.signal,
      // File order: line 1 is body row 0; the header is skipped by the scanner.
      from: 1,
      lineLimit: SCAN_PAGE_SIZE,
      onSlice: report,
    }).then((result) => {
      if (controller.signal.aborted) return
      pageCache.current.set(0, result.occurrences)
      setPageIndex(0)
      setPageOccurrences(result.occurrences)
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
      pageAbortRef.current?.abort()
      pageAbortRef.current = null
      pageCache.current.clear()
      setPageIndex(0)
      setPageOccurrences(undefined)
      setLoadingPage(false)
      dispatchScan({ type: 'clear' })
    }
  }, [query, request])

  const occurrences = pageOccurrences ?? (state === undefined ? NO_OCCURRENCES : state.occurrences)
  const navigating = occurrences.length > 0
  const activeIndex = navigating ? Math.min(index, occurrences.length - 1) : fallback.index
  const activeOccurrence = navigating ? occurrences[activeIndex] : fallback.activeOccurrence
  const activeRow = activeOccurrence?.row ?? fallback.activeRow
  const canPage = loadPage !== undefined && state?.done === true && state.aborted !== true && state.pages.length > 0
  const pageCount = canPage ? Math.ceil(state.matches / SCAN_PAGE_SIZE) : 1

  const resetPages = (): void => {
    pageAbortRef.current?.abort()
    pageAbortRef.current = null
    pageCache.current.clear()
    setPageIndex(0)
    setPageOccurrences(undefined)
    setLoadingPage(false)
  }

  const load = (page: number, position: 'first' | 'last'): void => {
    if (!navigating || page < 0 || page >= pageCount || page === pageIndex) return
    const cached = pageCache.current.get(page)
    if (cached !== undefined) {
      setPageIndex(page)
      setPageOccurrences(cached)
      setIndex(position === 'last' ? Math.max(0, cached.length - 1) : 0)
      return
    }
    const loader = loaderRef.current
    const pattern = patternRef.current
    const cursor = state?.pages[page - 1]
    if (loader === undefined || pattern === undefined || cursor === undefined) return
    pageAbortRef.current?.abort()
    const controller = new AbortController()
    pageAbortRef.current = controller
    setLoadingPage(true)
    void loader(pattern, cursor, controller.signal, SCAN_PAGE_SIZE).then((next) => {
      if (controller.signal.aborted) return
      pageCache.current.set(page, next)
      // Keep the current page and its neighbours; a long walk must not grow without bound.
      if (pageCache.current.size > 6) {
        for (const key of pageCache.current.keys()) {
          if (key !== page) pageCache.current.delete(key)
        }
        pageCache.current.set(0, state?.occurrences ?? [])
        pageCache.current.set(page, next)
      }
      setPageIndex(page)
      setPageOccurrences(next)
      setIndex(position === 'last' ? Math.max(0, next.length - 1) : 0)
    }).catch(() => { /* stopped, or the file went away */ })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingPage(false)
      })
  }

  const start = (): void => {
    const text = query.trim()
    if (text === '') return
    resetPages()
    dispatchScan({ type: 'clear' })
    // A fresh request object, so asking again with the same query restarts the scan.
    setRequest({ query: text })
  }
  const stop = (): void => {
    abortRef.current?.abort()
    pageAbortRef.current?.abort()
    pageAbortRef.current = null
    setLoadingPage(false)
    dispatchScan({ type: 'stop' })
  }
  const next = (): void => {
    if (!navigating) {
      fallback.next()
      return
    }
    if (activeIndex + 1 < occurrences.length) setIndex(activeIndex + 1)
    else if (pageIndex + 1 < pageCount) load(pageIndex + 1, 'first')
    else if (pageCount > 1) load(0, 'first')
    else setIndex(0)
  }
  const prev = (): void => {
    if (!navigating) {
      fallback.prev()
      return
    }
    if (activeIndex > 0) setIndex(activeIndex - 1)
    else if (pageIndex > 0) load(pageIndex - 1, 'last')
    else if (pageCount > 1) load(pageCount - 1, 'last')
    else setIndex(Math.max(0, occurrences.length - 1))
  }
  const commit = (): void => {
    if (navigating) next()
    else start()
  }

  return {
    state,
    activeOccurrence,
    activeRow,
    index: navigating ? pageIndex * SCAN_PAGE_SIZE + activeIndex : fallback.index,
    count: navigating ? (state?.matches ?? occurrences.length) : fallback.count,
    loadingPage,
    next,
    prev,
    start,
    stop,
    commit,
  }
}
